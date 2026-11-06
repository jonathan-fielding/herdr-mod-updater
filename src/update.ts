/** `hmod update`: replaces a mod's files with a newer version, without ever leaving it half done. */
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { run, updateClone, UpdateRefused } from "./adapters.ts";
import { checkMods, firstUpdateNote, forgetCheck, repin, saveHold, verifySource, type CheckEntry } from "./check.ts";
import { HmodError } from "./errors.ts";
import { diffTrees, hashTree, isIgnored, withLock } from "./fsutil.ts";
import { createGitHub, GitHubError, type GitHub, type TreeEntry } from "./github.ts";
import { linkRefusal, localStatus, scanMods, type InventoryItem } from "./inventory.ts";
import type { ConfirmResult, LinkLogEntry, ModEntry, ModStatus, SourceRecord } from "./model.ts";
import { hmodHome } from "./paths.ts";
import { loadSources, logLink, sourceRef, trustWarning, updateSources } from "./store.ts";

/** Answers whether Herdr can load the mod in `dir`. `output` says why not. */
export type ModCheck = (dir: string) => Promise<{ ok: boolean; output: string }>;

export type UpdateStep = "downloading" | "checking" | "backing_up" | "installing" | "verifying" | "pulling";

export type UpdateOutcome =
  | "updated"
  /** Nothing newer exists. Nothing changed. */
  | "up_to_date"
  /** hmod wouldn't try: `error` says why. Nothing changed. */
  | "refused"
  /** It went wrong: `error` says how, and whether anything changed. */
  | "failed"
  /** The new version went in and failed, and the old one is back. */
  | "rolled_back";

/** `hmod update <mod> --json`, and each mod's part of `--all`. */
export interface UpdateResult {
  /** True for updated and up_to_date. */
  ok: boolean;
  mod: string;
  outcome: UpdateOutcome;
  /** Set exactly when ok is false. */
  error: string | null;
  from_commit: string | null;
  to_commit: string | null;
  from_version: string | null;
  to_version: string | null;
  /** The copy made before installing. Null if none was made, or once a rollback has used it up. */
  backup: string | null;
  added: string[];
  changed: string[];
  removed: string[];
  /** Local edits that --force replaced (the backup still has them). */
  overwritten: string[];
  /** Whether the repo's root keys.json changed. hmod never merges it. null: couldn't tell. */
  keys_changed: boolean | null;
  /** What the new version does that the old one didn't: any of exec, hc, fetch, watchFolder. */
  new_permissions: string[];
  /** Things to tell the person, already worded. */
  notes: string[];
}

export interface SkippedMod {
  mod: string;
  status: ModStatus;
  reason: string;
}

/** `hmod update --all --json` prints one of these per line. */
export type UpdateEvent =
  /** First: what's about to happen. */
  | { event: "plan"; mods: string[]; skipped: SkippedMod[] }
  | { event: "step"; mod: string; step: UpdateStep }
  | { event: "result"; mod: string; result: UpdateResult }
  /** Last. If --all can't start at all, there's one ErrorResult line instead of any of these. */
  | { event: "done"; ok: boolean; updated: string[]; unchanged: string[]; failed: string[]; skipped: SkippedMod[] };

export interface UpdateDeps {
  gh?: GitHub;
  check?: ModCheck;
}

const CHECK_TIMEOUT_MS = 60_000;
const KEEP_BACKUPS = 3;
/** How long to wait for another update before saying so. The person just pressed a button. */
const LOCK_WAIT_MS = 1_500;
/** Well past any real run: a holder that has died is noticed by its pid, long before this. */
const LOCK_STALE_MS = 2 * 60 * 60_000;
const MODE_SYMLINK = "120000";
const MODE_EXECUTABLE = "100755";
/** Herdr reloads on each save and main.js imports the rest, so it has to go in last. */
const ENTRY = "main.js";
const CODE = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
const OUTPUT_LIMIT = 2_000;

const home = {
  lock: () => join(hmodHome(), ".update-lock"),
  staging: () => join(hmodHome(), "staging"),
  backups: () => join(hmodHome(), "backups"),
};

/** Runs `herdr-app check`. $HMOD_HERDR_APP names another program, for tests and unusual installs. */
export const herdrCheck: ModCheck = async (dir) => {
  const { ok, output } = await run([process.env.HMOD_HERDR_APP || "herdr-app", "check", dir], { timeoutMs: CHECK_TIMEOUT_MS });
  return { ok, output };
};

/** How each permission shows up in a mod's source. A mention counts: it's better to say too much. */
const PERMISSIONS: [string, string, RegExp][] = [
  ["exec", "runs programs (exec)", /(?<![.\w$])exec\s*\(|import\s*\{[^}]*\bexec\b/],
  ["hc", "runs herdr-core commands (hc)", /(?<![.\w$])hc\s*\(|import\s*\{[^}]*\bhc\b/],
  ["fetch", "reaches the network (fetch)", /(?<![\w$])fetch\s*\(/],
  ["watchFolder", "watches folders, which can be outside its own (watchFolder)", /\bwatchFolder\b/],
];

/** The permissions a mod's source mentions. It reads text, so it can be fooled: it's a heads-up, not a guard. */
export function permissionsIn(dir: string): string[] {
  const source = Object.keys(hashTree(dir))
    .filter((rel) => CODE.test(rel) && lstatSync(join(dir, rel)).isFile())
    .map((rel) => readFileSync(join(dir, rel), "utf8"))
    .join("\n");
  return PERMISSIONS.filter(([, , pattern]) => pattern.test(source)).map(([name]) => name);
}

function permissionNotes(added: string[]): string[] {
  const said = PERMISSIONS.filter(([name]) => added.includes(name)).map(([, words]) => words);
  return said.length ? [`The new version adds what the old one didn't have: it ${said.join(", ")}.`] : [];
}

function version(dir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, "mod.json"), "utf8"));
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function trimmed(output: string): string {
  return output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}...` : output;
}

function safePath(rel: string): boolean {
  return (
    !rel.startsWith("/") &&
    !/[\\\0]/.test(rel) &&
    rel.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/**
 * What to install from a folder's git tree: relpath -> entry. Refuses the whole mod if anything in
 * it, installed or not, isn't plain files inside the folder.
 */
export function installable(entries: TreeEntry[]): Map<string, TreeEntry> {
  const files = new Map<string, TreeEntry>();
  for (const entry of entries) {
    if (!safePath(entry.path)) throw new UpdateRefused(`refusing it: "${entry.path}" points outside the mod's folder`);
    if (entry.type === "commit") throw new UpdateRefused(`refusing it: ${entry.path} is a git submodule`);
    if (entry.mode === MODE_SYMLINK) throw new UpdateRefused(`refusing it: ${entry.path} is a symlink`);
    if (entry.type === "tree") continue;
    if (entry.type !== "blob") throw new UpdateRefused(`refusing it: ${entry.path} is a ${entry.type}`);
    if (!isIgnored(entry.path)) files.set(entry.path, entry);
  }
  return files;
}

const statOf = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (e: any) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
};

/** Every file under `dir`, hidden ones too. Doesn't follow links. */
const filesUnder = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((rel) => !lstatSync(join(dir, rel)).isDirectory());

/** The folders a relative path goes through, outermost first. */
function parents(rel: string): string[] {
  const parts = rel.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Refuses, before anything changes, a folder that would send a write somewhere else (a symlink on
 * the way) or lose a file (one in the way that isn't due to go). Finishes the check `place` relies on.
 */
function assertRoom(dir: string, incoming: string[], removed: Set<string>): void {
  if (statOf(dir)?.isSymbolicLink()) throw new UpdateRefused(`${dir} is a symlink: update what it points to yourself`);
  for (const rel of [...incoming, ...removed]) {
    for (const parent of parents(rel)) {
      const stat = statOf(join(dir, parent));
      if (!stat) break;
      if (stat.isSymbolicLink()) throw new UpdateRefused(`${parent} in ${dir} is a symlink, and ${rel} would go through it`);
      if (!stat.isDirectory() && !removed.has(parent)) throw new UpdateRefused(`${parent} in ${dir} is a file, but the new version has a folder there`);
    }
  }
  for (const rel of incoming) {
    if (!statOf(join(dir, rel))?.isDirectory()) continue;
    const staying = filesUnder(join(dir, rel)).find((file) => !removed.has(`${rel}/${file}`));
    if (staying) throw new UpdateRefused(`${rel} in ${dir} is a folder holding ${staying}, but the new version has a file there`);
  }
}

/** Puts one file in place in a single step, so Herdr never loads half of it. */
function place(from: string, dir: string, rel: string): void {
  const dest = join(dir, rel);
  for (const parent of parents(rel)) {
    const stat = statOf(join(dir, parent));
    if (stat && !stat.isDirectory()) rmSync(join(dir, parent));
  }
  if (statOf(dest)?.isDirectory()) rmSync(dest, { recursive: true });
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.hmod-${randomBytes(6).toString("hex")}`); // Hidden: Herdr ignores it.
  const source = join(from, rel);
  try {
    if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), tmp);
    else copyFileSync(source, tmp);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function removeFile(dir: string, rel: string): void {
  const stat = statOf(join(dir, rel));
  if (!stat || stat.isDirectory()) return; // Already gone, or a new folder took its name.
  rmSync(join(dir, rel));
  for (const parent of parents(rel).reverse()) {
    try {
      rmdirSync(join(dir, parent));
    } catch {
      return; // Something else is in it.
    }
  }
}

/** A rename that only changes case leaves one file on most Macs: removing the old name would lose it. */
function sameFile(dir: string, a: string, b: string): boolean {
  try {
    return statSync(join(dir, a)).ino === statSync(join(dir, b)).ino;
  } catch {
    return false;
  }
}

/** Copies `files` from `from` into `dir` with main.js last, then removes `removed`. */
export function apply(from: string, dir: string, files: string[], removed: string[]): void {
  for (const rel of files) if (rel !== ENTRY) place(from, dir, rel);
  if (files.includes(ENTRY)) place(from, dir, ENTRY);
  const written = new Map(files.map((rel) => [rel.toLowerCase(), rel]));
  for (const rel of removed) {
    const renamed = written.get(rel.toLowerCase());
    if (!renamed || !sameFile(dir, rel, renamed)) removeFile(dir, rel);
  }
}

/** Puts the backup's version of every file back. Injected and hidden files were never touched. */
function restore(backup: string, dir: string): void {
  const saved = hashTree(backup);
  const now = hashTree(dir);
  const files = Object.keys(saved).filter((rel) => saved[rel] !== now[rel]);
  apply(backup, dir, files, Object.keys(now).filter((rel) => !Object.hasOwn(saved, rel)));
  const left = diffTrees(saved, hashTree(dir));
  if (left.length) throw new HmodError(`these still differ: ${left.join(", ")}`);
}

const BACKUP_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

async function backUp(name: string, dir: string): Promise<string> {
  mkdirSync(home.backups(), { recursive: true });
  const stamp = () => join(home.backups(), `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  let path = stamp();
  while (existsSync(path)) {
    await Bun.sleep(1);
    path = stamp();
  }
  try {
    cpSync(dir, path, { recursive: true, verbatimSymlinks: true });
    if (diffTrees(hashTree(dir), hashTree(path)).length) throw new HmodError("the copy doesn't match the mod");
  } catch (e: any) {
    rmSync(path, { recursive: true, force: true });
    throw new HmodError(`can't back ${name} up to ${path}: ${e?.message ?? e}`);
  }
  return path;
}

/** Goes by the time, not just the name: "foo-" also starts the backups of a mod called foo-bar. */
function pruneBackups(name: string): void {
  const prefix = `${name}-`;
  const mine = readdirSync(home.backups())
    .filter((f) => f.startsWith(prefix) && BACKUP_TIME.test(f.slice(prefix.length)))
    .sort();
  for (const old of mine.slice(0, -KEEP_BACKUPS)) rmSync(join(home.backups(), old), { recursive: true, force: true });
}

/** Whether the repo's root keys.json differs between two commits, and what to say about it. */
async function keysChange(gh: GitHub, record: SourceRecord, target: string): Promise<{ changed: boolean | null; notes: string[] }> {
  const manual = `hmod never merges it: add any keys you want to your own keys.json.`;
  try {
    const now = await gh.rootFile(record.repo, "keys.json", target);
    const { commit } = record;
    if (record.baseline_assumed || commit === null) {
      return now ? { changed: null, notes: [`${record.repo} has a keys.json that hmod can't compare with what you installed. ${manual}`] } : { changed: false, notes: [] };
    }
    const changed = now !== (await gh.rootFile(record.repo, "keys.json", commit));
    return { changed, notes: changed ? [`${record.repo}'s keys.json changed. ${manual}`] : [] };
  } catch (e: any) {
    return { changed: null, notes: [`Couldn't tell whether ${record.repo}'s keys.json changed: ${e?.message ?? e}`] };
  }
}

/** Downloads the listed files into a new folder, which has the mod's own name as Herdr would see it. */
async function stage(gh: GitHub, repo: string, name: string, files: Map<string, TreeEntry>): Promise<string> {
  const dir = join(home.staging(), randomBytes(6).toString("hex"), name);
  mkdirSync(dir, { recursive: true });
  const writes = [...files].map(async ([rel, entry]) => {
    const bytes = await gh.blob(repo, entry.sha);
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes, { mode: entry.mode === MODE_EXECUTABLE ? 0o755 : 0o644 });
  });
  const failed = (await Promise.allSettled(writes)).find((w) => w.status === "rejected");
  if (failed) throw failed.reason;
  return dir;
}

function blank(mod: string): UpdateResult {
  return {
    ok: true,
    mod,
    outcome: "up_to_date",
    error: null,
    from_commit: null,
    to_commit: null,
    from_version: null,
    to_version: null,
    backup: null,
    added: [],
    changed: [],
    removed: [],
    overwritten: [],
    keys_changed: false,
    new_permissions: [],
    notes: [],
  };
}

type Step = (step: UpdateStep) => void;

async function updateLinked(
  item: InventoryItem,
  entry: ModEntry,
  record: SourceRecord,
  head: string,
  gh: GitHub,
  check: ModCheck,
  step: Step,
): Promise<UpdateResult> {
  const { name, dir } = item;
  const { repo, path, branch } = record;
  const assumed = record.baseline_assumed === true;
  const result = { ...blank(name), from_commit: assumed ? null : record.commit, from_version: version(dir) };

  step("downloading");
  const gone = () => new GitHubError(`${path} isn't in ${repo}${branch ? ` on ${branch}` : ""} any more`);
  const entries = await gh.folderEntries(repo, path, head);
  if (!entries) throw gone();
  const incoming = installable(entries);
  const files: Record<string, string> = Object.create(null);
  for (const [rel, file] of incoming) files[rel] = file.sha;
  result.to_commit = head;
  const replacingEdits = assumed && entry.status === "modified"; // HEAD equals the stand-in, not what's installed.
  if (!replacingEdits && diffTrees(record.files, files).length === 0) return { ...result, to_version: result.from_version };

  const removed = Object.keys(record.files).filter((rel) => !Object.hasOwn(files, rel));
  const unsafe = removed.find((rel) => !safePath(rel));
  if (unsafe) throw new UpdateRefused(`sources.json lists "${unsafe}", which is outside the mod's folder`);
  const present = hashTree(dir);
  const writing = Object.keys(files).filter((rel) => present[rel] !== files[rel]);
  assertRoom(dir, writing, new Set(removed));

  const staged = await stage(gh, repo, name, incoming);
  result.to_version = version(staged);
  const keys = await keysChange(gh, record, head);
  result.keys_changed = keys.changed;
  const before = permissionsIn(dir);
  result.new_permissions = permissionsIn(staged).filter((p) => !before.includes(p));
  result.notes = [...keys.notes, ...permissionNotes(result.new_permissions)];

  step("checking");
  const first = await check(staged);
  if (!first.ok) throw new HmodError(`the new version failed herdr-app check, so nothing changed: ${trimmed(first.output)}`);

  step("backing_up");
  const backup = await backUp(name, dir);
  result.backup = backup;
  result.added = writing.filter((rel) => !Object.hasOwn(record.files, rel));
  result.changed = writing.filter((rel) => Object.hasOwn(record.files, rel));
  result.removed = removed;
  result.overwritten = entry.changed.filter((rel) => Object.hasOwn(files, rel) || Object.hasOwn(record.files, rel));

  try {
    step("installing");
    apply(staged, dir, writing, removed);
    step("verifying");
    const installed = hashTree(dir);
    const wrong = Object.keys(files).filter((rel) => installed[rel] !== files[rel]);
    if (wrong.length) throw new HmodError(`these didn't install: ${wrong.join(", ")}`);
    const second = await check(dir);
    if (!second.ok) throw new HmodError(`it failed herdr-app check once installed: ${trimmed(second.output)}`);
    await updateSources((sources) => {
      const latest = sources[name];
      if (!latest) return; // Unlinked meanwhile: that stands.
      latest.commit = head;
      latest.files = files;
      delete latest.baseline_assumed;
      delete latest.first_update_pending; // The person has now taken this repo's code once.
    });
  } catch (e: any) {
    const why = e?.message ?? String(e);
    try {
      restore(backup, dir);
    } catch (again: any) {
      const error = `${why}. Restoring failed too (${again?.message ?? again}): the previous version is in ${backup}`;
      return { ...result, ok: false, outcome: "failed", error };
    }
    rmSync(backup, { recursive: true, force: true }); // It's what's installed now, and it shouldn't crowd out older ones.
    return { ...result, ok: false, outcome: "rolled_back", backup: null, error: `${why}. The previous version is back in place` };
  }

  try {
    pruneBackups(name);
  } catch (e: any) {
    result.notes.push(`Couldn't clear old backups: ${e?.message ?? e}`);
  }
  return { ...result, outcome: "updated" };
}

async function updateAdapted(item: InventoryItem, entry: ModEntry, step: Step): Promise<UpdateResult> {
  const before = permissionsIn(item.dir);
  const from_version = version(item.dir);
  const done = await updateClone(item, entry.adapter_source!, entry.status === "update_available", step);
  const new_permissions = permissionsIn(item.dir).filter((p) => !before.includes(p));
  return {
    ...blank(item.name),
    outcome: done.installed ? "updated" : "up_to_date",
    from_commit: done.from_commit,
    to_commit: done.to_commit,
    from_version,
    to_version: version(item.dir),
    keys_changed: null,
    new_permissions,
    notes: permissionNotes(new_permissions),
  };
}

function refusal(item: InventoryItem, entry: ModEntry, force: boolean): string | null {
  if (item.kind === "herdr" || item.cloned_from) return linkRefusal(item);
  if (entry.status === "error") return entry.message;
  if (entry.status === "unlinked") return `no source known for ${item.name}: \`hmod check\` looks for one, or use \`hmod link\``;
  if (entry.status === "modified" && !force) {
    return `${item.name} has local edits (${entry.changed.join(", ")}): --force replaces them, after a backup`;
  }
  return null;
}

/** Updates one mod and says how it went. Whatever goes wrong comes back as a result, not a throw. */
async function updateItem(item: InventoryItem, force: boolean, gh: GitHub, check: ModCheck, step: Step, batch = false): Promise<UpdateResult> {
  const staging = home.staging();
  const failure = (outcome: UpdateOutcome, error: string): UpdateResult => ({ ...blank(item.name), ok: false, outcome, error });
  try {
    let sources = loadSources();
    const record = sources[item.name];
    // Checked here too: a link made while Update all runs isn't in what it planned.
    if (batch && record?.first_update_pending) return failure("refused", firstUpdateNote(record.repo));
    let head: string | null = null;
    let renamed: string[] = [];
    if (record && !linkRefusal(item) && !item.problem) {
      // Always asked, and before anything else: --force is about local edits, not about this.
      const verified = await verifySource(gh, item.name, item.dir, record).catch((e) => {
        if (record.commit !== null) throw e;
        throw new UpdateRefused(`can't tell which version of ${item.name} is installed, so nothing changed: ${e?.message ?? e}`);
      });
      if (verified.change) {
        saveHold(item.name, verified.record, verified.change);
        return failure("refused", `${item.name}'s source changed, so nothing was installed. ${verified.change.detail} To go on, use Confirm again in Mod updates or \`hmod confirm ${item.name}\`.`);
      }
      head = verified.head;
      if (verified.renamed_from) renamed = [`Renamed on GitHub: ${verified.renamed_from} is ${verified.record.repo} now.`];
      sources = loadSources();
    }
    const entry = localStatus(item, sources);
    const refused = refusal(item, entry, force);
    if (refused) return failure("refused", refused);
    if (item.adapter) return await updateAdapted(item, entry, step);
    const done = await updateLinked(item, entry, sources[item.name]!, head!, gh, check, step);
    return { ...done, notes: [...renamed, ...done.notes] };
  } catch (e: any) {
    return failure(e instanceof UpdateRefused ? "refused" : "failed", e?.message ?? String(e));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** One update at a time, across processes. Whatever an earlier run left in staging goes too. */
async function exclusively<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(hmodHome(), { recursive: true });
  let holding = false;
  try {
    return await withLock(
      home.lock(),
      () => {
        holding = true;
        rmSync(home.staging(), { recursive: true, force: true });
        return fn();
      },
      { timeoutMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS },
    );
  } catch (e) {
    if (holding || !(e instanceof HmodError)) throw e;
    throw new HmodError("another hmod update is running: try again when it finishes");
  }
}

export function updateOne(name: string, force: boolean, deps: UpdateDeps = {}): Promise<UpdateResult> {
  return exclusively(async () => {
    const item = scanMods().find((m) => m.name === name);
    if (!item) throw new HmodError(`no mod called ${name} in the mods folder`);
    return updateItem(item, force, deps.gh ?? createGitHub(), deps.check ?? herdrCheck, () => {});
  });
}

/**
 * What only the person can do for a held mod: trust the repo as it is now. Nothing is written until
 * every answer is in, so a failure leaves the hold in place.
 */
export function confirmOne(name: string, via: LinkLogEntry["via"], deps: Pick<UpdateDeps, "gh"> = {}): Promise<ConfirmResult> {
  return exclusively(async () => {
    const item = scanMods().find((m) => m.name === name);
    if (!item) throw new HmodError(`no mod called ${name} in the mods folder`);
    const refused = linkRefusal(item);
    if (refused) throw new HmodError(`can't confirm: ${refused}`);
    const record = loadSources()[name];
    if (!record) throw new HmodError(`${name} isn't linked`);
    const pinned = await repin(deps.gh ?? createGitHub(), item.dir, record);
    const result = await updateSources((sources): ConfirmResult => {
      const latest = sources[name];
      if (latest?.repo !== record.repo || latest.path !== record.path || latest.branch !== record.branch || latest.commit !== record.commit) {
        throw new HmodError(`${name}'s link changed while confirming: try again`);
      }
      const { repo, path, branch, repo_id, owner_id } = pinned;
      logLink({ event: "confirm", mod: name, repo, path, branch, via, offered_because: null, repo_id, owner_id });
      sources[name] = { ...pinned, first_update_pending: true };
      return { ok: true, mod: name, source: sourceRef(pinned), repo_id: repo_id!, owner_id: owner_id!, counts_as_edited: pinned.baseline_assumed === true, trust: trustWarning(repo) };
    });
    forgetCheck(name);
    return result;
  });
}

const SKIP_REASON: Partial<Record<ModStatus, string>> = {
  modified: "has local edits",
  source_changed: "its source changed",
  unlinked: "no source known",
  error: "its status couldn't be worked out",
};

/** Updates every mod with an update, one at a time, by name. One failing doesn't stop the rest. */
export function updateAll(emit: (event: UpdateEvent) => void, deps: UpdateDeps = {}): Promise<{ ok: boolean }> {
  return exclusively(async () => {
    const gh = deps.gh ?? createGitHub();
    const check = deps.check ?? herdrCheck;
    const { mods } = await checkMods(gh);
    const first = (m: CheckEntry) => m.status === "update_available" && m.first_update_pending;
    const queue = mods.filter((m) => m.status === "update_available" && !first(m)).map((m) => m.name);
    const skipped = mods.flatMap((m): SkippedMod[] => {
      const fallback = first(m) ? "it needs updating by itself the first time" : SKIP_REASON[m.status];
      return fallback ? [{ mod: m.name, status: m.status, reason: m.message ?? m.note ?? fallback }] : [];
    });
    emit({ event: "plan", mods: queue, skipped });

    const items = new Map(scanMods().map((item) => [item.name, item]));
    const summary = { updated: [] as string[], unchanged: [] as string[], failed: [] as string[] };
    for (const mod of queue) {
      const item = items.get(mod);
      const result = item
        ? await updateItem(item, false, gh, check, (step) => emit({ event: "step", mod, step }), true)
        : { ...blank(mod), ok: false, outcome: "failed" as const, error: `${mod} isn't in the mods folder any more` };
      emit({ event: "result", mod, result });
      (result.outcome === "updated" ? summary.updated : result.ok ? summary.unchanged : summary.failed).push(mod);
    }
    const ok = summary.failed.length === 0;
    emit({ event: "done", ok, ...summary, skipped });
    return { ok };
  });
}
