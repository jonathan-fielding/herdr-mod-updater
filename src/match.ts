/**
 * Finds where an unlinked mod might have come from by its content, and offers what it finds. It
 * never links: matching files prove someone holds a copy, not who wrote it, and anyone can publish
 * a copy with the herdr-mod topic. So the person always chooses, even with one exact match, and each
 * offer carries what they can judge it by. Those facts can be faked too, so nothing acts on them
 * except the order: forks go last.
 */
import { diffTrees } from "./fsutil.ts";
import { RateLimitError, type CommitRef, type GitHub, type RepoHit, type RepoTree } from "./github.ts";
import type { OfferGap } from "./model.ts";

/** Without a token GitHub's limit rules out reading every repo, so search by name picks these. */
const MAX_SEARCHED = 20;
/** With a token, the repos read closely per mod: walking one's history costs up to about 40 requests. */
const MAX_SCANNED = 40;
const MAX_SUGGESTIONS = 5;
/** Files tried when asking whether a repo holds any of the mod. Local order: main.js first. */
const MAX_PROBES = 10;
const MAX_NAMED_FAILURES = 3;

export interface Suggestion {
  repo: string;
  path: string;
  /** Why it's offered, for showing to the person. */
  why: string;
  /** Every file equals `commit`. That's a copy of the mod, which isn't proof of where it came from. */
  exact: boolean;
  /** The closest commit. */
  commit: string;
  owner: string;
  /** When the repo was made; null if GitHub didn't say. */
  created_at: string | null;
  fork: boolean;
  /** The repo it's a fork of; null if it isn't one, or GitHub didn't say. */
  fork_of: string | null;
  stars: number | null;
  /** Commits to the mod's folder since `commit`. Above 0, what's offered isn't what would install. */
  commits_past_match: number;
  /** All of the above in words, a line each. */
  evidence: string[];
}

export interface MatchTarget {
  name: string;
  title: string;
  /** The mod's files: relative path -> blob SHA. */
  files: Record<string, string>;
}

/** What was found, and why that may not be everything. */
export interface SourceSearch {
  suggestions: Suggestion[];
  gaps: OfferGap[];
}

interface Scan {
  hit: RepoHit;
  repo: string;
  path: string;
  commit: string;
  exact: boolean;
  /** How many local files equal that commit. */
  same: number;
  /** Newer commits to the folder. */
  past: number;
}

interface Failure {
  repo: string;
  error: unknown;
}

interface Candidates {
  hits: RepoHit[];
  gaps: OfferGap[];
  failed: Failure[];
  /** How many repos were asked about: all of them failing is an error, not an empty list. */
  asked: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const searchTerm = (s: string) => s.replace(/[^\p{L}\p{N} _-]+/gu, " ").trim();
const repos = (n: number) => (n === 1 ? "1 repo" : `${n} repos`);

const SEARCH_LIMIT: OfferGap = { kind: "search_limit", detail: "GitHub's search stopped before the end of its results." };

async function searched(gh: GitHub, { name, title }: MatchTarget): Promise<Candidates> {
  const terms = [...new Set([name, title].map(searchTerm).filter(Boolean))];
  const results = await Promise.all(terms.map((t) => gh.searchMods(t)));
  const found = new Map<string, RepoHit>();
  for (const { hits } of results) {
    for (const hit of hits) if (!found.has(hit.full_name)) found.set(hit.full_name, hit);
  }
  const wanted = slug(name);
  const fits = (hit: RepoHit) => (hit.name.toLowerCase().includes(wanted) ? 0 : 1);
  const gaps: OfferGap[] = [{
    kind: "name_search",
    detail: "Without a GitHub token hmod searches by name, so a repo with another name wasn't looked at. Run `gh auth login` to check every herdr-mod repo.",
  }];
  if (results.some((r) => r.partial)) gaps.push(SEARCH_LIMIT);
  if (found.size > MAX_SEARCHED) gaps.push({ kind: "repo_cap", detail: `${found.size} repos came up, and hmod read the ${MAX_SEARCHED} closest by name.` });
  const hits = [...found.values()].sort((a, b) => fits(a) - fits(b)).slice(0, MAX_SEARCHED);
  return { hits, gaps, failed: [], asked: hits.length };
}

/** How good a closer look at a repo seems, best first; null if it isn't worth one. */
function promise(repo: RepoTree | null, target: MatchTarget): number | null {
  if (!repo) return null;
  const blobs = new Set(telling(target.files).map((rel) => target.files[rel]));
  if (repo.tree.some((e) => e.type === "blob" && blobs.has(e.sha))) return 0;
  const names = new Set([slug(target.name), slug(target.title)]);
  const named = repo.tree.some((e) => {
    const folder = e.path.match(/^mods\/([^/]+)\//)?.[1];
    return folder !== undefined && names.has(slug(folder));
  });
  return named || repo.truncated ? 1 : null; // Part of a tree can't rule anything out.
}

/** Every repo with the topic gets a look at its tree, so nobody's real source can be pushed out of a short list by name. */
async function candidates(gh: GitHub, target: MatchTarget): Promise<Candidates> {
  if (!gh.authenticated) return searched(gh, target);
  const { hits: listed, partial } = await gh.topicRepos();
  const failed: Failure[] = [];
  const trees = await Promise.all(
    listed.map((r) =>
      gh.repoTree(r.full_name).catch((error) => {
        failed.push({ repo: r.full_name, error });
        return null;
      }),
    ),
  );
  const likely = listed
    .map((hit, i) => ({ hit, rank: promise(trees[i] ?? null, target) }))
    .filter((c) => c.rank !== null)
    .sort((a, b) => a.rank! - b.rank!);
  const gaps: OfferGap[] = partial ? [SEARCH_LIMIT] : [];
  if (likely.length > MAX_SCANNED) gaps.push({ kind: "repo_cap", detail: `${likely.length} repos could hold this mod, and hmod read the ${MAX_SCANNED} likeliest.` });
  return { hits: likely.slice(0, MAX_SCANNED).map((c) => c.hit), gaps, failed, asked: listed.length };
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
  // The match is in this list, so its place in it is an exact count even when the list was cut short.
  for (const [past, { sha }] of ((await gh.folderCommits(repo, path, null)) ?? []).entries()) {
    const tree = await gh.treeAt(repo, path, sha);
    if (!tree) continue;
    if (diffTrees(tree, target.files).length === 0) {
      return { hit, repo, path, commit: sha, exact: true, same: Object.keys(target.files).length, past };
    }
    if (!telling(target.files).some((rel) => tree[rel] === target.files[rel])) continue;
    const same = Object.keys(target.files).filter((rel) => tree[rel] === target.files[rel]).length;
    if (!best || same > best.same) best = { hit, repo, path, commit: sha, exact: false, same, past };
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

/** "Every file matches" only rules out other repos when every repo was seen. */
function reason(s: Scan, exactCount: number, total: number, seenAll: boolean): string {
  const commit = s.commit.slice(0, 7);
  if (!s.exact) return `${s.same} of ${total} files match commit ${commit}`;
  const others = exactCount - 1;
  const matches = `Every file matches commit ${commit}`;
  const atLeast = seenAll ? "" : "at least ";
  if (others === 1) return `${matches}, but so does ${atLeast}1 other repo`;
  if (others > 1) return `${matches}, but so do ${atLeast}${others} other repos`;
  return seenAll ? matches : `${matches}. Other repos may match too: not all of them were checked`;
}

function evidence(s: Omit<Suggestion, "evidence">): string[] {
  const facts = [`Owner ${s.owner}`];
  if (s.created_at) facts.push(`created ${s.created_at.slice(0, 10)}`);
  if (s.stars !== null) facts.push(s.stars === 1 ? "1 star" : `${s.stars} stars`);
  facts.push(s.fork ? (s.fork_of ? `fork of ${s.fork_of}` : "a fork, of a repo GitHub didn't name") : "not a fork");
  const n = s.commits_past_match;
  const newer = n === 1 ? "1 newer commit" : `${n} newer commits`;
  const since = n === 0
    ? "The mod's folder hasn't changed since that commit."
    : `The mod's folder has changed since that commit: ${newer}. An update would install those, and they aren't what matched.`;
  return [facts.join(" · "), since];
}

async function suggestion(gh: GitHub, s: Scan, why: string): Promise<Suggestion> {
  const { hit, repo, path, exact, commit } = s;
  const fork = hit.fork === true;
  // The one fact search leaves out, so asked only of a fork that's being offered. Without it the offer still stands.
  const fork_of = fork ? await gh.forkParent(repo).catch(() => null) : null;
  const facts = {
    repo,
    path,
    why,
    exact,
    commit,
    owner: repo.split("/")[0]!,
    created_at: typeof hit.created_at === "string" ? hit.created_at : null,
    fork,
    fork_of,
    stars: typeof hit.stargazers_count === "number" ? hit.stargazers_count : null,
    commits_past_match: s.past,
  };
  return { ...facts, evidence: evidence(facts) };
}

function failureGaps(failed: Failure[]): OfferGap[] {
  const limited = failed.filter((f) => f.error instanceof RateLimitError);
  const broken = failed.filter((f) => !(f.error instanceof RateLimitError));
  const gaps: OfferGap[] = [];
  if (limited.length) gaps.push({ kind: "rate_limit", detail: `GitHub's rate limit stopped hmod reading ${repos(limited.length)}.` });
  if (broken.length) {
    const names = broken.slice(0, MAX_NAMED_FAILURES).map((f) => f.repo).join(", ");
    const rest = broken.length - MAX_NAMED_FAILURES;
    gaps.push({ kind: "repo_failed", detail: `hmod couldn't read ${names}${rest > 0 ? ` and ${repos(rest)} more` : ""}, so skipped ${broken.length === 1 ? "it" : "them"}.` });
  }
  return gaps;
}

export async function findSource(gh: GitHub, target: MatchTarget): Promise<SourceSearch> {
  const { hits, gaps, failed, asked } = await candidates(gh, target);
  // One repo failing costs that repo, or a hostile copy could hide every other offer.
  const read = await Promise.all(
    hits.map((hit) =>
      scan(gh, hit, target).catch((error) => {
        failed.push({ repo: hit.full_name, error });
        return null;
      }),
    ),
  );
  if (asked > 0 && failed.length >= asked) throw failed[0]!.error; // Nothing was read, so nothing can be said.
  gaps.push(...failureGaps(failed));
  const scans = read.filter((s) => s !== null);
  const seenAll = gaps.length === 0;
  const exact = scans.filter((s) => s.exact).length;
  const total = Object.keys(target.files).length;
  const forked = (s: Scan) => Number(s.hit.fork === true);
  const ranked = scans.sort((a, b) => forked(a) - forked(b) || Number(b.exact) - Number(a.exact) || b.same - a.same);
  if (ranked.length > MAX_SUGGESTIONS) gaps.push({ kind: "offer_cap", detail: `Showing ${MAX_SUGGESTIONS} of ${ranked.length} possible sources, so one you'd recognise could be left out.` });
  const shown = ranked.slice(0, MAX_SUGGESTIONS);
  return { suggestions: await Promise.all(shown.map((s) => suggestion(gh, s, reason(s, exact, total, seenAll)))), gaps };
}
