/** A manual link must never turn local edits into the baseline. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedCheck, checkMods, type CheckEntry, type CheckResult } from "../src/check.ts";
import { hashTree } from "../src/fsutil.ts";
import { GitHub } from "../src/github.ts";
import type { Sources } from "../src/model.ts";
import { updateAll, updateOne, type ModCheck, type UpdateEvent } from "../src/update.ts";
import { FakeGitHub, inRepo, runCli, sha } from "./fake-github.ts";
import { makeHomes, type Homes } from "./helpers.ts";

const v1 = { "main.js": "one", "mod.json": `{ "title": "Quota", "version": "1.0.0" }` };
const v2 = { "main.js": "two", "mod.json": `{ "title": "Quota", "version": "2.0.0" }` };
const edited = { ...v1, "main.js": "one, with my edits" };
const commits = [
  { sha: sha("two"), files: inRepo("quota", v2) },
  { sha: sha("one"), files: inRepo("quota", v1) },
];

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

const fake = () => new FakeGitHub({ "o/r": { commits } });
const client = (f: FakeGitHub) => new GitHub({ fetch: f.fetch });
const passes: ModCheck = async () => ({ ok: true, output: "" });
const sources = (): Sources => JSON.parse(readFileSync(join(h.hmod, "sources.json"), "utf8"));
const entry = (r: CheckResult): CheckEntry => r.mods.find((m) => m.name === "quota")!;
const local = () => readFileSync(join(h.herdr, "mods", "quota", "main.js"), "utf8");
const backups = () => (existsSync(join(h.hmod, "backups")) ? 1 : 0);

function linked(files: Record<string, string>): void {
  h.mod("quota", files);
  h.json("link", "quota", "o/r");
}

async function runAll(f: FakeGitHub): Promise<UpdateEvent[]> {
  const events: UpdateEvent[] = [];
  await updateAll((e) => events.push(e), { gh: client(f), check: passes });
  return events;
}

describe("hmod link", () => {
  test("stays offline, takes nothing from disk, and says the first check works it out", () => {
    h.mod("quota", edited);
    const r = h.run("link", "quota", "o/r");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("edits are kept safe, the first check works out the version");
    expect(sources().quota).toMatchObject({ commit: null, files: {} });
  });

  test("before any check it's unchecked and says so, even with edits", () => {
    linked(edited);
    expect(h.entry("quota")).toMatchObject({ remote_checked: false, note: expect.stringContaining("first check") });
  });

  test("linking again doesn't repeat the line", () => {
    linked(v1);
    expect(h.run("link", "quota", "o/r").stdout).not.toContain("first check");
  });
});

describe("the first check", () => {
  test("an unedited old version: that commit is the baseline", async () => {
    linked(v1);
    expect(entry(await checkMods(client(fake())))).toMatchObject({
      status: "update_available",
      update_available: true,
      commits_behind: 1,
      source: { commit: sha("one") },
    });
    expect(sources().quota).toMatchObject({ commit: sha("one"), files: hashTree(join(h.herdr, "mods", "quota")) });
    expect(sources().quota!.baseline_assumed).toBeUndefined();
  });

  test("an unedited HEAD: up to date", async () => {
    linked(v2);
    expect(entry(await checkMods(client(fake())))).toMatchObject({
      status: "up_to_date",
      update_available: false,
      commits_behind: 0,
      source: { commit: sha("two") },
    });
  });

  test("an edited mod: modified against HEAD, with an update, and it stays that way", async () => {
    linked(edited);
    const expected = {
      status: "modified",
      update_available: true,
      commits_behind: null,
      remote_checked: true,
      changed: ["main.js", "mod.json"],
      source: { commit: sha("two") },
    };
    expect(entry(await checkMods(client(fake())))).toMatchObject(expected);
    expect(sources().quota).toMatchObject({ commit: sha("two"), baseline_assumed: true });
    expect(entry(await checkMods(client(fake())))).toMatchObject(expected);
    expect(entry(await cachedCheck())).toMatchObject(expected);
  });

  test("a failed network resolve is an error, and the baseline stays unknown", async () => {
    linked(v1);
    const f = fake();
    f.failing = { pattern: /commits/, status: 500 };
    expect(entry(await checkMods(client(f)))).toMatchObject({ status: "error", remote_checked: false, update_available: false });
    expect(sources().quota!.commit).toBeNull();
    expect(entry(await cachedCheck()).status).toBe("error");
  });

  test("a failure after a good check of the same source, before linking again, isn't clean", async () => {
    linked(v1);
    await checkMods(client(fake()));
    h.json("unlink", "quota");
    h.json("link", "quota", "o/r");
    const f = fake();
    f.failing = { pattern: /commits/, status: 500 };
    await checkMods(client(f));
    expect(entry(await cachedCheck()).status).toBe("error");
  });

  test("what an earlier check saved says nothing about a fresh link", async () => {
    linked(edited);
    await checkMods(client(fake()));
    h.json("unlink", "quota");
    h.json("link", "quota", "o/r");
    expect(entry(await cachedCheck())).toMatchObject({ remote_checked: false, update_available: false });
  });
});

describe("updating after a manual link", () => {
  test("--all skips the edited mod and leaves its files alone", async () => {
    linked(edited);
    const events = await runAll(fake());
    expect(events[0]).toMatchObject({ event: "plan", mods: [], skipped: [{ mod: "quota", status: "modified" }] });
    expect(local()).toBe(edited["main.js"]);
    expect(backups()).toBe(0);
  });

  test("--all skips the edited mod through the real CLI", async () => {
    linked(edited);
    const r = await runCli(h, fake(), "update", "--all");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("quota: skipped");
    expect(local()).toBe(edited["main.js"]);
  });

  test("--all still updates an unedited old version", async () => {
    linked(v1);
    const events = await runAll(fake());
    expect(events.at(-1)).toMatchObject({ event: "done", ok: true, updated: ["quota"] });
    expect(local()).toBe("two");
  });

  test("--all skips a mod whose baseline can't be resolved", async () => {
    linked(edited);
    const f = fake();
    f.failing = { pattern: /commits/, status: 500 };
    const events = await runAll(f);
    expect(events[0]).toMatchObject({ event: "plan", mods: [], skipped: [{ mod: "quota", status: "error" }] });
    expect(local()).toBe(edited["main.js"]);
  });

  test("one update before any check resolves first, and an edited mod is refused", async () => {
    linked(edited);
    const r = await updateOne("quota", false, { gh: client(fake()), check: passes });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("--force");
    expect(local()).toBe(edited["main.js"]);
    expect(sources().quota).toMatchObject({ commit: sha("two"), baseline_assumed: true });
  });

  test("one update before any check resolves first, and an unedited mod installs", async () => {
    linked(v1);
    const r = await updateOne("quota", false, { gh: client(fake()), check: passes });
    expect(r).toMatchObject({ ok: true, outcome: "updated", from_commit: sha("one"), to_commit: sha("two") });
  });

  test("a failed resolve refuses, even with --force", async () => {
    linked(edited);
    const f = fake();
    f.failing = { pattern: /commits/, status: 500 };
    const r = await updateOne("quota", true, { gh: client(f), check: passes });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("nothing changed");
    expect(local()).toBe(edited["main.js"]);
    expect(sources().quota!.commit).toBeNull();
    expect(backups()).toBe(0);
  });

  test("--force really installs HEAD over edits on an assumed baseline, with a backup", async () => {
    linked(edited);
    await checkMods(client(fake()));
    const r = await updateOne("quota", true, { gh: client(fake()), check: passes });
    expect(r).toMatchObject({ ok: true, outcome: "updated", from_commit: null, to_commit: sha("two"), keys_changed: false });
    expect(r.backup).not.toBeNull();
    expect(readFileSync(join(r.backup!, "main.js"), "utf8")).toBe(edited["main.js"]);
    expect(local()).toBe("two");
    expect(sources().quota!.baseline_assumed).toBeUndefined();
    expect(entry(await checkMods(client(fake())))).toMatchObject({ status: "up_to_date", update_available: false });
  });

  test("edits undone by hand: the assumed baseline is plain HEAD again", async () => {
    linked(edited);
    await checkMods(client(fake()));
    h.mod("quota", v2);
    expect(entry(await checkMods(client(fake())))).toMatchObject({ status: "up_to_date", update_available: false });
    expect(await updateOne("quota", false, { gh: client(fake()), check: passes })).toMatchObject({ outcome: "up_to_date" });
  });
});
