/** What the person gets to decide a link with, what's said when the list isn't everything, and the first update. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedCheck, checkMods, type CheckEntry } from "../src/check.ts";
import { GitHub } from "../src/github.ts";
import type { LinkResult, OfferGapKind, Sources } from "../src/model.ts";
import { confirmOne, updateAll, updateOne, type ModCheck, type UpdateEvent } from "../src/update.ts";
import { FakeGitHub, inRepo, runCli, sha, type FakeCommit, type FakeRepo } from "./fake-github.ts";
import { makeHomes, type Homes } from "./helpers.ts";

const v1 = { "main.js": "one", "mod.json": `{ "title": "Quota", "version": "1.0.0" }` };
const v2 = { "main.js": "two", "mod.json": `{ "title": "Quota", "version": "2.0.0" }` };
const v3 = { "main.js": "three", "mod.json": `{ "title": "Quota", "version": "3.0.0" }` };
const commit = (label: string, files: Record<string, string>): FakeCommit => ({ sha: sha(label), files: inRepo("quota", files) });
const atV2 = [commit("two", v2), commit("one", v1)];
const pastV1 = [commit("three", v3), ...atV2];
const short = (label: string) => sha(label).slice(0, 7);

let h: Homes;
const saveEnv = { HERDR_APP_HOME: process.env.HERDR_APP_HOME, HMOD_HOME: process.env.HMOD_HOME };
beforeEach(() => {
  h = makeHomes();
  process.env.HERDR_APP_HOME = h.herdr;
  process.env.HMOD_HOME = h.hmod;
});
afterEach(() => {
  h.cleanup();
  for (const [key, value] of Object.entries(saveEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const passes: ModCheck = async () => ({ ok: true, output: "" });
const client = (f: FakeGitHub, token: string | null = null) => new GitHub({ fetch: f.fetch, token });
const quota = (r: { mods: CheckEntry[] }) => r.mods.find((m) => m.name === "quota")!;
const signedIn = async (f: FakeGitHub) => quota(await checkMods(client(f, "t0ken")));
const anonymous = async (f: FakeGitHub) => quota(await checkMods(client(f)));
const kinds = (m: CheckEntry): OfferGapKind[] => m.offer_gaps.map((g) => g.kind);
const repos = (m: CheckEntry) => m.suggestions.map((s) => s.repo);
const copies = (n: number, over: FakeRepo = { commits: atV2 }, prefix = "copy") =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}/quota`, over]));
const sources = (): Sources => JSON.parse(readFileSync(join(h.hmod, "sources.json"), "utf8"));
const local = () => readFileSync(join(h.herdr, "mods", "quota", "main.js"), "utf8");

describe("the evidence on an offer", () => {
  test("owner, age, stars and that it isn't a fork, with no request beyond the scan", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2, stars: 12, created_at: "2024-03-09T10:00:00Z" } });
    const [s] = (await signedIn(f)).suggestions;
    expect(s).toMatchObject({ owner: "real", created_at: "2024-03-09T10:00:00Z", fork: false, fork_of: null, stars: 12, commits_past_match: 0 });
    expect(s!.evidence).toEqual(["Owner real · created 2024-03-09 · 12 stars · not a fork", "The mod's folder hasn't changed since that commit."]);
    expect(f.requests.some((r) => r.url.pathname === "/repos/real/quota")).toBe(false);
  });

  test("a fork says what it's a fork of, which takes one request", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "fork/quota": { commits: atV2, forkOf: "real/quota", stars: 1 } });
    const [s] = (await signedIn(f)).suggestions;
    expect(s).toMatchObject({ fork: true, fork_of: "real/quota" });
    expect(s!.evidence[0]).toContain("1 star · fork of real/quota");
    expect(f.requests.filter((r) => r.url.pathname === "/repos/fork/quota")).toHaveLength(1);
  });

  test("a fork whose parent can't be found is still offered, and called a fork", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "fork/quota": { commits: atV2, forkOf: true } });
    const [s] = (await signedIn(f)).suggestions;
    expect(s).toMatchObject({ fork: true, fork_of: null });
    expect(s!.evidence[0]).toContain("a fork, of a repo GitHub didn't name");
  });

  test("says plainly when the folder has moved on from the match, which is what the attack relies on", async () => {
    h.mod("quota", v1);
    const m = await signedIn(new FakeGitHub({ "copy/quota": { commits: pastV1 } }));
    expect(m.suggestions[0]).toMatchObject({ commit: sha("one"), commits_past_match: 2 });
    expect(m.suggestions[0]!.evidence[1]).toContain("has changed since that commit: 2 newer commits");
    expect(m.suggestions[0]!.evidence[1]).toContain("aren't what matched");
  });

  test("one newer commit reads as one", async () => {
    h.mod("quota", v2);
    const m = await signedIn(new FakeGitHub({ "copy/quota": { commits: pastV1 } }));
    expect(m.suggestions[0]!.evidence[1]).toContain("1 newer commit.");
  });

  test("a partial match counts from its own commit", async () => {
    h.mod("quota", { ...v1, "mod.json": `{ "title": "Quota", "version": "edited" }` });
    const m = await signedIn(new FakeGitHub({ "copy/quota": { commits: pastV1 } }));
    expect(m.suggestions[0]).toMatchObject({ exact: false, commit: sha("one"), commits_past_match: 2 });
  });

  test("the terminal shows it too", async () => {
    h.mod("quota", v1);
    const { stdout } = await runCli(h, new FakeGitHub({ "copy/quota": { commits: pastV1, stars: 3 } }), "check");
    expect(stdout).toContain("maybe copy/quota mods/quota");
    expect(stdout).toContain("Owner copy");
    expect(stdout).toContain("has changed since that commit");
    expect(stdout).toContain("this list may be incomplete:");
  });

  test("--cached repeats the evidence and the gaps", async () => {
    h.mod("quota", v2);
    const live = await anonymous(new FakeGitHub({ "real/quota": { commits: atV2 } }));
    expect(quota(await cachedCheck())).toEqual(live);
  });
});

describe("the order", () => {
  test("forks go last, even when a fork is the only exact match", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({
      "a-fork/quota": { commits: atV2, forkOf: "real/quota", stars: 900 },
      "partial/quota": { commits: [commit("p", { ...v2, "mod.json": "{}" })] },
      "real/quota": { commits: atV2 },
    });
    expect(repos(await signedIn(f))).toEqual(["real/quota", "partial/quota", "a-fork/quota"]);
  });

  test("however good the signals, check links nothing", async () => {
    h.mod("quota", v2);
    const m = await signedIn(new FakeGitHub({ "real/quota": { commits: atV2, stars: 90000, created_at: "2015-01-01T00:00:00Z" } }));
    expect(m).toMatchObject({ status: "unlinked", source: null, update_available: false });
    expect(existsSync(join(h.hmod, "sources.json"))).toBe(false);
  });
});

describe("saying when the list may be incomplete", () => {
  test("with a token and everything seen, there's no note and a lone match stands alone", async () => {
    h.mod("quota", v2);
    const m = await signedIn(new FakeGitHub({ "real/quota": { commits: atV2 } }));
    expect(m.offer_gaps).toEqual([]);
    expect(m.suggestions[0]!.why).toBe(`Every file matches commit ${short("two")}`);
  });

  test("without a token a repo with another name is never seen, so a lone match never reads as the only one", async () => {
    h.mod("quota", v2);
    const m = await anonymous(new FakeGitHub({ "real/quota": { commits: atV2 } }));
    expect(kinds(m)).toEqual(["name_search"]);
    expect(m.suggestions[0]!.why).toBe(`Every file matches commit ${short("two")}. Other repos may match too: not all of them were checked`);
  });

  test("the no-token cap on repos searched", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub(copies(25));
    const m = await anonymous(f);
    expect(kinds(m)).toContain("repo_cap");
    expect(m.offer_gaps.find((g) => g.kind === "repo_cap")!.detail).toContain("25 repos came up");
    expect(new Set(f.requests.flatMap((r) => r.url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/commits/)?.[1] ?? [])).size).toBe(20);
    expect(m.suggestions[0]!.why).toContain("do at least 19 other repos");
  });

  test("the 5-offer limit, while the count of exact copies stays true", async () => {
    h.mod("quota", v2);
    const m = await signedIn(new FakeGitHub(copies(7)));
    expect(m.suggestions).toHaveLength(5);
    expect(kinds(m)).toEqual(["offer_cap"]);
    expect(m.offer_gaps[0]!.detail).toContain("Showing 5 of 7");
    expect(m.suggestions[0]!.why).toContain("but so do 6 other repos");
  });

  test("six exact copies can't hide the real repo without the list saying so", async () => {
    h.mod("quota", v2);
    const m = await signedIn(new FakeGitHub({ ...copies(6), "zz-real/quota": { commits: atV2 } }));
    expect(repos(m)).not.toContain("zz-real/quota");
    expect(kinds(m)).toContain("offer_cap");
  });

  test("the search result limit, with a token", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2 } });
    f.searchTotal = 4000;
    const m = await signedIn(f);
    expect(kinds(m)).toEqual(["search_limit"]);
    expect(m.suggestions[0]!.why).toContain("Other repos may match too");
  });

  test("the search result limit, without a token: more hits than one page", async () => {
    h.mod("quota", v2);
    const m = await anonymous(new FakeGitHub(copies(35)));
    expect(kinds(m)).toEqual(expect.arrayContaining(["search_limit"]));
  });

  test("a search GitHub says it cut short", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2 } });
    f.searchIncomplete = true;
    expect(kinds(await signedIn(f))).toEqual(["search_limit"]);
  });

  test("the token path now stops at a cap, likeliest repos first", async () => {
    h.mod("quota", v3);
    const named = copies(45, { commits: [commit("other", { "main.js": "not it" })] }, "named");
    const f = new FakeGitHub({ ...named, "zz-real/quota": { commits: [commit("three", v3)] } });
    const m = await signedIn(f);
    expect(repos(m)).toEqual(["zz-real/quota"]); // Holds a file at HEAD, so it's read ahead of those that only share the name.
    expect(kinds(m)).toEqual(["repo_cap"]);
    expect(m.offer_gaps[0]!.detail).toContain("46 repos could hold this mod");
    const folders = f.requests.filter((r) => r.url.pathname.endsWith("/contents/mods"));
    expect(folders).toHaveLength(40);
  });

  test("a rate limit partway through", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2 }, "slow/quota": { commits: atV2 } });
    const fetch = async (url: string, init: RequestInit) => {
      if (!new URL(url).pathname.startsWith("/repos/slow/quota/contents")) return f.fetch(url, init);
      await Bun.sleep(50); // The other repo's read by now.
      return new Response("rate limit", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" } });
    };
    const m = quota(await checkMods(new GitHub({ fetch, token: "t0ken" })));
    expect(m.status).toBe("unlinked");
    expect(repos(m)).toEqual(["real/quota"]);
    expect(kinds(m)).toEqual(["rate_limit"]);
    expect(m.offer_gaps[0]!.detail).toContain("1 repo");
  });

  test("a rate limit that stops every repo is an error, not an empty list", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2 } });
    const answer = f.handle.bind(f);
    f.handle = (req: Request) => {
      if (new URL(req.url).pathname.startsWith("/repos/")) return new Response("rate limit", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" } });
      return answer(req);
    };
    expect(await signedIn(f)).toMatchObject({ status: "error", suggestions: [] });
  });
});

describe("one failing repo is skipped", () => {
  test("a repo failing with a server error costs only that repo", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2 }, "bad/quota": { commits: atV2 } });
    f.failing = { pattern: /^\/repos\/bad\//, status: 500 };
    const m = await signedIn(f);
    expect(m).toMatchObject({ status: "unlinked", message: null });
    expect(repos(m)).toEqual(["real/quota"]);
    expect(kinds(m)).toEqual(["repo_failed"]);
    expect(m.offer_gaps[0]!.detail).toContain("bad/quota");
    expect(m.suggestions[0]!.why).toContain("Other repos may match too");
  });

  test("the same without a token", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2 }, "bad/quota": { commits: atV2 } });
    f.failing = { pattern: /^\/repos\/bad\/quota\/contents/, status: 500 };
    const m = await anonymous(f);
    expect(repos(m)).toEqual(["real/quota"]);
    expect(kinds(m)).toContain("repo_failed");
  });

  test("a hostile copy with a subfolder too big to read can't stop discovery (finding 8)", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({
      "real/quota": { commits: atV2 },
      "hostile/quota": { commits: [{ sha: sha("h"), files: inRepo("quota", { ...v2, "lib/x.js": "x" }) }] },
    });
    const answer = f.handle.bind(f);
    f.handle = (req: Request) => {
      const res = answer(req);
      if (!/^\/repos\/hostile\/quota\/git\/trees\/(?!HEAD)/.test(new URL(req.url).pathname)) return res;
      return new Response(JSON.stringify({ truncated: true, tree: [] }), { status: 200 });
    };
    const m = await signedIn(f);
    expect(repos(m)).toEqual(["real/quota"]);
    expect(kinds(m)).toEqual(["repo_failed"]);
  });

  test("a repo whose tree can't be read is skipped on the token path too", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2 }, "bad/quota": { commits: atV2 } });
    f.failing = { pattern: /^\/repos\/bad\/quota\/git\/trees\/HEAD/, status: 500 };
    const m = await signedIn(f);
    expect(repos(m)).toEqual(["real/quota"]);
    expect(kinds(m)).toEqual(["repo_failed"]);
  });

  test("many failures are counted, not all named", async () => {
    h.mod("quota", v2);
    const f = new FakeGitHub({ "real/quota": { commits: atV2 }, ...copies(5, { commits: atV2 }, "bad") });
    f.failing = { pattern: /^\/repos\/bad\d\//, status: 500 };
    expect((await signedIn(f)).offer_gaps[0]!.detail).toContain("and 2 repos more");
  });

  test("offers saved by an older hmod don't pass as complete", async () => {
    h.mod("quota", v2);
    const offer = { repo: "a/quota", path: "mods/quota", why: "Every file matches commit abc", exact: true, commit: "abc" };
    Bun.spawnSync(["mkdir", "-p", h.hmod]);
    writeFileSync(join(h.hmod, "check.json"), JSON.stringify({ last_checked: null, mods: { quota: { checked_at: "2026-01-01", error: null, upstream: null, clone: null, suggestions: [offer] } } }));
    expect(kinds(quota(await cachedCheck()))).toEqual(["old_check"]);
  });
});

describe("what's being trusted", () => {
  test("hmod link says it, naming the owner", async () => {
    h.mod("quota", v1);
    const { stdout } = await runCli(h, new FakeGitHub({ "o/r": { commits: atV2 } }), "link", "quota", "o/r");
    expect(stdout).toContain("o, and anyone who later controls o/r, can run code on your computer.");
    expect(stdout).toContain("hmod update quota");
  });

  test("hmod confirm says it, naming whoever owns the repo now", async () => {
    h.mod("quota", v1);
    h.json<LinkResult>("link", "quota", "o/r");
    const f = new FakeGitHub({ "new/r": { commits: atV2 } });
    f.moved["o/r"] = "new/r";
    const r = await confirmOne("quota", "terminal", { gh: client(f) });
    expect(r.trust).toBe("new, and anyone who later controls new/r, can run code on your computer.");
  });
});

describe("the first update", () => {
  const run = async (f: FakeGitHub) => {
    const events: UpdateEvent[] = [];
    await updateAll((e) => events.push(e), { gh: client(f), check: passes });
    return events;
  };
  const plan = (events: UpdateEvent[]) => events.find((e) => e.event === "plan") as Extract<UpdateEvent, { event: "plan" }>;
  const newer = () => new FakeGitHub({ "o/r": { commits: atV2 } });
  const linked = () => {
    h.mod("quota", v1);
    h.json<LinkResult>("link", "quota", "o/r");
  };

  test("after a link it's left out of Update all, saying why, and nothing installs", async () => {
    linked();
    const m = await anonymous(newer());
    expect(m).toMatchObject({ status: "update_available", first_update_pending: true });
    expect(m.note).toContain("First update from o/r");
    const p = plan(await run(newer()));
    expect(p.mods).toEqual([]);
    expect(p.skipped).toEqual([{ mod: "quota", status: "update_available", reason: m.note! }]);
    expect(local()).toBe("one");
  });

  test("hmod update --all skips it through the real CLI, and hmod update <mod> installs it", async () => {
    linked();
    const all = await runCli(h, newer(), "update", "--all");
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("quota: skipped: First update from o/r");
    expect(local()).toBe("one");
    process.env.HMOD_HERDR_APP = "/usr/bin/true"; // Stands in for herdr-app check.
    try {
      expect((await runCli(h, newer(), "update", "quota")).code).toBe(0);
    } finally {
      delete process.env.HMOD_HERDR_APP;
    }
    expect(local()).toBe("two");
  });

  test("a single update is allowed, and after one success it behaves normally", async () => {
    linked();
    await anonymous(newer());
    const r = await updateOne("quota", false, { gh: client(newer()), check: passes });
    expect(r).toMatchObject({ ok: true, outcome: "updated" });
    expect(local()).toBe("two");
    expect(sources().quota!.first_update_pending).toBeUndefined();

    const later = new FakeGitHub({ "o/r": { commits: pastV1 } });
    expect(await anonymous(later)).toMatchObject({ status: "update_available", first_update_pending: false, note: null });
    expect(plan(await run(later)).mods).toEqual(["quota"]);
    expect(local()).toBe("three");
  });

  test("Update on a mod with nothing newer doesn't use the first update up", async () => {
    h.mod("quota", v2);
    h.json<LinkResult>("link", "quota", "o/r");
    await anonymous(newer());
    expect(await updateOne("quota", false, { gh: client(newer()), check: passes })).toMatchObject({ outcome: "up_to_date" });
    expect(sources().quota!.first_update_pending).toBe(true);
    expect(plan(await run(new FakeGitHub({ "o/r": { commits: pastV1 } }))).mods).toEqual([]);
    expect(local()).toBe("two");
  });

  test("a failed update doesn't use it up", async () => {
    linked();
    await anonymous(newer());
    const fails: ModCheck = async () => ({ ok: false, output: "no" });
    expect(await updateOne("quota", false, { gh: client(newer()), check: fails })).toMatchObject({ ok: false });
    expect(sources().quota!.first_update_pending).toBe(true);
  });

  test("the same goes after Confirm again", async () => {
    linked();
    await anonymous(newer());
    await updateOne("quota", false, { gh: client(newer()), check: passes });
    expect(sources().quota!.first_update_pending).toBeUndefined();

    const taken = new FakeGitHub({ "o/r": { commits: pastV1, owner_id: 999 } });
    expect(await anonymous(taken)).toMatchObject({ status: "source_changed" });
    await confirmOne("quota", "dialog", { gh: client(taken) });
    expect(sources().quota!.first_update_pending).toBe(true);
    expect(plan(await run(taken)).mods).toEqual([]);
    expect(local()).toBe("two");
    expect(await updateOne("quota", false, { gh: client(taken), check: passes })).toMatchObject({ outcome: "updated" });
    expect(local()).toBe("three");
  });

  test("a link made while Update all runs isn't swept up by it", async () => {
    h.mod("quota", v1);
    h.mod("other", { "main.js": "one", "mod.json": `{ "title": "Other" }` });
    const f = new FakeGitHub({ "o/r": { commits: atV2 } });
    h.json<LinkResult>("link", "quota", "o/r");
    const record = sources().quota!;
    delete record.first_update_pending;
    await Bun.write(join(h.hmod, "sources.json"), JSON.stringify({ quota: record }));
    const gh = client(f);
    const events: UpdateEvent[] = [];
    await updateAll(
      (e) => {
        if (e.event !== "plan") return events.push(e);
        // As if the person relinked after the plan was made.
        record.first_update_pending = true;
        writeFileSync(join(h.hmod, "sources.json"), JSON.stringify({ quota: record }));
      },
      { gh, check: passes },
    );
    expect(events.find((e) => e.event === "result")).toMatchObject({ result: { outcome: "refused" } });
    expect(local()).toBe("one");
  });

  test("an old record without the field updates as before", async () => {
    linked();
    await anonymous(newer());
    const all = sources();
    delete all.quota!.first_update_pending;
    writeFileSync(join(h.hmod, "sources.json"), JSON.stringify(all));
    expect(plan(await run(newer())).mods).toEqual(["quota"]);
  });
});
