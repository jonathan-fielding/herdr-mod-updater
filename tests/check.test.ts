import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedCheck, checkMods, type CheckEntry, type CheckResult } from "../src/check.ts";
import { hashTree } from "../src/fsutil.ts";
import { GitHub, GitHubError, MAX_COMMITS, RateLimitError } from "../src/github.ts";
import type { LinkResult, Sources } from "../src/model.ts";
import { FakeGitHub, inRepo, runCli, sha } from "./fake-github.ts";
import { makeHomes, writeTree, type Homes } from "./helpers.ts";

const injected = { "gpui-kit.d.ts": "// injected", "jsconfig.json": "{}", ".DS_Store": "x" };
const v1 = { "main.js": "version one", "mod.json": `{ "title": "Quota", "version": "1.0.0" }`, "lib/util.js": "util one" };
const v2 = { ...v1, "main.js": "version two", "mod.json": `{ "title": "Quota", "version": "2.0.0" }` };
const v3 = { ...v2, "main.js": "version three", "mod.json": `{ "title": "Quota", "version": "3.0.0" }` };
const history = [
  { sha: sha("three"), files: inRepo("quota", v3) },
  { sha: sha("two"), files: inRepo("quota", v2) },
  { sha: sha("one"), files: inRepo("quota", v1) },
];

let h: Homes;
const saveEnv = { HERDR_APP_HOME: process.env.HERDR_APP_HOME, HMOD_HOME: process.env.HMOD_HOME };
beforeEach(() => {
  h = makeHomes(["agents"]);
  process.env.HERDR_APP_HOME = h.herdr;
  process.env.HMOD_HOME = h.hmod;
});
afterEach(() => {
  h.cleanup();
  process.env.HERDR_APP_HOME = saveEnv.HERDR_APP_HOME;
  process.env.HMOD_HOME = saveEnv.HMOD_HOME;
  if (saveEnv.HERDR_APP_HOME === undefined) delete process.env.HERDR_APP_HOME;
  if (saveEnv.HMOD_HOME === undefined) delete process.env.HMOD_HOME;
});

const client = (fake: FakeGitHub, token: string | null = null) => new GitHub({ fetch: fake.fetch, token });
const check = async (fake: FakeGitHub) => checkMods(client(fake));
const entry = (r: CheckResult, name: string): CheckEntry => r.mods.find((m) => m.name === name)!;
const sources = (): Sources => JSON.parse(readFileSync(join(h.hmod, "sources.json"), "utf8"));
const hasSources = () => readdirSync(h.hmod).includes("sources.json");

describe("finding a source by content", () => {
  test("exact at HEAD: links it, saves the baseline, and it's up to date", async () => {
    h.mod("quota", { ...v3, ...injected });
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    const m = entry(await check(fake), "quota");
    expect(m).toMatchObject({
      status: "up_to_date",
      remote_checked: true,
      update_available: false,
      commits_behind: 0,
      source: { repo: "a/herdr-quota", path: "mods/quota", branch: null, commit: sha("three") },
      latest_commit: sha("three"),
      suggestions: [],
    });
    expect(Object.keys(sources().quota!.files).sort()).toEqual(["lib/util.js", "main.js", "mod.json"]);
  });

  test("an old version equals no HEAD, but history finds it: update available", async () => {
    h.mod("quota", { ...v1, ...injected });
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    const m = entry(await check(fake), "quota");
    expect(m).toMatchObject({
      status: "update_available",
      update_available: true,
      commits_behind: 2,
      installed_version: "1.0.0",
      latest_version: "3.0.0",
      latest_commit: sha("three"),
      source: { repo: "a/herdr-quota", commit: sha("one") },
    });
  });

  test("a commit that only changed mod.json counts as a version", async () => {
    const bumped = { ...v3, "mod.json": `{ "title": "Quota", "version": "3.0.1" }` };
    h.mod("quota", v3);
    const fake = new FakeGitHub({
      "a/herdr-quota": { commits: [{ sha: sha("bump"), files: inRepo("quota", bumped) }, ...history] },
    });
    expect(entry(await check(fake), "quota")).toMatchObject({
      status: "update_available",
      commits_behind: 1,
      source: { commit: sha("three") },
    });
  });

  test("only the repo with the right content links, among repos sharing the name", async () => {
    h.mod("quota", v1);
    const other = { "main.js": "someone else's", "mod.json": v1["mod.json"] };
    const fake = new FakeGitHub({
      "b/herdr-quota": { commits: [{ sha: sha("b"), files: inRepo("quota", other) }] },
      "a/herdr-quota": { commits: history },
      "c/herdr-quota": { commits: [{ sha: sha("c"), files: inRepo("quota", { "main.js": "third" }) }] },
    });
    expect(entry(await check(fake), "quota").source?.repo).toBe("a/herdr-quota");
  });

  test("an install renamed locally still links, keeping the repo's path", async () => {
    h.mod("my-quota", { ...v3, "mod.json": `{ "title": "Quota" }` });
    const files = { ...v3, "mod.json": `{ "title": "Quota" }` };
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: [{ sha: sha("x"), files: inRepo("quota", files) }] } });
    expect(entry(await check(fake), "my-quota")).toMatchObject({
      status: "up_to_date",
      source: { repo: "a/herdr-quota", path: "mods/quota" },
    });
  });

  test("forks with the same commit: left unlinked, with both offered", async () => {
    h.mod("quota", v2);
    const fake = new FakeGitHub({
      "a/herdr-quota": { commits: history },
      "fork/herdr-quota": { commits: history },
    });
    const m = entry(await check(fake), "quota");
    expect(m).toMatchObject({ status: "unlinked", source: null, remote_checked: true });
    expect(m.suggestions.map((s) => s.repo).sort()).toEqual(["a/herdr-quota", "fork/herdr-quota"]);
    expect(m.suggestions[0]).toMatchObject({ path: "mods/quota", exact: true, commit: sha("two") });
    expect(m.suggestions[0]!.why).toContain("1 other repo");
    expect(hasSources()).toBe(false);
  });

  test("a partial match: left unlinked, with why", async () => {
    h.mod("quota", { ...v1, "main.js": "edited by hand" });
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    const m = entry(await check(fake), "quota");
    expect(m.status).toBe("unlinked");
    expect(m.suggestions).toHaveLength(1);
    expect(m.suggestions[0]).toMatchObject({ repo: "a/herdr-quota", path: "mods/quota", exact: false, commit: sha("one") });
    expect(m.suggestions[0]!.why).toBe(`2 of 3 files match commit ${sha("one").slice(0, 7)}`);
  });

  test("a missing file isn't exact: the repo's extra file means something was removed", async () => {
    const { "lib/util.js": _, ...fewer } = v1;
    h.mod("quota", fewer);
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    const m = entry(await check(fake), "quota");
    expect(m.status).toBe("unlinked");
    expect(m.suggestions[0]).toMatchObject({ exact: false });
  });

  test("no match: a repo with the right name and folder never links on that alone", async () => {
    h.mod("quota", { "main.js": "mine", "mod.json": "{}" });
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    const m = entry(await check(fake), "quota");
    expect(m).toMatchObject({ status: "unlinked", source: null, suggestions: [], remote_checked: true });
    expect(hasSources()).toBe(false);
  });

  test("a shared bare mod.json alone is no evidence", async () => {
    const bare = `{ "place": "none" }`;
    h.mod("quota", { "main.js": "mine", "mod.json": bare });
    const fake = new FakeGitHub({
      "a/herdr-quota": { commits: [{ sha: sha("a"), files: { ...inRepo("quota", { "main.js": "theirs", "mod.json": bare }) } }] },
    });
    expect(entry(await check(fake), "quota").suggestions).toEqual([]);
  });

  test("a repo with none of the files costs no history walk", async () => {
    h.mod("quota", { "main.js": "mine" });
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    await check(fake);
    expect(fake.requests.some((r) => r.url.pathname.endsWith("/commits"))).toBe(false);
  });

  test("a repo without the topic isn't a candidate", async () => {
    h.mod("quota", v3);
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history, topic: false } });
    expect(entry(await check(fake), "quota").status).toBe("unlinked");
  });

  test("searches by title too", async () => {
    h.mod("renamed", { ...v3, "mod.json": `{ "title": "Quota" }` });
    const fake = new FakeGitHub({
      "a/herdr-quota": { commits: [{ sha: sha("x"), files: inRepo("quota", { ...v3, "mod.json": `{ "title": "Quota" }` }) }] },
    });
    expect(entry(await check(fake), "renamed").source?.repo).toBe("a/herdr-quota");
  });

  test("a failing candidate fails the mod rather than linking without seeing every repo", async () => {
    h.mod("quota", v3);
    const fake = new FakeGitHub({
      "a/herdr-quota": { commits: history },
      "bad/herdr-quota": { commits: history },
    });
    fake.failing = { pattern: /^\/repos\/bad\//, status: 500 };
    const m = entry(await check(fake), "quota");
    expect(m).toMatchObject({ status: "error", source: null });
    expect(m.message).toContain("500");
    expect(hasSources()).toBe(false);
  });
});

describe("mods that are never searched for", () => {
  test("herdr mods and mod.clone copies ask GitHub nothing", async () => {
    h.mod("agents", { "main.js": "shipped" });
    h.mod("my-files", { "main.js": "x", "mod.json": JSON.stringify({ cloned_from: { name: "files" } }) });
    h.mod("broken", { "main.js": "x", "mod.json": "{ nope" });
    const fake = new FakeGitHub({});
    const r = await check(fake);
    expect(fake.requests).toEqual([]);
    expect(entry(r, "agents").status).toBe("herdr");
    expect(entry(r, "my-files")).toMatchObject({ status: "unlinked", remote_checked: false });
    expect(entry(r, "broken").status).toBe("error");
  });
});

describe("linked mods", () => {
  const link = (name: string, ...more: string[]) => h.json<LinkResult>("link", name, "a/herdr-quota", ...more);
  const fake = () => new FakeGitHub({ "a/herdr-quota": { commits: history } });

  test("baseline and local equal HEAD: up to date, and the unknown commit gets filled in", async () => {
    h.mod("quota", v3);
    link("quota");
    expect(entry(await check(fake()), "quota")).toMatchObject({ status: "up_to_date", commits_behind: 0 });
    expect(sources().quota!.commit).toBe(sha("three"));
  });

  test("baseline equals an old commit: update available, behind found by content", async () => {
    h.mod("quota", v2);
    link("quota");
    expect(entry(await check(fake()), "quota")).toMatchObject({
      status: "update_available",
      commits_behind: 1,
      latest_version: "3.0.0",
    });
    expect(sources().quota!.commit).toBe(sha("two"));
  });

  test("local edits: modified, saying no update exists", async () => {
    h.mod("quota", v3);
    link("quota");
    writeFileSync(join(h.herdr, "mods", "quota", "main.js"), "edited");
    expect(entry(await check(fake()), "quota")).toMatchObject({
      status: "modified",
      changed: ["main.js"],
      update_available: false,
      note: "Has local edits",
    });
  });

  test("local edits on an old version: modified, saying an update exists", async () => {
    h.mod("quota", v1);
    link("quota");
    writeFileSync(join(h.herdr, "mods", "quota", "main.js"), "edited");
    expect(entry(await check(fake()), "quota")).toMatchObject({
      status: "modified",
      update_available: true,
      commits_behind: 2,
      latest_version: "3.0.0",
    });
  });

  test("a baseline older than the walk: behind is a floor", async () => {
    h.mod("quota", { "main.js": "ancient" });
    link("quota");
    const commits = Array.from({ length: MAX_COMMITS + 5 }, (_, i) => ({
      sha: sha(`c${i}`),
      files: inRepo("quota", { "main.js": `v${i}` }),
    }));
    expect(entry(await check(new FakeGitHub({ "a/herdr-quota": { commits } })), "quota")).toMatchObject({
      status: "update_available",
      commits_behind: MAX_COMMITS,
      commits_behind_capped: true,
    });
  });

  test("a baseline not in history at all, on a short one: update, but behind is unknown", async () => {
    h.mod("quota", { "main.js": "not from here" });
    link("quota");
    expect(entry(await check(fake()), "quota")).toMatchObject({
      status: "update_available",
      commits_behind: null,
      commits_behind_capped: false,
    });
  });

  test("the folder gone from the repo is a per-mod error", async () => {
    h.mod("quota", v3);
    h.mod("gone", { "main.js": "x" });
    link("quota");
    h.json("link", "gone", "a/deleted");
    const m = await check(fake());
    expect(entry(m, "gone")).toMatchObject({ status: "error" });
    expect(entry(m, "gone").message).toContain("isn't in a/deleted");
    expect(entry(m, "quota").status).toBe("up_to_date");
  });

  test("follows --branch", async () => {
    h.mod("quota", v3);
    link("quota", "--branch", "gone");
    expect(entry(await check(fake()), "quota").message).toContain("on gone");
  });

  test("injected files never count", async () => {
    h.mod("quota", { ...v3, ...injected });
    link("quota");
    expect(entry(await check(fake()), "quota").status).toBe("up_to_date");
  });
});

describe("rate limits", () => {
  const limited = () =>
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) },
    });

  test("a clear per-mod error, and the rest of the mods still answer", async () => {
    h.mod("quota", v3);
    h.mod("linked", { "main.js": "x" });
    h.mod("agents", { "main.js": "shipped" });
    h.json("link", "linked", "a/herdr-quota");
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    fake.limited = limited;
    const r = await check(fake);
    for (const name of ["quota", "linked"]) {
      const m = entry(r, name);
      expect(m).toMatchObject({ status: "error", remote_checked: false });
      expect(m.message).toContain("GitHub rate limit reached: try again after");
      expect(m.message).toContain("gh auth login");
    }
    expect(entry(r, "agents").status).toBe("herdr");
    expect(new Date(r.rate_limit_reset!).getTime()).toBeGreaterThan(Date.now());
  });

  test("stops asking once limited", async () => {
    h.mod("quota", v3);
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    fake.limited = limited;
    const gh = client(fake);
    await checkMods(gh);
    const asked = fake.requests.length;
    await expect(gh.searchMods("other")).rejects.toBeInstanceOf(RateLimitError);
    expect(fake.requests.length).toBe(asked);
  });

  test("a 429 and a secondary limit's Retry-After count; another 403 is a plain error", async () => {
    const fake = new FakeGitHub({});
    fake.limited = new Response("slow down", { status: 429 });
    await expect(client(fake).searchMods("x")).rejects.toBeInstanceOf(RateLimitError);
    fake.limited = new Response("wait", { status: 403, headers: { "retry-after": "60" } });
    await expect(client(fake).searchMods("x")).rejects.toBeInstanceOf(RateLimitError);
    fake.limited = new Response("forbidden", { status: 403 });
    const e = await client(fake).searchMods("x").catch((err) => err);
    expect(e).toBeInstanceOf(GitHubError);
    expect(e).not.toBeInstanceOf(RateLimitError);
  });

  test("search being limited doesn't stop the rest of the API", async () => {
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    fake.limited = new Response("rate limit", { status: 403 });
    const gh = client(fake);
    await expect(gh.searchMods("x")).rejects.toBeInstanceOf(RateLimitError);
    fake.limited = null;
    expect(await gh.modFolders("a/herdr-quota")).toEqual(["quota"]);
  });

  test("a limit doesn't wipe the last good answer from --cached", async () => {
    h.mod("quota", v1);
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    await check(fake);
    fake.limited = limited;
    expect(entry(await checkMods(client(fake)), "quota").status).toBe("error");
    const m = entry(await cachedCheck(), "quota");
    expect(m).toMatchObject({ status: "update_available", commits_behind: 2 });
    expect(m.note).toContain("Last check failed");
  });
});

describe("requests", () => {
  test("carry the token if there is one, and nothing about the person", async () => {
    h.mod("quota", v3);
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    await checkMods(client(fake, "tok"));
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const { headers } of fake.requests) {
      expect(headers.get("authorization")).toBe("Bearer tok");
      expect(headers.get("user-agent")).toBe("herdr-mod-updater");
      expect(headers.has("from")).toBe(false);
      expect(JSON.stringify([...headers])).not.toContain("@");
    }
  });

  test("go without a token when there isn't one", async () => {
    h.mod("quota", v3);
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    await check(fake);
    expect(fake.requests.every((r) => !r.headers.has("authorization"))).toBe(true);
  });

  test("a second check is conditional, and pinned URLs aren't asked again", async () => {
    h.mod("quota", v3);
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    await check(fake);
    fake.requests.length = 0;
    await check(fake);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.url.pathname.endsWith("/commits"))).toBe(true);
    expect(fake.notModified).toBe(fake.requests.length);
  });

  test("never more in flight than the limit", async () => {
    const inner = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    let inFlight = 0;
    let peak = 0;
    const gh = new GitHub({
      concurrency: 2,
      fetch: async (url, init) => {
        peak = Math.max(peak, ++inFlight);
        await Bun.sleep(2);
        inFlight--;
        return inner.fetch(url, init);
      },
    });
    await Promise.all(["a", "b", "c", "d", "e", "f"].map((t) => gh.searchMods(t)));
    expect(peak).toBe(2);
  });

  test("a network failure is a per-mod error", async () => {
    h.mod("quota", v3);
    const gh = new GitHub({ fetch: () => Promise.reject(new Error("offline")) });
    expect(entry(await checkMods(gh), "quota").message).toBe("can't reach GitHub: offline");
  });

  test("a damaged cache file is just a miss", async () => {
    h.mod("quota", v3);
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    await check(fake);
    const dir = join(h.hmod, "github-cache");
    for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "{ nope");
    expect(entry(await check(fake), "quota").status).toBe("up_to_date");
  });
});

describe("hmod check --cached", () => {
  test("before any check: local status, no network", async () => {
    h.mod("quota", v3);
    const r = await cachedCheck();
    expect(r).toMatchObject({ cached: true, last_checked: null, authenticated: null });
    expect(entry(r, "quota")).toMatchObject({ status: "unlinked", remote_checked: false, checked_at: null });
  });

  test("repeats the last answer, suggestions and all", async () => {
    h.mod("quota", v1);
    h.mod("forked", { "main.js": "shared" });
    const shared = [{ sha: sha("s"), files: inRepo("forked", { "main.js": "shared" }) }];
    const fake = new FakeGitHub({
      "a/herdr-quota": { commits: history },
      "a/forked": { commits: shared },
      "b/forked": { commits: shared },
    });
    const live = await check(fake);
    fake.requests.length = 0;
    const r = await cachedCheck();
    expect(fake.requests).toEqual([]);
    expect(r.last_checked).toBe(live.last_checked);
    expect(entry(r, "quota")).toEqual(entry(live, "quota"));
    expect(entry(r, "forked").suggestions).toHaveLength(2);
    expect(entry(r, "forked").remote_checked).toBe(true);
  });

  test("sees edits made since", async () => {
    h.mod("quota", v1);
    await check(new FakeGitHub({ "a/herdr-quota": { commits: history } }));
    writeFileSync(join(h.herdr, "mods", "quota", "main.js"), "edited");
    expect(entry(await cachedCheck(), "quota")).toMatchObject({ status: "modified", update_available: true });
  });

  test("an update installed since clears update_available without asking GitHub", async () => {
    h.mod("quota", v1);
    await check(new FakeGitHub({ "a/herdr-quota": { commits: history } }));
    // What an update does: new files on disk, and a baseline to match.
    writeTree(join(h.herdr, "mods", "quota"), v3);
    const all = sources();
    all.quota = { ...all.quota!, commit: sha("three"), files: hashTree(join(h.herdr, "mods", "quota")) };
    writeFileSync(join(h.hmod, "sources.json"), JSON.stringify(all));
    expect(entry(await cachedCheck(), "quota")).toMatchObject({ status: "up_to_date", update_available: false });
  });

  test("drops what was learned about a source that's been unlinked", async () => {
    h.mod("quota", v1);
    await check(new FakeGitHub({ "a/herdr-quota": { commits: history } }));
    h.json("unlink", "quota");
    expect(entry(await cachedCheck(), "quota")).toMatchObject({ status: "unlinked", source: null, update_available: false });
  });

  test("a mod removed since isn't listed, and a damaged check.json is no check at all", async () => {
    h.mod("quota", v1);
    h.mod("other", { "main.js": "x" });
    await check(new FakeGitHub({ "a/herdr-quota": { commits: history } }));
    rmSync(join(h.herdr, "mods", "other"), { recursive: true });
    expect((await cachedCheck()).mods.map((m) => m.name)).toEqual(["quota"]);
    writeFileSync(join(h.hmod, "check.json"), "{ nope");
    expect((await cachedCheck()).last_checked).toBeNull();
  });
});

describe("clone-installed mods", () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
    return p.stdout.toString().trim();
  };

  /** A bare origin, a clone of it, and a second clone to push from, with mods/hcoord installed. */
  function setUp() {
    const origin = join(h.other, "origin.git");
    const work = join(h.other, "work");
    const clone = join(h.other, "clone");
    git(h.other, "init", "--quiet", "--bare", "-b", "main", origin);
    git(h.other, "clone", "--quiet", origin, work);
    git(work, "checkout", "--quiet", "-b", "main");
    writeTree(join(work, "mods", "hcoord"), { "main.js": "hcoord one", "hcoord-path.js": "export const HCOORD = null;" });
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "one");
    git(work, "push", "--quiet", "-u", "origin", "main");
    git(h.other, "clone", "--quiet", origin, clone);
    const source = join(clone, "mods", "hcoord");
    h.mod("hcoord", {
      "main.js": "hcoord one",
      "hcoord-path.js": `export const HCOORD = ["bun", "cli.ts"];`,
      ".hcoord-installed": `${source}\n`,
      ...injected,
    });
    const push = (rel: string, content: string) => {
      writeTree(work, { [rel]: content });
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", "more");
      git(work, "push", "--quiet");
    };
    return { origin, clone, push };
  }

  test("level with origin: up to date, with no GitHub search", async () => {
    const { origin, clone } = setUp();
    const fake = new FakeGitHub({});
    const m = entry(await check(fake), "hcoord");
    expect(fake.requests).toEqual([]);
    expect(m).toMatchObject({
      kind: "clone-installed",
      status: "up_to_date",
      remote_checked: true,
      commits_behind: 0,
      clone: { root: clone, origin, branch: "main" },
    });
  });

  test("origin ahead: update available, and the clone's own branch doesn't move", async () => {
    const { clone, push } = setUp();
    push("src/cli.ts", "new cli");
    push("src/more.ts", "more");
    const before = git(clone, "rev-parse", "HEAD");
    const m = entry(await check(new FakeGitHub({})), "hcoord");
    expect(m).toMatchObject({ status: "update_available", update_available: true, commits_behind: 2 });
    expect(m.note).toContain("hcoord mod install");
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(h.herdr, "mods", "hcoord", "main.js"), "utf8")).toBe("hcoord one");
  });

  test("--cached notices a pull without asking origin", async () => {
    const { clone, push } = setUp();
    push("src/cli.ts", "new cli");
    await check(new FakeGitHub({}));
    expect(entry(await cachedCheck(), "hcoord").status).toBe("update_available");
    git(clone, "pull", "--quiet");
    expect(entry(await cachedCheck(), "hcoord")).toMatchObject({ status: "up_to_date", commits_behind: 0 });
  });

  test("the installed copy lagging the clone is still an update", async () => {
    const { clone } = setUp();
    writeFileSync(join(clone, "mods", "hcoord", "main.js"), "hcoord two");
    git(clone, "add", ".");
    git(clone, "commit", "--quiet", "-m", "local");
    expect(entry(await check(new FakeGitHub({})), "hcoord")).toMatchObject({
      status: "update_available",
      changed: ["main.js"],
    });
  });

  test("an unreachable origin is a per-mod error", async () => {
    const { origin } = setUp();
    rmSync(origin, { recursive: true });
    const m = entry(await check(new FakeGitHub({})), "hcoord");
    expect(m.status).toBe("error");
    expect(m.message).toContain("git fetch failed");
  });

  test("a credential in the origin URL stays out of the output", async () => {
    const { clone } = setUp();
    git(clone, "remote", "set-url", "origin", `file://user:secret@localhost${join(h.other, "origin.git")}`);
    git(clone, "remote", "set-url", "--push", "origin", "unused");
    const m = entry(await check(new FakeGitHub({})), "hcoord");
    expect(JSON.stringify(m)).not.toContain("secret");
  });

  test("not in a git clone: says so, and keeps the local answer", async () => {
    const source = join(h.other, "plain");
    writeTree(source, { "main.js": "same" });
    h.mod("hcoord", { "main.js": "same", ".hcoord-installed": source });
    expect(entry(await check(new FakeGitHub({})), "hcoord")).toMatchObject({
      status: "up_to_date",
      remote_checked: false,
      note: `${source} isn't in a git clone`,
    });
  });
});

describe("the CLI", () => {
  test("check --json goes end to end, and --cached then needs no server", async () => {
    h.mod("quota", { ...v1, ...injected });
    const fake = new FakeGitHub({ "a/herdr-quota": { commits: history } });
    const live = JSON.parse((await runCli(h, fake, "check", "--json")).stdout) as CheckResult;
    expect(live.authenticated).toBe(false);
    expect(entry(live, "quota")).toMatchObject({ status: "update_available", commits_behind: 2 });
    fake.requests.length = 0;
    const cached = JSON.parse((await runCli(h, fake, "check", "--cached", "--json")).stdout) as CheckResult;
    expect(fake.requests).toEqual([]);
    expect(cached).toMatchObject({ cached: true, last_checked: live.last_checked });
    expect(entry(cached, "quota")).toEqual(entry(live, "quota"));
  });

  test("the text form shows how far behind, and suggestions", async () => {
    h.mod("quota", v1);
    h.mod("forked", { "main.js": "shared" });
    const shared = [{ sha: sha("s"), files: inRepo("forked", { "main.js": "shared" }) }];
    const fake = new FakeGitHub({
      "a/herdr-quota": { commits: history },
      "a/forked": { commits: shared },
      "b/forked": { commits: shared },
    });
    const { stdout, code } = await runCli(h, fake, "check");
    expect(code).toBe(0);
    expect(stdout).toContain("2 behind -> 3.0.0");
    expect(stdout).toContain("maybe a/forked mods/forked");
  });

  test("--cached only goes with check, and check takes no arguments", () => {
    expect(h.run("list", "--cached").code).toBe(2);
    expect(h.run("check", "quota").code).toBe(2);
    expect(h.run("check", "--path", "x").code).toBe(2);
  });
});
