/** `hmod check`: each mod's status against where it came from, and the saved copy of that answer. */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffTrees, hashTree, atomicWrite } from "./fsutil.ts";
import { createGitHub, GitHubError, MAX_COMMITS, type CommitRef, type GitHub } from "./github.ts";
import { localStatus, scanMods, type InventoryItem } from "./inventory.ts";
import { findSource, type Suggestion } from "./match.ts";
import type { ModEntry, SourceRecord, Sources } from "./model.ts";
import { herdrHome, hmodHome } from "./paths.ts";
import { loadSources, updateSources } from "./store.ts";

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

/** One mod's result in check.json. */
interface Saved {
  checked_at: string;
  /** The last check failed. Whatever else is here came from the last one that didn't. */
  error: string | null;
  upstream: Upstream | null;
  clone: CloneState | null;
  suggestions: Suggestion[];
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
  /** Possible sources for an unlinked mod: either several exact copies, or partial matches. */
  suggestions: Suggestion[];
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

/** Which of `commits` the baseline came from, newest first; null if none of them. */
async function baselineIndex(gh: GitHub, record: SourceRecord, commits: CommitRef[], atHead: boolean): Promise<number | null> {
  const known = commits.findIndex((c) => c.sha === record.commit);
  if (known >= 0) return known;
  if (atHead) return 0;
  // Linked by hand, or recorded from a commit that didn't touch the folder: go by content.
  for (const [i, { sha }] of commits.entries()) {
    const tree = await gh.treeAt(record.repo, record.path, sha);
    if (tree && diffTrees(tree, record.files).length === 0) return i;
  }
  return null;
}

async function inspectLinked(gh: GitHub, name: string, record: SourceRecord): Promise<Upstream> {
  const { repo, path, branch } = record;
  const gone = () => new GitHubError(`${path} isn't in ${repo}${branch ? ` on ${branch}` : ""} any more`);
  const commits = await gh.folderCommits(repo, path, branch);
  const head = commits?.[0]?.sha;
  if (!commits || !head) throw gone();
  const files = await gh.treeAt(repo, path, head);
  if (!files) throw gone();
  const atHead = diffTrees(record.files, files).length === 0;
  const index = await baselineIndex(gh, record, commits, atHead);
  let baseline = record.commit;
  if (baseline === null && index !== null) {
    baseline = commits[index]!.sha;
    await updateSources((sources) => {
      const latest = sources[name];
      if (latest?.commit === null && diffTrees(latest.files, record.files).length === 0) latest.commit = baseline;
    });
  }
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
    baseline,
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
  if (record) return { ...base, upstream: await inspectLinked(gh, item.name, record) };
  const files = hashTree(item.dir);
  const { match, suggestions } = await findSource(gh, { name: item.name, title: item.title, files });
  if (!match) return { ...base, suggestions };
  const fresh: SourceRecord = { repo: match.repo, path: match.path, branch: null, commit: match.commit, files };
  const linked = await updateSources((latest) => (latest[item.name] ??= fresh));
  return { ...base, upstream: await inspectLinked(gh, item.name, linked) };
}

function localVersion(dir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, "mod.json"), "utf8"));
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function withLinked(entry: CheckEntry, record: SourceRecord, up: Upstream): CheckEntry {
  const same = up.repo === record.repo && up.path === record.path && up.branch === record.branch;
  if (!same) return entry; // Relinked since: this says nothing about the new source.
  const update = diffTrees(record.files, up.files).length > 0;
  const measured = record.commit === up.baseline;
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
    checked_at: saved?.checked_at ?? null,
    clone: null,
  };
  if (!saved || local.status === "error" || local.status === "herdr" || item.cloned_from) return entry;

  const record = sources[item.name];
  if (saved.clone && item.adapter) entry = withClone(entry, saved.clone, item.adapter.update);
  else if (saved.upstream && record) entry = withLinked(entry, record, saved.upstream);
  else if (!record && !item.adapter) {
    entry = { ...entry, remote_checked: !saved.error, suggestions: saved.suggestions };
  }

  if (!saved.error) return entry;
  const answered = saved.upstream || saved.clone;
  return answered
    ? { ...entry, note: `Last check failed: ${saved.error}` }
    : { ...entry, status: "error", message: saved.error, remote_checked: false };
}

/** Asks GitHub and origin about every mod, links what can be linked, and saves the results. */
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

  const latest = loadSources(); // Now with the links just made.
  const file: CheckFile = { last_checked: now, mods: Object.create(null) };
  const mods = items.map((item, i) => {
    const result = results[i];
    const before = previous.mods[item.name];
    const keep = result?.error && before ? { ...before, error: result.error } : result;
    if (keep) file.mods[item.name] = keep;
    return present(item, latest, result ?? undefined);
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
