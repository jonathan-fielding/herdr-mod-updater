/** A linked mod stops updating when its repo changes hands or its history is replaced. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedCheck, checkMods, type CheckEntry } from "../src/check.ts";
import { hashTree } from "../src/fsutil.ts";
import { GitHub } from "../src/github.ts";
import type { LinkLogEntry, ModEntry, SourceRecord, Sources } from "../src/model.ts";
import { confirmOne, updateAll, updateOne, type ModCheck, type UpdateEvent, type UpdateResult } from "../src/update.ts";
import { FakeGitHub, inRepo, runCli, sha, type FakeCommit, type FakeRepo } from "./fake-github.ts";
import { makeHomes, type Homes } from "./helpers.ts";
import { repoIds } from "./repo-ids.ts";

const v1 = { "main.js": "one", "mod.json": `{ "title": "Quota", "version": "1.0.0" }` };
const v2 = { "main.js": "two", "mod.json": `{ "title": "Quota", "version": "2.0.0" }` };
const evil = { "main.js": "evil", "mod.json": `{ "title": "Quota", "version": "2.0.0" }` };
const one: FakeCommit = { sha: sha("one"), files: inRepo("quota", v1) };
const two: FakeCommit = { sha: sha("two"), files: inRepo("quota", v2) };
const history = [two, one];
/** History with nothing of the baseline in it. */
const replaced: FakeCommit[] = [{ sha: sha("evil"), files: inRepo("quota", evil) }];

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

const client = (f: FakeGitHub) => new GitHub({ fetch: f.fetch });
const passes: ModCheck = async () => ({ ok: true, output: "" });
const sources = (): Sources => JSON.parse(readFileSync(join(h.hmod, "sources.json"), "utf8"));
const local = () => readFileSync(join(h.herdr, "mods", "quota", "main.js"), "utf8");
const logged = (): LinkLogEntry[] => readFileSync(join(h.hmod, "links.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const fake = (repo: FakeRepo = { commits: history }, name = "o/r") => new FakeGitHub({ [name]: repo });
const check = async (f: FakeGitHub): Promise<CheckEntry> => (await checkMods(client(f))).mods.find((m) => m.name === "quota")!;
const update = (f: FakeGitHub, force = false): Promise<UpdateResult> => updateOne("quota", force, { gh: client(f), check: passes });

/** Installed at v1, linked to o/r, with `over` on the record. */
function installed(over: Partial<SourceRecord> = {}): void {
  const dir = h.mod("quota", v1);
  const record = { repo: "o/r", ...repoIds("o/r"), path: "mods/quota", branch: null, commit: sha("one"), files: hashTree(dir), ...over };
  Bun.spawnSync(["mkdir", "-p", h.hmod]);
  writeFileSync(join(h.hmod, "sources.json"), JSON.stringify({ quota: record }));
}

/** A link from before hmod stored ids. */
function oldLink(over: Partial<SourceRecord> = {}): void {
  installed({ repo_id: undefined, owner_id: undefined, ...over });
}

async function runAll(f: FakeGitHub): Promise<UpdateEvent[]> {
  const events: UpdateEvent[] = [];
  await updateAll((e) => events.push(e), { gh: client(f), check: passes });
  return events;
}

const planOf = (events: UpdateEvent[]) => events.find((e) => e.event === "plan") as Extract<UpdateEvent, { event: "plan" }>;

/** Held: shown as such, skipped by Update all, refused singly and with --force, and nothing installs. */
async function expectHeld(make: () => FakeGitHub, what: string[], words: string): Promise<void> {
  const m = await check(make());
  expect(m).toMatchObject({ status: "source_changed", update_available: false, source_changed: { what } });
  expect(m.note).toContain(words);
  const before = sources().quota;

  const plan = planOf(await runAll(make()));
  expect(plan.mods).toEqual([]);
  expect(plan.skipped).toEqual([{ mod: "quota", status: "source_changed", reason: m.note! }]);

  for (const force of [false, true]) {
    const r = await update(make(), force);
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain(words);
    expect(r.error).toContain("hmod confirm quota");
  }
  expect(local()).toBe("one");
  expect(existsSync(join(h.hmod, "backups"))).toBe(false);
  expect(sources().quota).toEqual(before!); // Nothing pinned itself.
}

describe("link", () => {
  test("pins the repo's and the owner's ids", async () => {
    h.mod("quota", v1);
    const r = await runCli(h, fake(), "link", "quota", "o/r", "--json");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, linked: true });
    expect(sources().quota).toMatchObject({ ...repoIds("o/r"), commit: null, files: {} });
    expect(logged()[0]).toMatchObject({ event: "link", ...repoIds("o/r") });
  });

  test("an old name pins and stores what it leads to now", async () => {
    h.mod("quota", v1);
    const f = fake({ commits: history }, "o/new");
    f.moved["o/r"] = "o/new";
    const r = await runCli(h, f, "link", "quota", "o/r", "--json");
    expect(JSON.parse(r.stdout).source.repo).toBe("o/new");
    expect(sources().quota).toMatchObject({ repo: "o/new", ...repoIds("o/new") });
  });

  test("a repo that isn't there, or GitHub failing, links nothing", async () => {
    h.mod("quota", v1);
    expect((await runCli(h, fake(), "link", "quota", "o/nope", "--json")).code).toBe(1);
    const down = fake();
    down.failing = { pattern: /./, status: 500 };
    const r = await runCli(h, down, "link", "quota", "o/r", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("500");
    expect(existsSync(join(h.hmod, "sources.json"))).toBe(false);
  });

  test("linking an old link again doesn't pin it", async () => {
    oldLink();
    expect(h.json("link", "quota", "o/r")).toMatchObject({ linked: false });
    expect(sources().quota!.repo_id).toBeUndefined();
  });
});

describe("the repo changing hands", () => {
  const moved = { repo_id: repoIds("o/r").repo_id, owner_id: 999 };

  test("a transfer in place keeps the repo id and changes the owner's", async () => {
    installed();
    await expectHeld(() => fake({ commits: history, ...moved }), ["owner"], "has a new owner");
  });

  test("a transfer GitHub redirects to: the ids of what came back are what count", async () => {
    installed();
    const make = () => {
      const f = fake({ commits: history, ...moved }, "x/r");
      f.moved["o/r"] = "x/r";
      return f;
    };
    await expectHeld(make, ["owner"], "it's x/r now");
    expect(sources().quota!.repo).toBe("o/r"); // Not followed: that's for renames.
  });

  test("a re-registered name has new ids and no baseline", async () => {
    installed();
    await expectHeld(() => fake({ commits: replaced, repo_id: 777, owner_id: 888 }), ["repo_id", "owner"], "registered again");
  });

  test("the same owner making the repo again is caught too", async () => {
    installed();
    await expectHeld(() => fake({ commits: history, repo_id: 777 }), ["repo_id"], "different repo");
  });
});

describe("history", () => {
  test("a force-push with the baseline gone", async () => {
    installed();
    await expectHeld(() => fake({ commits: replaced }), ["history"], "was replaced");
  });

  test("diverged from the baseline", async () => {
    installed();
    await expectHeld(() => fake({ commits: replaced, divergedFrom: [sha("one")] }), ["history"], "was rewritten");
  });

  test("the branch wound back past the baseline", async () => {
    installed({ commit: sha("two") });
    await expectHeld(() => fake({ commits: [one], woundBackFrom: [sha("two")] }), ["history"], "went backwards");
  });

  test("a baseline past the folder's newest commit, but on the branch, is fine", async () => {
    const quiet = { sha: sha("quiet"), files: { ...two.files, "README.md": "elsewhere" } };
    installed({ commit: sha("quiet"), files: hashTree(h.mod("quota", v2)) });
    h.mod("quota", v2);
    const f = new FakeGitHub({ "o/r": { commits: [quiet, two, one] } });
    expect(await check(f)).toMatchObject({ status: "up_to_date" });
  });

  test("ahead and identical pass, and an update moves the baseline on", async () => {
    installed();
    expect(await check(fake())).toMatchObject({ status: "update_available", commits_behind: 1 });
    expect(await update(fake())).toMatchObject({ ok: true, outcome: "updated", to_commit: sha("two") });
    expect(await check(fake())).toMatchObject({ status: "up_to_date" });
    expect(sources().quota).toMatchObject({ commit: sha("two"), ...repoIds("o/r") });
  });

  test("a change after a good check is still caught by the update", async () => {
    installed();
    expect(await check(fake())).toMatchObject({ status: "update_available" });
    expect(await update(fake({ commits: replaced }))).toMatchObject({ ok: false, outcome: "refused" });
    expect(local()).toBe("one");
    const shown = (await cachedCheck()).mods.find((m) => m.name === "quota")!;
    expect(shown).toMatchObject({ status: "source_changed", source_changed: { what: ["history"] } });
  });

  test("Update all asks again for each mod, after its check", async () => {
    installed();
    const f = fake();
    await runAll(f);
    const asked = f.requests.filter((r) => r.url.pathname === "/repos/o/r").length;
    expect(asked).toBe(2);
    expect(f.requests.filter((r) => r.url.pathname.includes("/compare/")).length).toBe(2);
  });
});

describe("a rename", () => {
  const renamed = () => {
    const f = fake({ commits: history }, "o/new");
    f.moved["o/r"] = "o/new";
    return f;
  };
  /** A renamed repo keeps its ids: the link was pinned under the old name. */
  const pinnedOld = () => installed({ ...repoIds("o/new") });

  test("is followed, stored, noted and logged, with no hold", async () => {
    pinnedOld();
    const m = await check(renamed());
    expect(m).toMatchObject({ status: "update_available", source: { repo: "o/new" } });
    expect(m.note).toBe("Renamed on GitHub: o/r is o/new now");
    expect(sources().quota!.repo).toBe("o/new");
    expect(logged()).toEqual([expect.objectContaining({ event: "rename", repo: "o/new", renamed_from: "o/r", via: "hmod" })]);
  });

  test("an account rename is the same thing", async () => {
    installed({ repo: "old-name/r", owner_id: repoIds("o/new").owner_id, repo_id: repoIds("o/new").repo_id });
    const f = fake({ commits: history }, "o/new");
    f.moved["old-name/r"] = "o/new";
    expect(await check(f)).toMatchObject({ status: "update_available", source: { repo: "o/new" } });
  });

  test("the note goes once a check finds nothing new", async () => {
    pinnedOld();
    await check(renamed());
    expect((await check(fake({ commits: history }, "o/new"))).note).toBeNull();
  });

  test("an update follows it too, and says so", async () => {
    pinnedOld();
    const r = await update(renamed());
    expect(r).toMatchObject({ ok: true, outcome: "updated" });
    expect(r.notes).toContain("Renamed on GitHub: o/r is o/new now.");
    expect(sources().quota).toMatchObject({ repo: "o/new", commit: sha("two") });
  });

  test("a rename doesn't excuse the history", async () => {
    pinnedOld();
    const f = fake({ commits: replaced }, "o/new");
    f.moved["o/r"] = "o/new";
    expect(await check(f)).toMatchObject({ status: "source_changed", source_changed: { what: ["history"] } });
    expect(sources().quota!.repo).toBe("o/new");
  });
});

describe("a link with no stored ids", () => {
  test("is held everywhere, asks GitHub nothing, and isn't pinned", async () => {
    oldLink();
    const offline = (m: ModEntry | undefined) => expect(m).toMatchObject({ status: "source_changed", source_changed: { what: ["unconfirmed"] }, note: expect.stringContaining("needs confirming once") });
    offline(h.json("list").mods[0]);
    offline((await cachedCheck()).mods[0]);
    const f = fake();
    offline(await check(f));
    expect(f.requests).toEqual([]);
    await expectHeld(fake, ["unconfirmed"], "needs confirming once");
    expect(sources().quota!.repo_id).toBeUndefined();
  });

  test("names the repo, and doesn't claim it changed", async () => {
    oldLink();
    expect((await check(fake())).note).toBe(
      "This link to o/r needs confirming once: it was made before hmod recorded who owns a repo. Confirm only if you trust o/r.",
    );
  });

  test("with no baseline either, nothing is worked out until it's confirmed", async () => {
    oldLink({ commit: null, files: {} });
    await expectHeld(fake, ["unconfirmed"], "needs confirming once");
    expect(sources().quota).toMatchObject({ commit: null, files: {} });
  });

  test("half an id counts as none", async () => {
    installed({ owner_id: undefined });
    expect(await check(fake())).toMatchObject({ source_changed: { what: ["unconfirmed"] } });
  });
});

describe("Confirm again", () => {
  test("a link with no ids: pins them and keeps the baseline, and only then updates", async () => {
    oldLink();
    const r = await confirmOne("quota", "dialog", { gh: client(fake()) });
    expect(r).toMatchObject({ ok: true, ...repoIds("o/r"), counts_as_edited: false, source: { repo: "o/r", commit: sha("one") } });
    expect(sources().quota).toMatchObject({ ...repoIds("o/r"), commit: sha("one") });
    expect(logged().at(-1)).toMatchObject({ event: "confirm", via: "dialog", ...repoIds("o/r") });
    expect(await check(fake())).toMatchObject({ status: "update_available" });
    expect(await update(fake())).toMatchObject({ ok: true, outcome: "updated" });
  });

  test("a transfer: takes the new owner, and the old hold is gone at once", async () => {
    installed();
    const f = () => fake({ commits: history, owner_id: 999 });
    await check(f());
    await confirmOne("quota", "terminal", { gh: client(f()) });
    expect(sources().quota!.owner_id).toBe(999);
    expect((await cachedCheck()).mods[0]!.status).toBe("up_to_date");
    expect(await check(f())).toMatchObject({ status: "update_available" });
  });

  test("the baseline gone: what's installed isn't blessed, so it counts as edited and Update all leaves it", async () => {
    installed();
    const f = () => fake({ commits: replaced, repo_id: 777, owner_id: 888 });
    const r = await confirmOne("quota", "dialog", { gh: client(f()) });
    expect(r.counts_as_edited).toBe(true);
    expect(sources().quota).toMatchObject({ repo_id: 777, commit: sha("evil"), baseline_assumed: true });
    expect(await check(f())).toMatchObject({ status: "modified", update_available: true });
    expect(planOf(await runAll(f())).mods).toEqual([]);
    expect(await update(f())).toMatchObject({ ok: false, outcome: "refused" }); // Needs --force, which the dialog asks about.
    expect(local()).toBe("one");
  });

  test("local edits never become the baseline", async () => {
    installed();
    writeFileSync(join(h.herdr, "mods", "quota", "main.js"), "my edit");
    await confirmOne("quota", "dialog", { gh: client(fake({ commits: replaced })) });
    expect(sources().quota!.files["main.js"]).not.toBe(hashTree(join(h.herdr, "mods", "quota"))["main.js"]);
    expect(await check(fake({ commits: replaced }))).toMatchObject({ status: "modified" });
  });

  test("files equal to a version in the new history take that version", async () => {
    installed();
    const moved = { sha: sha("moved-one"), files: inRepo("quota", v1) };
    await confirmOne("quota", "dialog", { gh: client(fake({ commits: [{ sha: sha("moved-two"), files: inRepo("quota", v2) }, moved] })) });
    expect(sources().quota).toMatchObject({ commit: sha("moved-one") });
    expect(sources().quota!.baseline_assumed).toBeUndefined();
  });

  test("a failure changes nothing, and it's still held", async () => {
    oldLink();
    const before = sources().quota;
    const down = fake();
    down.failing = { pattern: /./, status: 500 };
    await expect(confirmOne("quota", "dialog", { gh: client(down) })).rejects.toThrow("500");
    expect(sources().quota).toEqual(before!);
    const gone = fake({ commits: history }, "o/other");
    await expect(confirmOne("quota", "dialog", { gh: client(gone) })).rejects.toThrow("any more");
    expect(sources().quota).toEqual(before!);
  });

  test("a mod that isn't linked has nothing to confirm", async () => {
    h.mod("quota", v1);
    await expect(confirmOne("quota", "dialog", { gh: client(fake()) })).rejects.toThrow("isn't linked");
  });

  test("unlinking ends the hold", async () => {
    installed();
    await check(fake({ commits: replaced }));
    h.json("unlink", "quota");
    expect((await cachedCheck()).mods[0]!.status).toBe("unlinked");
  });
});

describe("a baseline that isn't known yet", () => {
  const linkedByHand = () => installed({ commit: null, files: {} });

  test("stays out of Update all, and a single update refuses, while it can't be worked out", async () => {
    linkedByHand();
    const f = () => {
      const down = fake();
      down.failing = { pattern: /\/commits$/, status: 500 };
      return down;
    };
    expect((await check(f())).status).toBe("error");
    expect(planOf(await runAll(f())).mods).toEqual([]);
    expect(await update(f())).toMatchObject({ ok: false, outcome: "refused" });
    expect(sources().quota).toMatchObject({ commit: null, files: {} });
    expect(local()).toBe("one");
  });

  test("once worked out, it goes through the same checks", async () => {
    linkedByHand();
    const f = fake();
    expect(await check(f)).toMatchObject({ status: "update_available", commits_behind: 1 });
    expect(f.requests.some((r) => r.url.pathname.includes(`/compare/${sha("one")}...${sha("two")}`))).toBe(true);
    expect(sources().quota).toMatchObject({ commit: sha("one"), ...repoIds("o/r") });
  });

  test("the ids still come first", async () => {
    linkedByHand();
    expect(await check(fake({ commits: history, owner_id: 999 }))).toMatchObject({ status: "source_changed" });
    expect(sources().quota!.commit).toBeNull();
  });
});

describe("errors from these checks", () => {
  const broken: [string, RegExp, number][] = [
    ["the repo lookup failing", /^\/repos\/o\/r$/, 500],
    ["the comparison failing", /\/compare\//, 502],
  ];

  test.each(broken)("%s is an error for the mod, not a hold, and installs nothing", async (_name, pattern, status) => {
    installed();
    const f = () => {
      const down = fake();
      down.failing = { pattern, status };
      return down;
    };
    const m = await check(f());
    expect(m.status).toBe("error");
    expect(m.message).toContain(String(status));
    expect(planOf(await runAll(f()))).toMatchObject({ mods: [], skipped: [{ status: "error" }] });
    expect(await update(f())).toMatchObject({ ok: false, outcome: "failed" });
    expect(local()).toBe("one");
  });

  test("the rate limit too", async () => {
    installed();
    const f = fake();
    f.limited = new Response("rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" } });
    expect((await check(f)).status).toBe("error");
  });

  test("no network at all", async () => {
    installed();
    const gh = new GitHub({ fetch: async () => { throw new Error("offline"); } });
    const r = await updateOne("quota", false, { gh, check: passes });
    expect(r).toMatchObject({ ok: false, outcome: "failed", error: expect.stringContaining("can't reach GitHub") });
    expect((await checkMods(gh)).mods[0]).toMatchObject({ status: "error" });
  });

  test("a repo that's gone is the usual error", async () => {
    installed();
    expect(await check(fake({ commits: history }, "o/other"))).toMatchObject({ status: "error", message: expect.stringContaining("any more") });
  });

  test("an answer that can't be read is an error, not a pass", async () => {
    installed();
    const gh = new GitHub({ fetch: async () => Response.json({ id: "x" }) });
    expect((await checkMods(gh)).mods[0]!.status).toBe("error");
  });

  test("a hold found earlier stays through an outage, then ends if the check passes again", async () => {
    installed();
    await check(fake({ commits: history, owner_id: 999 }));
    const down = fake();
    down.failing = { pattern: /./, status: 500 };
    const m = await check(down);
    expect(m.status).toBe("source_changed");
    expect(m.note).toContain("Last check failed");
    expect((await cachedCheck()).mods[0]!.status).toBe("source_changed");
    expect((await check(fake())).status).toBe("update_available");
  });
});

describe("the CLI", () => {
  const evilFake = () => fake({ commits: replaced });

  test("hmod update <mod> refuses, with a non-zero exit", async () => {
    installed();
    const r = await runCli(h, evilFake(), "update", "quota", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, outcome: "refused" });
    expect(local()).toBe("one");
  });

  test("--force doesn't get past it", async () => {
    installed();
    expect((await runCli(h, evilFake(), "update", "quota", "--force", "--json")).code).toBe(1);
    expect(local()).toBe("one");
  });

  test("hmod update --all skips it and says why", async () => {
    installed();
    const r = await runCli(h, evilFake(), "update", "--all");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("quota: skipped: The history of o/r was replaced");
    expect(local()).toBe("one");
  });

  test("hmod check and list show it, and hmod confirm ends it", async () => {
    oldLink();
    const checked = await runCli(h, fake(), "check");
    expect(checked.stdout).toContain("source_changed");
    expect(checked.stdout).toContain("needs confirming once");
    expect(h.run("list").stdout).toContain("source_changed");
    const r = await runCli(h, fake(), "confirm", "quota");
    expect(r.stdout).toBe(`confirmed: quota -> o/r (repo id ${repoIds("o/r").repo_id}, owner id ${repoIds("o/r").owner_id})\n`);
    expect(JSON.parse((await runCli(h, fake(), "check", "--json")).stdout).mods[0].status).toBe("update_available");
  });

  test("hmod confirm --dialog is logged as the dialog", async () => {
    oldLink();
    await runCli(h, fake(), "confirm", "quota", "--dialog", "--json");
    expect(logged().at(-1)).toMatchObject({ event: "confirm", via: "dialog" });
  });

  test("a redirect over real HTTP is followed", async () => {
    installed({ ...repoIds("o/new") });
    const f = fake({ commits: history }, "o/new");
    f.moved["o/r"] = "o/new";
    const r = await runCli(h, f, "check", "--json");
    expect(JSON.parse(r.stdout).mods[0]).toMatchObject({ status: "update_available", source: { repo: "o/new" } });
  });
});
