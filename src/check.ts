/** `hmod check`: each mod's status against where it came from, and the saved copy of that answer. */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffTrees, hashTree, atomicWrite } from "./fsutil.ts";
import { createGitHub, GitHubError, MAX_COMMITS, type CommitRef, type GitHub, type RepoIdentity } from "./github.ts";
import { listMods, localStatus, scanMods, type InventoryItem } from "./inventory.ts";
import { findSource, findVersion, type Suggestion } from "./match.ts";
import type { ListResult, ModEntry, OfferGap, SourceChange, SourceChangeKind, SourceRecord, SourceRef, Sources } from "./model.ts";
import { herdrHome, hmodHome } from "./paths.ts";
import { isPinned, loadSources, logLink, updateSources } from "./store.ts";

export type { Suggestion } from "./match.ts";

/** What GitHub has for a linked mod, kept so a later `--cached` can work the status out afresh. */
interface Upstream {
  repo: string;
  path: string;
  branch: string | null;
  /** The newest commit that touched the mod's folder. */
  head: string;
  files: Record<string, string>;
  version: string | null;
  /** Commits between the baseline and head. null: the baseline isn't in the history walked. */
  behind: number | null;
  /** There may be more: the walk ended before finding the baseline. */
  capped: boolean;
  /** The baseline `behind` was worked out for. */
  baseline: string | null;
}

/** What the mod's local clone says. */
interface CloneState {
  root: string;
  origin: string | null;
  branch: string | null;
  /** The ref compared against, like origin/main. */
  upstream: string | null;
  /** Commits origin has and the clone doesn't. null: couldn't tell, and `note` says why. */
  ahead: number | null;
  note: string | null;
}

/** A hold, and the pins it was found against: confirming or relinking moves those, which ends it. */
interface Hold extends SourceChange {
  commit: string | null;
  repo_id?: number;
  owner_id?: number;
}

/** One mod's result in check.json. */
interface Saved {
  checked_at: string;
  /** The last check failed. Whatever else is here came from the last one that didn't. */
  error: string | null;
  upstream: Upstream | null;
  clone: CloneState | null;
  suggestions: Suggestion[];
  /** Why `suggestions` may not be every repo. Missing: saved by a version that didn't look. */
  offer_gaps?: OfferGap[];
  hold?: Hold | null;
  /** This check followed a rename from this name. */
  renamed_from?: string | null;
}

interface CheckFile {
  last_checked: string | null;
  mods: Record<string, Saved>;
}

export interface CheckEntry extends ModEntry {
  /** A newer version exists. Also true on a modified mod, whose status can't say so itself. */
  update_available: boolean;
  /** How far behind the installed version is, in commits touching the mod (clone-installed: all commits). */
  commits_behind: number | null;
  /** commits_behind is a floor: the history walked ended before the installed version. */
  commits_behind_capped: boolean;
  installed_version: string | null;
  latest_version: string | null;
  /** The newest upstream commit touching the mod. */
  latest_commit: string | null;
  /** Possible sources for an unlinked mod, never more than that, forks last. */
  suggestions: Suggestion[];
  /** Why `suggestions` may not be every repo holding the mod. Empty: every candidate was seen. */
  offer_gaps: OfferGap[];
  /** Linked or confirmed, with nothing installed from it yet: Update all leaves it out. */
  first_update_pending: boolean;
  /** When this mod's result came from GitHub or origin; null if it never has. */
  checked_at: string | null;
  /** clone-installed only. */
  clone: { root: string; origin: string | null; branch: string | null } | null;
}

/** `hmod check --json` */
export interface CheckResult {
  ok: true;
  herdr_home: string;
  /** Saved remote results, with no network call: `--cached`. */
  cached: boolean;
  /** Whether GitHub was asked with a token; null when it wasn't asked. */
  authenticated: boolean | null;
  /** When the last check finished; null if there hasn't been one. */
  last_checked: string | null;
  /** When GitHub's limit lifts, if this check hit it; otherwise null. */
  rate_limit_reset: string | null;
  mods: CheckEntry[];
}

const checkFile = () => join(hmodHome(), "check.json");

function loadChecks(): CheckFile {
  try {
    const raw = JSON.parse(readFileSync(checkFile(), "utf8")) as CheckFile;
    if (typeof raw.mods === "object" && raw.mods !== null) return { ...raw, mods: Object.assign(Object.create(null), raw.mods) };
  } catch {}
  return { last_checked: null, mods: Object.create(null) }; // Missing or damaged: nothing's been checked.
}

function saveChecks(file: CheckFile): void {
  mkdirSync(hmodHome(), { recursive: true });
  atomicWrite(checkFile(), `${JSON.stringify(file, null, 2)}\n`);
}

const GIT_TIMEOUT_MS = 60_000;

/** Runs git without ever asking for a password. Returns its output, or null if it failed. */
async function git(root: string, ...args: string[]): Promise<string | null> {
  const p = Bun.spawn(["git", "-C", root, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : null;
}

const aheadOf = async (root: string, upstream: string) => {
  const count = await git(root, "rev-list", "--count", `HEAD..${upstream}`);
  return count === null ? null : Number(count);
};

/** A remote URL can hold a token: it goes into the JSON without one. */
const stripCredentials = (url: string) => url.replace(/\/\/[^/@]*@/, "//");

async function inspectClone(source: string): Promise<CloneState> {
  const root = await git(source, "rev-parse", "--show-toplevel");
  if (!root) {
    return { root: source, origin: null, branch: null, upstream: null, ahead: null, note: `${source} isn't in a git clone` };
  }
  const branch = await git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
  const url = await git(root, "remote", "get-url", "origin");
  const state: CloneState = {
    root,
    origin: url && stripCredentials(url),
    branch,
    upstream: null,
    ahead: null,
    note: null,
  };
  if (url === null) return { ...state, note: "the clone has no origin to check" };
  if ((await git(root, "fetch", "--quiet", "origin")) === null) throw new GitHubError(`git fetch failed in ${root}`);
  if (!branch) return { ...state, note: "the clone isn't on a branch" };
  const tracking = await git(root, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`);
  const upstream = tracking?.startsWith("origin/") ? tracking : `origin/${branch}`;
  const ahead = await aheadOf(root, upstream);
  if (ahead === null) return { ...state, note: `${branch} isn't on origin` };
  return { ...state, upstream, ahead };
}

const gone = ({ repo, path, branch }: SourceRef) => new GitHubError(`${path} isn't in ${repo}${branch ? ` on ${branch}` : ""} any more`);

/**
 * A mod's baseline from what's in the repo now. Local files equal to a version make that version the
 * baseline. Anything else counts as edited, against HEAD, so nothing replaces it unasked. Throws if
 * it can't tell.
 */
async function workOutBaseline(gh: GitHub, dir: string, record: SourceRecord): Promise<SourceRecord> {
  const { repo, path, branch } = record;
  const { baseline_assumed: _, ...rest } = record;
  const commits = await gh.folderCommits(repo, path, branch);
  const head = commits?.[0]?.sha;
  if (!commits || !head) throw gone(record);
  const headFiles = await gh.treeAt(repo, path, head);
  if (!headFiles) throw gone(record);
  const local = hashTree(dir);
  const commit = await findVersion(gh, repo, path, commits, local);
  return commit ? { ...rest, commit, files: local } : { ...rest, commit: head, files: headFiles, baseline_assumed: true };
}

/** Works out a hand-linked mod's baseline and records it. Throws if it can't tell: it stays unknown. */
async function resolveBaseline(gh: GitHub, name: string, dir: string, record: SourceRecord): Promise<SourceRecord> {
  const { repo, path, branch } = record;
  const resolved = await workOutBaseline(gh, dir, record);
  return updateSources((sources) => {
    const latest = sources[name];
    if (latest?.commit !== null || latest.repo !== repo || latest.path !== path || latest.branch !== branch) return latest ?? resolved;
    return (sources[name] = resolved);
  });
}

const short = (commit: string) => commit.slice(0, 7);

function unconfirmed(record: SourceRecord): SourceChange {
  return {
    what: ["unconfirmed"],
    detail: `This link to ${record.repo} needs confirming once: it was made before hmod recorded who owns a repo. Confirm only if you trust ${record.repo}.`,
  };
}

/** How the repo's ids differ from the pinned ones, going by what GitHub returned. */
function identityChange(record: SourceRecord, now: RepoIdentity): SourceChange | null {
  const what: SourceChangeKind[] = [];
  if (now.repo_id !== record.repo_id) what.push("repo_id");
  if (now.owner_id !== record.owner_id) what.push("owner");
  if (!what.length) return null;
  const detail = what.includes("repo_id")
    ? `${record.repo} is a different repo now, owned by ${now.owner}: the name may have been registered again.`
    : `${record.repo} has a new owner: it's ${now.repo} now, owned by ${now.owner}.`;
  return { what, detail, repo_now: now.repo };
}

/** Whether `head` builds on the baseline. Anything else means the history isn't the one the person trusted. */
async function historyChange(gh: GitHub, record: SourceRecord, head: string, defaultBranch: string): Promise<SourceChange | null> {
  const baseline = record.commit!;
  const changed = (detail: string): SourceChange => ({ what: ["history"], detail });
  let comparison = await gh.compare(record.repo, baseline, head);
  // `head` is the newest commit to touch the folder, so a baseline taken from a later commit that
  // didn't is ahead of it. Then the branch itself has to contain the baseline.
  if (comparison === "behind") comparison = await gh.compare(record.repo, baseline, record.branch ?? defaultBranch);
  if (comparison === "ahead" || comparison === "identical") return null;
  if (comparison === null) return changed(`The history of ${record.repo} was replaced: the installed commit ${short(baseline)} is gone from it.`);
  if (comparison === "behind") return changed(`${record.repo} went backwards: its newest commit is older than the installed commit ${short(baseline)}.`);
  return changed(`The history of ${record.repo} was rewritten: its newest commit doesn't follow from the installed commit ${short(baseline)}.`);
}

function followRename(name: string, record: SourceRecord, repo: string): Promise<SourceRecord> {
  return updateSources((sources) => {
    const latest = sources[name];
    if (!latest || latest.repo !== record.repo || latest.repo_id !== record.repo_id) return latest ?? record;
    const { path, branch } = latest;
    logLink({ event: "rename", mod: name, repo, path, branch, via: "hmod", offered_because: null, renamed_from: latest.repo });
    latest.repo = repo;
    return latest;
  });
}

export interface Verified {
  /** The record now: renamed, and with its baseline, if those were needed. */
  record: SourceRecord;
  /** What stopped it. Everything else here means nothing until this is null. */
  change: SourceChange | null;
  /** The newest commit to touch the mod, which `change` being null vouches for. */
  head: string | null;
  renamed_from: string | null;
}

/**
 * Whether a linked mod's source is still the one the person trusted. A check and an update both go
 * through this, so neither relies on the other. Throws when it can't tell, which is an error for
 * that mod and never a hold: only a real answer from GitHub says something changed.
 */
export async function verifySource(gh: GitHub, name: string, dir: string, record: SourceRecord): Promise<Verified> {
  if (!isPinned(record)) return { record, change: unconfirmed(record), head: null, renamed_from: null };
  const now = await gh.repoIdentity(record.repo);
  if (!now) throw gone(record);
  const change = identityChange(record, now);
  if (change) return { record, change, head: null, renamed_from: null };
  const renamed_from = now.repo === record.repo ? null : record.repo;
  const followed = renamed_from ? await followRename(name, record, now.repo) : record;
  const known = followed.commit === null ? await resolveBaseline(gh, name, dir, followed) : followed;
  const head = (await gh.folderCommits(known.repo, known.path, known.branch))?.[0]?.sha;
  if (!head) throw gone(known);
  return { record: known, change: await historyChange(gh, known, head, now.default_branch), head, renamed_from };
}

/**
 * The record with the repo's current ids, for after the person has said to trust it. The baseline
 * stays if the history still leads from it. If not it's worked out again from what the repo holds,
 * so local files only become it by equalling a version, never because they're what's installed.
 */
export async function repin(gh: GitHub, dir: string, record: SourceRecord): Promise<SourceRecord> {
  const now = await gh.repoIdentity(record.repo);
  if (!now) throw gone(record);
  const pinned: SourceRecord = { ...record, repo: now.repo, repo_id: now.repo_id, owner_id: now.owner_id };
  if (pinned.commit !== null) {
    const head = (await gh.folderCommits(pinned.repo, pinned.path, pinned.branch))?.[0]?.sha;
    if (!head) throw gone(pinned);
    if (!(await historyChange(gh, pinned, head, now.default_branch))) return pinned;
  }
  return workOutBaseline(gh, dir, { ...pinned, commit: null, files: {} });
}

/** Which of `commits` the baseline came from, newest first; null if none of them. */
async function baselineIndex(gh: GitHub, record: SourceRecord, commits: CommitRef[], atHead: boolean): Promise<number | null> {
  const known = commits.findIndex((c) => c.sha === record.commit);
  if (known >= 0) return known;
  if (atHead) return 0;
  // Recorded from a commit that didn't touch the folder: go by content.
  for (const [i, { sha }] of commits.entries()) {
    const tree = await gh.treeAt(record.repo, record.path, sha);
    if (tree && diffTrees(tree, record.files).length === 0) return i;
  }
  return null;
}

async function inspectLinked(gh: GitHub, record: SourceRecord): Promise<Upstream> {
  const { repo, path, branch } = record;
  const commits = await gh.folderCommits(repo, path, branch);
  const head = commits?.[0]?.sha;
  if (!commits || !head) throw gone(record);
  const files = await gh.treeAt(repo, path, head);
  if (!files) throw gone(record);
  const atHead = diffTrees(record.files, files).length === 0;
  const index = await baselineIndex(gh, record, commits, atHead);
  const capped = index === null && commits.length >= MAX_COMMITS;
  return {
    repo,
    path,
    branch,
    head,
    files,
    version: await gh.versionAt(repo, path, head),
    behind: capped ? commits.length : index,
    capped,
    baseline: record.commit,
  };
}

/** Asks GitHub or origin about one mod. Null for a mod with nothing to ask about. */
async function inspect(gh: GitHub, item: InventoryItem, sources: Sources, now: string): Promise<Saved | null> {
  const base = { checked_at: now, error: null, upstream: null, clone: null, suggestions: [] };
  if (item.kind === "herdr" || item.cloned_from || item.problem) return null;
  if (item.adapter) {
    const source = localStatus(item, sources).adapter_source;
    return source ? { ...base, clone: await inspectClone(source) } : null;
  }
  const record = sources[item.name];
  if (record) {
    const { record: known, change, renamed_from } = await verifySource(gh, item.name, item.dir, record);
    if (change) return { ...base, renamed_from, hold: holdOn(known, change) };
    return { ...base, renamed_from, upstream: await inspectLinked(gh, known) };
  }
  const { suggestions, gaps } = await findSource(gh, { name: item.name, title: item.title, files: hashTree(item.dir) });
  return { ...base, suggestions, offer_gaps: gaps };
}

function holdOn({ commit, repo_id, owner_id }: SourceRecord, change: SourceChange): Hold {
  return { ...change, commit, repo_id, owner_id };
}

/** What's holding this record, if anything. Needs no network: a link with no ids is held as it stands. */
function heldBy(record: SourceRecord, saved: Saved | undefined): SourceChange | null {
  if (!isPinned(record)) return unconfirmed(record);
  const hold = saved?.hold;
  if (!hold || hold.commit !== record.commit || hold.repo_id !== record.repo_id || hold.owner_id !== record.owner_id) return null;
  return { what: hold.what, detail: hold.detail, repo_now: hold.repo_now };
}

function held<T extends ModEntry>(entry: T, change: SourceChange): T {
  return { ...entry, status: "source_changed", source_changed: change, note: change.detail };
}

/** `hmod list`: local status, plus any hold. That takes no network either. */
export function listWithHolds(): ListResult {
  const list = listMods();
  const sources = loadSources();
  const saved = loadChecks().mods;
  const mods = list.mods.map((m) => {
    const record = sources[m.name];
    const change = m.source && record ? heldBy(record, saved[m.name]) : null;
    return change ? held(m, change) : m;
  });
  return { ...list, mods };
}

/** Saves what an update found, so the mod shows held without waiting for the next check. */
export function saveHold(name: string, record: SourceRecord, change: SourceChange): void {
  const file = loadChecks();
  const before = file.mods[name];
  const base = { checked_at: new Date().toISOString(), error: null, upstream: null, clone: null, suggestions: [] };
  file.mods[name] = { ...base, ...before, error: null, hold: holdOn(record, change) };
  saveChecks(file);
}

/** Forgets what was last learned about a mod: it no longer applies. */
export function forgetCheck(name: string): void {
  const file = loadChecks();
  delete file.mods[name];
  saveChecks(file);
}

/** Why the last check offered this source, for the link log; null if it wasn't offered. */
export function offeredBecause(mod: string, repo: string, path: string): string | null {
  const offers = loadChecks().mods[mod]?.suggestions ?? [];
  return offers.find((s) => s.repo === repo && s.path === path)?.why ?? null;
}

function localVersion(dir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, "mod.json"), "utf8"));
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** Offers saved before hmod said what it hadn't seen can't claim to be everything. */
const OLD_CHECK: OfferGap = { kind: "old_check", detail: "An older hmod made this list and didn't record what it left out. Check for updates to find out." };

/** Why Update all leaves a mod out. */
export function firstUpdateNote(repo: string): string {
  return `First update from ${repo}: update this mod by itself to go ahead. Update all leaves it out until then`;
}

const withNote = (note: string | null, more: string) => (note ? `${note}. ${more}` : more);

function withLinked(entry: CheckEntry, record: SourceRecord, up: Upstream): CheckEntry {
  const same = up.repo === record.repo && up.path === record.path && up.branch === record.branch;
  if (!same) return entry; // Relinked since: this says nothing about the new source.
  // An assumed baseline is only a stand-in, so HEAD equalling it doesn't mean the edits hold HEAD.
  const assumed = record.baseline_assumed === true && entry.status === "modified";
  const update = assumed || diffTrees(record.files, up.files).length > 0;
  const measured = record.commit === up.baseline && !record.baseline_assumed;
  const facts = {
    ...entry,
    remote_checked: true,
    update_available: update,
    commits_behind: !update ? 0 : measured ? up.behind : null,
    commits_behind_capped: update && measured && up.capped,
    latest_version: up.version,
    latest_commit: up.head,
  };
  if (entry.status === "modified") {
    if (assumed) return { ...facts, note: "Matches no version hmod could find, so it counts as edited" };
    return { ...facts, note: update ? "Has local edits, and an update exists" : "Has local edits" };
  }
  return { ...facts, status: update ? "update_available" : "up_to_date" };
}

function withClone(entry: CheckEntry, state: CloneState, update: string): CheckEntry {
  const { root, origin, branch, ahead } = state;
  const facts = { ...entry, clone: { root, origin, branch }, remote_checked: ahead !== null };
  if (ahead) {
    const commits = ahead === 1 ? "1 commit" : `${ahead} commits`;
    return {
      ...facts,
      status: "update_available",
      update_available: true,
      commits_behind: ahead,
      note: `origin is ${commits} ahead: pull ${root}, then run \`${update}\``,
    };
  }
  return { ...facts, commits_behind: ahead, note: entry.note ?? state.note };
}

/** A mod's status from its local files now, plus what was last learned remotely. */
function present(item: InventoryItem, sources: Sources, saved: Saved | undefined): CheckEntry {
  const local = localStatus(item, sources);
  let entry: CheckEntry = {
    ...local,
    update_available: local.status === "update_available",
    commits_behind: null,
    commits_behind_capped: false,
    installed_version: localVersion(item.dir),
    latest_version: null,
    latest_commit: null,
    suggestions: [],
    offer_gaps: [],
    first_update_pending: local.source !== null && sources[item.name]?.first_update_pending === true,
    checked_at: saved?.checked_at ?? null,
    clone: null,
  };
  const record = sources[item.name];
  const change = local.source && record ? heldBy(record, saved) : null;
  if (change) {
    const out = held({ ...entry, remote_checked: Boolean(saved?.hold) }, change);
    return saved?.error ? { ...out, note: `${change.detail} Last check failed: ${saved.error}` } : out;
  }
  if (!saved || local.status === "error" || local.status === "herdr" || item.cloned_from) return entry;

  const unknown = record?.commit === null; // What's saved can't be about a baseline nobody's worked out.
  if (saved.clone && item.adapter) entry = withClone(entry, saved.clone, item.adapter.update);
  else if (saved.upstream && record && !unknown) entry = withLinked(entry, record, saved.upstream);
  else if (!record && !item.adapter) {
    const gaps = saved.offer_gaps ?? (saved.suggestions.length ? [OLD_CHECK] : []);
    entry = { ...entry, remote_checked: !saved.error, suggestions: saved.suggestions, offer_gaps: gaps };
  }
  if (saved.renamed_from && record) {
    entry = { ...entry, note: withNote(entry.note, `Renamed on GitHub: ${saved.renamed_from} is ${record.repo} now`) };
  }
  if (record && entry.first_update_pending && entry.status === "update_available") {
    entry = { ...entry, note: withNote(entry.note, firstUpdateNote(record.repo)) };
  }

  if (!saved.error) return entry;
  const answered = !unknown && (saved.upstream || saved.clone);
  return answered
    ? { ...entry, note: withNote(entry.first_update_pending ? entry.note : null, `Last check failed: ${saved.error}`) }
    : { ...entry, status: "error", message: saved.error, remote_checked: false };
}

/** Asks GitHub and origin about every mod, finds possible sources, and saves the results. Links nothing. */
export async function checkMods(gh: GitHub = createGitHub()): Promise<CheckResult> {
  const items = scanMods();
  const sources = loadSources();
  const previous = loadChecks();
  const now = new Date().toISOString();
  const results = await Promise.all(
    items.map(async (item): Promise<Saved | null> => {
      try {
        return await inspect(gh, item, sources, now);
      } catch (e: any) {
        return { checked_at: now, error: e?.message ?? String(e), upstream: null, clone: null, suggestions: [] };
      }
    }),
  );

  const latest = loadSources(); // Now with the baselines just worked out.
  const file: CheckFile = { last_checked: now, mods: Object.create(null) };
  const mods = items.map((item, i) => {
    const result = results[i];
    const before = previous.mods[item.name];
    const keep = result?.error && before ? { ...before, error: result.error } : result;
    if (keep) file.mods[item.name] = keep;
    // A check that couldn't reach GitHub hasn't cleared a hold it found earlier.
    return present(item, latest, (before?.hold && result?.error ? keep : result) ?? undefined);
  });
  saveChecks(file);
  return {
    ok: true,
    herdr_home: herdrHome(),
    cached: false,
    authenticated: gh.authenticated,
    last_checked: now,
    rate_limit_reset: gh.rateLimitReset?.toISOString() ?? null,
    mods,
  };
}

/**
 * The saved results, without the network. Local files are read afresh, so edits and installs since
 * the last check show up; what GitHub said is as of each mod's `checked_at`.
 */
export async function cachedCheck(): Promise<CheckResult> {
  const items = scanMods();
  const sources = loadSources();
  const { last_checked, mods: saved } = loadChecks();
  const mods = await Promise.all(
    items.map(async (item) => {
      const result = saved[item.name];
      const clone = result?.clone;
      // A pull since the last check is known locally, so it needn't wait for the next one.
      if (clone?.upstream) clone.ahead = (await aheadOf(clone.root, clone.upstream)) ?? clone.ahead;
      return present(item, sources, result);
    }),
  );
  return {
    ok: true,
    herdr_home: herdrHome(),
    cached: true,
    authenticated: null,
    last_checked,
    rate_limit_reset: null,
    mods,
  };
}
