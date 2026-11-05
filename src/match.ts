/**
 * Finds where an unlinked mod came from by its content: names are unreliable, so a mod is linked
 * only when its files equal a commit in exactly one repo, and a name alone never links anything.
 */
import { diffTrees } from "./fsutil.ts";
import type { CommitRef, GitHub, RepoHit } from "./github.ts";

/** Search can return a lot for a common word; those that fit by name are looked at first. */
const MAX_CANDIDATES = 20;
const MAX_SUGGESTIONS = 5;
/** Files tried when asking whether a repo holds any of the mod. Local order: main.js first. */
const MAX_PROBES = 10;

export interface Suggestion {
  repo: string;
  path: string;
  /** Why it's offered, for showing to the person. */
  why: string;
  /** Every file equals `commit`: the mod is here, and in at least one other repo too. */
  exact: boolean;
  /** The closest commit. */
  commit: string;
}

export interface MatchTarget {
  name: string;
  title: string;
  /** The mod's files: relative path -> blob SHA. */
  files: Record<string, string>;
}

export interface Match {
  repo: string;
  path: string;
  commit: string;
}

export interface MatchResult {
  /** Set only when every file equals one commit in exactly one repo. */
  match: Match | null;
  suggestions: Suggestion[];
}

interface Scan extends Match {
  exact: boolean;
  /** How many local files equal that commit. */
  same: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const searchTerm = (s: string) => s.replace(/[^\p{L}\p{N} _-]+/gu, " ").trim();

async function candidates(gh: GitHub, { name, title }: MatchTarget): Promise<RepoHit[]> {
  const terms = [...new Set([name, title].map(searchTerm).filter(Boolean))];
  const found = new Map<string, RepoHit>();
  for (const hits of await Promise.all(terms.map((t) => gh.searchMods(t)))) {
    for (const hit of hits) if (!found.has(hit.full_name)) found.set(hit.full_name, hit);
  }
  const wanted = slug(name);
  const fits = (hit: RepoHit) => (hit.name.toLowerCase().includes(wanted) ? 0 : 1);
  return [...found.values()].sort((a, b) => fits(a) - fits(b)).slice(0, MAX_CANDIDATES);
}

/** The repo's folder for this mod. Installs get renamed, so a differing name still gets a look. */
function folderFor(folders: string[], { name, title }: MatchTarget): string | null {
  const named = (want: string) => folders.find((f) => slug(f) === slug(want));
  return folders.includes(name) ? name : (named(name) ?? named(title) ?? (folders.length === 1 ? folders[0]! : null));
}

/** Files that say something about where a mod came from: a mod.json can be just `{ "place": "none" }`. */
const telling = (files: Record<string, string>) => Object.keys(files).filter((f) => f !== "mod.json");

async function holdsAny(gh: GitHub, repo: string, files: Record<string, string>): Promise<boolean> {
  const probes = telling(files).sort((a, b) => Number(b === "main.js") - Number(a === "main.js"));
  for (const rel of probes.slice(0, MAX_PROBES)) {
    if (await gh.hasBlob(repo, files[rel]!)) return true;
  }
  return false;
}

/** The commit closest to the mod's files in one repo. Stops at the newest exact one. */
async function scan(gh: GitHub, hit: RepoHit, target: MatchTarget): Promise<Scan | null> {
  const repo = hit.full_name;
  const folder = folderFor(await gh.modFolders(repo), target);
  if (!folder) return null;
  // Walking history is a request per commit, so repos without a single matching file are skipped.
  if (!(await holdsAny(gh, repo, target.files))) return null;
  const path = `mods/${folder}`;
  let best: Scan | null = null;
  for (const { sha } of (await gh.folderCommits(repo, path, null)) ?? []) {
    const tree = await gh.treeAt(repo, path, sha);
    if (!tree) continue;
    if (diffTrees(tree, target.files).length === 0) {
      return { repo, path, commit: sha, exact: true, same: Object.keys(target.files).length };
    }
    if (!telling(target.files).some((rel) => tree[rel] === target.files[rel])) continue;
    const same = Object.keys(target.files).filter((rel) => tree[rel] === target.files[rel]).length;
    if (!best || same > best.same) best = { repo, path, commit: sha, exact: false, same };
  }
  return best;
}

/** The newest commit in the mod folder's history (the same walk as above) with exactly these files. */
export async function findVersion(
  gh: GitHub,
  repo: string,
  path: string,
  commits: CommitRef[],
  files: Record<string, string>,
): Promise<string | null> {
  for (const { sha } of commits) {
    const tree = await gh.treeAt(repo, path, sha);
    if (tree && diffTrees(tree, files).length === 0) return sha;
  }
  return null;
}

function suggestion(s: Scan, exactCount: number, total: number): Suggestion {
  const commit = s.commit.slice(0, 7);
  const others = exactCount - 1;
  const why = s.exact
    ? `Every file matches commit ${commit}, but so ${others === 1 ? "does 1 other repo" : `do ${others} other repos`}`
    : `${s.same} of ${total} files match commit ${commit}`;
  return { repo: s.repo, path: s.path, why, exact: s.exact, commit: s.commit };
}

export async function findSource(gh: GitHub, target: MatchTarget): Promise<MatchResult> {
  const hits = await candidates(gh, target);
  // One repo failing fails the lot: "exactly one repo" can't be claimed without having seen them all.
  const scans = (await Promise.all(hits.map((hit) => scan(gh, hit, target)))).filter((s) => s !== null);
  const exact = scans.filter((s) => s.exact);
  if (exact.length === 1) {
    const { repo, path, commit } = exact[0]!;
    return { match: { repo, path, commit }, suggestions: [] };
  }
  const total = Object.keys(target.files).length;
  const ranked = scans.sort((a, b) => Number(b.exact) - Number(a.exact) || b.same - a.same);
  return {
    match: null,
    suggestions: ranked.slice(0, MAX_SUGGESTIONS).map((s) => suggestion(s, exact.length, total)),
  };
}
