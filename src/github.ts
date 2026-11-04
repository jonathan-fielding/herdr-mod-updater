/** GitHub's REST API: read-only, cached with ETags, and limited in how much it asks at once. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HmodError } from "./errors.ts";
import { atomicWrite, gitBlobSha, isIgnored } from "./fsutil.ts";
import { hmodHome } from "./paths.ts";

export const GITHUB_API = "https://api.github.com";
/** How far back a mod's history is walked. */
export const MAX_COMMITS = 30;

export class GitHubError extends HmodError {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

export class RateLimitError extends GitHubError {
  constructor(
    readonly resetAt: Date,
    authenticated: boolean,
  ) {
    const time = resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const hint = authenticated ? "" : " (run `gh auth login` for a much higher limit)";
    super(`GitHub rate limit reached: try again after ${time}${hint}`);
    this.name = "RateLimitError";
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubOptions {
  fetch?: Fetch;
  token?: string | null;
  api?: string;
  cacheDir?: string;
  /** Requests in flight at once. */
  concurrency?: number;
}

export interface RepoHit {
  full_name: string;
  name: string;
}

export interface CommitRef {
  sha: string;
}

interface CachedResponse {
  etag: string | null;
  body: unknown;
}

interface ContentEntry {
  name: string;
  type: string;
  sha: string;
}

/** One line of a git tree, as GitHub gives it: `mode` is how symlinks show up, type "commit" submodules. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface TreeResponse {
  truncated: boolean;
  tree: TreeEntry[];
}

const REQUEST_TIMEOUT_MS = 30_000;
/** How long to back off when GitHub says to stop without saying until when. */
const DEFAULT_BACKOFF_MS = 60_000;

/** The person's GitHub token, if the gh CLI has one. Without it requests go unauthenticated. */
export function ghToken(): string | null {
  try {
    const p = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    return p.exitCode === 0 ? p.stdout.toString().trim() || null : null;
  } catch {
    return null; // gh isn't installed.
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function waitTime(res: Response): number | null {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (retryAfter > 0) return Date.now() + retryAfter * 1000;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return reset > 0 ? reset * 1000 : null;
}

export class GitHub {
  readonly authenticated: boolean;
  /** When the limit that stopped this run lifts; null if it wasn't stopped. */
  rateLimitReset: Date | null = null;
  private readonly fetchImpl: Fetch;
  private readonly token: string | null;
  private readonly api: string;
  private readonly cacheDir: string;
  private readonly memo = new Map<string, Promise<unknown>>();
  /** GitHub counts search separately from everything else. */
  private readonly limited = new Map<"search" | "core", number>();
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(options: GitHubOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.token = options.token ?? null;
    this.authenticated = this.token !== null;
    this.api = options.api ?? GITHUB_API;
    this.cacheDir = options.cacheDir ?? join(hmodHome(), "github-cache");
    this.free = options.concurrency ?? 6;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }

  private stopIfLimited(resource: "search" | "core"): void {
    const until = this.limited.get(resource);
    if (until !== undefined && Date.now() < until) throw new RateLimitError(new Date(until), this.authenticated);
  }

  private request(method: "GET" | "HEAD", path: string, etag?: string | null): Promise<Response> {
    const resource = path.startsWith("/search/") ? "search" : "core";
    return this.slot(async () => {
      this.stopIfLimited(resource); // Checked in the slot too: an earlier request may have just hit it.
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "herdr-mod-updater",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (etag) headers["If-None-Match"] = etag;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.api}${path}`, {
          method,
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e: any) {
        throw new GitHubError(`can't reach GitHub: ${e?.message ?? e}`);
      }
      if (res.status === 403 || res.status === 429) {
        const body = await res.text();
        const limited =
          res.status === 429 ||
          res.headers.get("x-ratelimit-remaining") === "0" ||
          res.headers.has("retry-after") ||
          /rate limit/i.test(body);
        if (limited) {
          const until = waitTime(res) ?? Date.now() + DEFAULT_BACKOFF_MS;
          this.limited.set(resource, until);
          this.rateLimitReset = new Date(until);
          throw new RateLimitError(this.rateLimitReset, this.authenticated);
        }
        throw new GitHubError(`GitHub refused ${path}: ${res.status} ${body.slice(0, 200)}`);
      }
      return res;
    });
  }

  private cacheFile(path: string): string {
    return join(this.cacheDir, `${createHash("sha256").update(`${this.api}${path}`).digest("hex")}.json`);
  }

  private readCache(path: string): CachedResponse | null {
    try {
      return JSON.parse(readFileSync(this.cacheFile(path), "utf8")) as CachedResponse;
    } catch {
      return null; // Missing or damaged: ask GitHub instead.
    }
  }

  private writeCache(path: string, entry: CachedResponse): void {
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    atomicWrite(this.cacheFile(path), JSON.stringify(entry));
  }

  /** Each URL is asked at most once per run, however many mods want it. */
  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let pending = this.memo.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load();
      this.memo.set(key, pending);
    }
    return pending;
  }

  /**
   * GETs JSON, or null for a 404 (or the 409 of an empty repo). `immutable` is for URLs pinned to a
   * commit or object: they can't change, so a cached copy is used without asking.
   */
  private get<T>(path: string, immutable = false): Promise<T | null> {
    return this.once(`GET ${path}`, async () => {
      const cached = this.readCache(path);
      if (cached && immutable) return cached.body as T;
      const res = await this.request("GET", path, cached?.etag);
      if (res.status === 304 && cached) return cached.body as T;
      if (res.status === 404 || res.status === 409) return null;
      if (!res.ok) throw new GitHubError(`GitHub said ${res.status} for ${path}`);
      const body = (await res.json()) as T;
      const etag = res.headers.get("etag");
      if (etag || immutable) this.writeCache(path, { etag, body });
      return body;
    });
  }

  /** Repos with the herdr-mod topic that fit `term`, forks included, best first. */
  async searchMods(term: string): Promise<RepoHit[]> {
    const q = encodeURIComponent(`${term} topic:herdr-mod fork:true`);
    const found = await this.get<{ items: RepoHit[] }>(`/search/repositories?q=${q}&per_page=30`);
    return found?.items ?? [];
  }

  /** The folders under mods/ on the repo's default branch. */
  async modFolders(repo: string): Promise<string[]> {
    const entries = await this.get<ContentEntry[]>(`/repos/${repo}/contents/mods`);
    return Array.isArray(entries) ? entries.filter((e) => e.type === "dir").map((e) => e.name) : [];
  }

  /**
   * The commits that touched a folder, newest first, up to MAX_COMMITS. The folder rather than its
   * main.js, because a commit that only changes mod.json is a version someone may have installed.
   * null when the repo or branch doesn't exist.
   */
  async folderCommits(repo: string, path: string, branch: string | null): Promise<CommitRef[] | null> {
    const on = branch ? `&sha=${encodeURIComponent(branch)}` : "";
    return this.get<CommitRef[]>(
      `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=${MAX_COMMITS}${on}`,
    );
  }

  /** relpath -> blob SHA of a folder at a commit, leaving out ignored files; null if it wasn't there. */
  async treeAt(repo: string, path: string, commit: string): Promise<Record<string, string> | null> {
    const entries = await this.get<ContentEntry[]>(`/repos/${repo}/contents/${encodePath(path)}?ref=${commit}`, true);
    if (!Array.isArray(entries)) return null;
    const files: Record<string, string> = Object.create(null);
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      if (entry.type === "file" || entry.type === "symlink") files[entry.name] = entry.sha;
      if (entry.type !== "dir") continue;
      const tree = await this.get<{ truncated: boolean; tree: { path: string; type: string; sha: string }[] }>(
        `/repos/${repo}/git/trees/${entry.sha}?recursive=1`,
        true,
      );
      if (!tree || tree.truncated) throw new GitHubError(`can't read ${path}/${entry.name} in ${repo}: it's too big`);
      for (const item of tree.tree) {
        const rel = `${entry.name}/${item.path}`;
        if (item.type === "blob" && !isIgnored(rel)) files[rel] = item.sha;
      }
    }
    return files;
  }

  /**
   * Everything in a folder at a commit, with nothing left out and paths relative to it; null if it
   * wasn't there. Unlike the contents API, this says which entries are symlinks and submodules.
   */
  async folderEntries(repo: string, path: string, commit: string): Promise<TreeEntry[] | null> {
    let sha = commit;
    for (const part of path.split("/")) {
      const level = await this.get<TreeResponse>(`/repos/${repo}/git/trees/${sha}`, true);
      const next = level?.tree.find((e) => e.path === part && e.type === "tree");
      if (!next) return null;
      sha = next.sha;
    }
    const tree = await this.get<TreeResponse>(`/repos/${repo}/git/trees/${sha}?recursive=1`, true);
    if (!tree) return null;
    if (tree.truncated) throw new GitHubError(`can't read ${path} in ${repo}: it's too big`);
    return tree.tree;
  }

  /** The blob SHA of a file at the root of the repo at a commit, or null. */
  async rootFile(repo: string, name: string, commit: string): Promise<string | null> {
    const root = await this.get<TreeResponse>(`/repos/${repo}/git/trees/${commit}`, true);
    return root?.tree.find((e) => e.path === name && e.type === "blob")?.sha ?? null;
  }

  /**
   * A file's bytes, checked against its SHA. Not cached: the cache is for answers, not mods' files
   * (and hasBlob keeps its own note under this URL).
   */
  async blob(repo: string, sha: string): Promise<Uint8Array> {
    const path = `/repos/${repo}/git/blobs/${sha}`;
    const res = await this.request("GET", path);
    if (!res.ok) throw new GitHubError(`GitHub said ${res.status} for ${path}`);
    const { content, encoding } = (await res.json()) as { content?: string; encoding?: string };
    if (typeof content !== "string" || encoding !== "base64") throw new GitHubError(`GitHub sent ${path} in a form hmod can't read`);
    const bytes = Buffer.from(content, "base64");
    if (gitBlobSha(bytes) !== sha) throw new GitHubError(`what GitHub sent for ${path} doesn't match its SHA`);
    return bytes;
  }

  /** The `version` in a folder's mod.json at a commit, or null if there isn't one. */
  async versionAt(repo: string, path: string, commit: string): Promise<string | null> {
    const file = await this.get<{ content?: string }>(
      `/repos/${repo}/contents/${encodePath(path)}/mod.json?ref=${commit}`,
      true,
    );
    try {
      const { version } = JSON.parse(Buffer.from(file?.content ?? "", "base64").toString("utf8"));
      return typeof version === "string" ? version : null;
    } catch {
      return null;
    }
  }

  /** Whether the repo holds this exact content anywhere. A HEAD request, so it costs one call and no download. */
  hasBlob(repo: string, sha: string): Promise<boolean> {
    const path = `/repos/${repo}/git/blobs/${sha}`;
    return this.once(`HEAD ${path}`, async () => {
      if (this.readCache(path)) return true;
      const res = await this.request("HEAD", path);
      if (res.status === 404 || res.status === 409) return false;
      if (!res.ok) throw new GitHubError(`GitHub said ${res.status} for ${path}`);
      this.writeCache(path, { etag: null, body: true });
      return true;
    });
  }
}

/** The real thing. $HMOD_GITHUB_API points it at a stand-in server, which never gets the token. */
export function createGitHub(): GitHub {
  const api = process.env.HMOD_GITHUB_API;
  return api ? new GitHub({ api }) : new GitHub({ token: ghToken() });
}
