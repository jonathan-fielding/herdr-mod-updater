/** A stand-in for GitHub's REST API, built from plain fixtures. Nothing here touches the network. */
import { resolve } from "node:path";
import { gitBlobSha } from "../src/fsutil.ts";
import type { Homes } from "./helpers.ts";

export interface FakeCommit {
  sha: string;
  /** Path in the repo -> content, as of this commit. */
  files: Record<string, string>;
}

export interface FakeRepo {
  /** Newest first. */
  commits: FakeCommit[];
  /** Search only finds repos by this topic. Default true. */
  topic?: boolean;
}

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
}

const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");
const blob = (content: string) => gitBlobSha(Buffer.from(content));
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A made-up commit SHA, stable for a label. */
export const sha = (label: string) => gitBlobSha(Buffer.from(`commit ${label}`));

export class FakeGitHub {
  readonly requests: FakeRequest[] = [];
  /** When set, every request gets this. */
  limited: Response | (() => Response) | null = null;
  /** Answers every matching path with this status instead. */
  failing: { pattern: RegExp; status: number } | null = null;

  constructor(readonly repos: Record<string, FakeRepo>) {}

  /** Requests answered with a 304, which GitHub doesn't charge for. */
  notModified = 0;

  /** Use as GitHubOptions.fetch. */
  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    return this.handle(new Request(url, init));
  };

  handle(req: Request): Response {
    const url = new URL(req.url);
    this.requests.push({ method: req.method, url, headers: req.headers });
    if (this.limited) return typeof this.limited === "function" ? this.limited() : (this.limited.clone() as Response);
    if (this.failing?.pattern.test(url.pathname)) return new Response("broken", { status: this.failing.status });
    const res = this.route(url);
    if (!res.ok) return json({ message: "Not Found" }, {}, res.status);
    if (res.bodyJson === undefined) return new Response(null, { status: res.status });
    const tag = `"${Bun.hash(JSON.stringify(res.bodyJson))}"`;
    if (req.headers.get("if-none-match") === tag) {
      this.notModified++;
      return new Response(null, { status: 304 });
    }
    return json(res.bodyJson, { etag: tag });
  }

  private route(url: URL): { ok: boolean; status: number; bodyJson?: unknown } {
    const ok = (bodyJson: unknown) => ({ ok: true, status: 200, bodyJson });
    const missing = { ok: false, status: 404 };
    if (url.pathname === "/search/repositories") return ok({ items: this.search(url.searchParams.get("q") ?? "") });
    const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(.*)$/);
    const repo = m && this.repos[m[1]!];
    if (!m || !repo) return missing;
    const rest = m[2]!;
    const head = repo.commits[0];

    if (rest === "commits") {
      const path = url.searchParams.get("path") ?? "";
      if (url.searchParams.get("sha") === "gone") return missing;
      return ok(this.touching(repo, path).slice(0, Number(url.searchParams.get("per_page") ?? 30)));
    }
    if (rest.startsWith("git/blobs/")) {
      const want = rest.slice("git/blobs/".length);
      const found = repo.commits.some((c) => Object.values(c.files).some((f) => blob(f) === want));
      return found ? { ok: true, status: 200 } : missing;
    }
    if (rest.startsWith("git/trees/")) {
      const want = rest.slice("git/trees/".length);
      for (const c of repo.commits) {
        for (const dir of this.dirs(c)) {
          if (this.dirSha(c, dir) === want) {
            const prefix = `${dir}/`;
            const tree = Object.entries(c.files)
              .filter(([p]) => p.startsWith(prefix))
              .map(([p, content]) => ({ path: p.slice(prefix.length), type: "blob", sha: blob(content) }));
            return ok({ truncated: false, tree });
          }
        }
      }
      return missing;
    }
    if (rest.startsWith("contents/")) {
      const path = decodeURIComponent(rest.slice("contents/".length));
      const ref = url.searchParams.get("ref");
      const commit = ref ? repo.commits.find((c) => c.sha === ref) : head;
      if (!commit) return missing;
      const file = commit.files[path];
      if (file !== undefined) {
        return ok({ type: "file", sha: blob(file), content: Buffer.from(file).toString("base64"), encoding: "base64" });
      }
      const entries = this.list(commit, path);
      return entries.length ? ok(entries) : missing;
    }
    return missing;
  }

  private search(q: string): { full_name: string; name: string }[] {
    const term = q.replace("topic:herdr-mod", "").replace("fork:true", "").trim().toLowerCase();
    const words = term.split(/\s+/);
    return Object.entries(this.repos)
      .filter(([full, r]) => r.topic !== false && words.some((w) => full.toLowerCase().includes(w)))
      .map(([full]) => ({ full_name: full, name: full.split("/")[1]! }));
  }

  /** Commits that changed anything under `path`: a commit is listed only if it differs from the next older. */
  private touching(repo: FakeRepo, path: string): { sha: string }[] {
    const under = (c: FakeCommit) =>
      JSON.stringify(Object.entries(c.files).filter(([p]) => p === path || p.startsWith(`${path}/`)).sort());
    return repo.commits
      .filter((c, i) => {
        const older = repo.commits[i + 1];
        return older ? under(c) !== under(older) : under(c) !== "[]";
      })
      .map((c) => ({ sha: c.sha }));
  }

  private dirs(c: FakeCommit): string[] {
    const out = new Set<string>();
    for (const p of Object.keys(c.files)) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
    }
    return [...out];
  }

  private dirSha(c: FakeCommit, dir: string): string {
    return blob(`tree ${dir} ${JSON.stringify(Object.entries(c.files).filter(([p]) => p.startsWith(`${dir}/`)).sort())}`);
  }

  private list(c: FakeCommit, dir: string) {
    const prefix = `${dir}/`;
    const seen = new Map<string, { name: string; type: string; sha: string }>();
    for (const [p, content] of Object.entries(c.files)) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      const name = rel.split("/")[0]!;
      seen.set(name, rel.includes("/")
        ? { name, type: "dir", sha: this.dirSha(c, `${prefix}${name}`) }
        : { name, type: "file", sha: blob(content) });
    }
    return [...seen.values()];
  }
}

/** The mod's files as they sit in a repo, under mods/<name>/, plus what lives outside that folder. */
export function inRepo(name: string, files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { "RECIPE.md": "recipe", "preview.png": "png" };
  for (const [rel, content] of Object.entries(files)) out[`mods/${name}/${rel}`] = content;
  return out;
}

/** Runs the real CLI against the fake over a local port: spawned async, so the fake can answer. */
export async function runCli(h: Homes, fake: FakeGitHub, ...args: string[]) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => fake.handle(req) });
  try {
    const p = Bun.spawn(["bun", CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HERDR_APP_HOME: h.herdr,
        HMOD_HOME: h.hmod,
        HOME: h.other,
        HMOD_GITHUB_API: `http://127.0.0.1:${server.port}`,
      },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } finally {
    server.stop(true);
  }
}
