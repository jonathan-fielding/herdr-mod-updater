import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashTree, withLock } from "../src/fsutil.ts";
import { GitHub, type TreeEntry } from "../src/github.ts";
import type { Sources } from "../src/model.ts";
import { apply, installable, permissionsIn, updateAll, updateOne, type ModCheck, type UpdateEvent } from "../src/update.ts";
import { FakeGitHub, inRepo, runCli, sha, type FakeCommit } from "./fake-github.ts";
import { makeHomes, writeTree, type Homes } from "./helpers.ts";

const injected = { "gpui-kit.d.ts": "// injected", "jsconfig.json": "{}", ".DS_Store": "finder" };
const v1 = {
  "main.js": "one",
  "mod.json": `{ "title": "Quota", "version": "1.0.0" }`,
  "lib/util.js": "util one",
  "old.js": "going away",
  "same.js": "never changes",
};
const v2 = {
  "main.js": "two",
  "mod.json": `{ "title": "Quota", "version": "2.0.0" }`,
  "lib/util.js": "util two",
  "new.js": "just arrived",
  "same.js": "never changes",
};

let h: Homes;
const saveEnv = { HERDR_APP_HOME: process.env.HERDR_APP_HOME, HMOD_HOME: process.env.HMOD_HOME, HMOD_HERDR_APP: process.env.HMOD_HERDR_APP };
beforeEach(() => {
  h = makeHomes(["agents"]);
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

const sources = (): Sources => JSON.parse(readFileSync(join(h.hmod, "sources.json"), "utf8"));
const installedFile = (mod: string, rel: string) => readFileSync(join(h.herdr, "mods", mod, rel), "utf8");
const inMod = (mod: string, rel: string) => existsSync(join(h.herdr, "mods", mod, rel));
const backups = () => (existsSync(join(h.hmod, "backups")) ? readdirSync(join(h.hmod, "backups")).sort() : []);
const staging = () => (existsSync(join(h.hmod, "staging")) ? readdirSync(join(h.hmod, "staging")) : []);

/** Installs `files` as `name`, linked to o/<repo> at `commit`. Merges into sources.json. */
function installLinked(name: string, files: Record<string, string>, commit: string | null = sha("one"), repo = "o/r"): string {
  const dir = h.mod(name, files);
  mkdirSync(h.hmod, { recursive: true });
  const path = join(h.hmod, "sources.json");
  const all = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  all[name] = { repo, path: `mods/${name}`, branch: null, commit, files: hashTree(dir) };
  writeFileSync(path, JSON.stringify(all));
  return dir;
}

function history(name: string, extra: Partial<FakeCommit> = {}): FakeCommit[] {
  return [
    { sha: sha("two"), files: inRepo(name, v2), ...extra },
    { sha: sha("one"), files: inRepo(name, v1) },
  ];
}

const fakeFor = (name: string, extra: Partial<FakeCommit> = {}) => new FakeGitHub({ "o/r": { commits: history(name, extra) } });
const client = (fake: FakeGitHub) => new GitHub({ fetch: fake.fetch });

/** Records the folders it's asked about. `verdicts` answers in order; after that it passes. */
function checker(...verdicts: boolean[]): ModCheck & { dirs: string[] } {
  const dirs: string[] = [];
  const check = async (dir: string) => {
    dirs.push(dir);
    const ok = verdicts.shift() ?? true;
    return { ok, output: ok ? "check passed" : "boom at main.js:1" };
  };
  return Object.assign(check, { dirs });
}

describe("updating a linked mod", () => {
  test("installs the new version and moves the baseline", async () => {
    installLinked("quota", { ...v1, ...injected });
    const check = checker();
    const r = await updateOne("quota", false, { gh: client(fakeFor("quota")), check });
    expect(r).toMatchObject({
      ok: true,
      outcome: "updated",
      error: null,
      from_commit: sha("one"),
      to_commit: sha("two"),
      from_version: "1.0.0",
      to_version: "2.0.0",
      added: ["new.js"],
      removed: ["old.js"],
      overwritten: [],
    });
    expect([...r.changed].sort()).toEqual(["lib/util.js", "main.js", "mod.json"]);
    expect(installedFile("quota", "main.js")).toBe("two");
    expect(installedFile("quota", "new.js")).toBe("just arrived");
    expect(inMod("quota", "old.js")).toBe(false);
    expect(sources().quota).toMatchObject({ commit: sha("two") });
    expect(Object.keys(sources().quota!.files).sort()).toEqual(["lib/util.js", "main.js", "mod.json", "new.js", "same.js"]);
    expect(h.entry("quota").status).toBe("up_to_date");
    expect(staging()).toEqual([]);
  });

  test("checks the staged copy outside Herdr's mods folder, then the installed one", async () => {
    installLinked("quota", v1);
    const check = checker();
    await updateOne("quota", false, { gh: client(fakeFor("quota")), check });
    expect(check.dirs).toHaveLength(2);
    expect(check.dirs[0]!.startsWith(join(h.hmod, "staging"))).toBe(true);
    expect(check.dirs[0]!.endsWith("/quota")).toBe(true);
    expect(check.dirs[1]).toBe(join(h.herdr, "mods", "quota"));
  });

  test("keeps injected files, dotfiles, and files that were never in the baseline", async () => {
    const dir = installLinked("quota", v1);
    writeTree(dir, { ...injected, "mine.txt": "the person's" });
    const fake = fakeFor("quota");
    const r = await updateOne("quota", true, { gh: client(fake), check: checker() });
    expect(r.outcome).toBe("updated");
    expect(installedFile("quota", "mine.txt")).toBe("the person's");
    for (const [rel, content] of Object.entries(injected)) expect(installedFile("quota", rel)).toBe(content);
  });

  test("doesn't install what upstream has of injected names or dotfiles", async () => {
    const dir = installLinked("quota", v1);
    writeTree(dir, injected);
    const upstream = { ...v2, "jsconfig.json": "upstream's", ".DS_Store": "upstream's" };
    const fake = new FakeGitHub({ "o/r": { commits: [{ sha: sha("two"), files: inRepo("quota", upstream) }] } });
    expect((await updateOne("quota", false, { gh: client(fake), check: checker() })).outcome).toBe("updated");
    expect(installedFile("quota", "jsconfig.json")).toBe("{}");
    expect(installedFile("quota", ".DS_Store")).toBe("finder");
    expect(Object.keys(sources().quota!.files)).not.toContain("jsconfig.json");
  });

  test("a folder emptied by the update goes; one still holding something stays", async () => {
    const dir = installLinked("quota", { ...v1, "gone/a.js": "a", "kept/a.js": "a" });
    writeTree(dir, { "kept/.note": "mine" });
    const r = await updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker() });
    expect(r.removed.sort()).toEqual(["gone/a.js", "kept/a.js", "old.js"]);
    expect(inMod("quota", "gone")).toBe(false);
    expect(installedFile("quota", "kept/.note")).toBe("mine");
  });

  test("nothing newer: changes nothing and makes no backup", async () => {
    installLinked("quota", v2, sha("two"));
    const check = checker();
    const r = await updateOne("quota", false, { gh: client(fakeFor("quota")), check });
    expect(r).toMatchObject({ ok: true, outcome: "up_to_date", to_commit: sha("two") });
    expect(check.dirs).toEqual([]);
    expect(backups()).toEqual([]);
  });

  test("the folder moved from a file to a folder and back without losing anything", async () => {
    installLinked("quota", { "main.js": "one", lib: "was a file", "pkg/a.js": "was a folder" });
    const upstream = { "main.js": "two", "lib/a.js": "now a folder", pkg: "now a file" };
    const fake = new FakeGitHub({ "o/r": { commits: [{ sha: sha("two"), files: inRepo("quota", upstream) }] } });
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r.outcome).toBe("updated");
    expect(installedFile("quota", "lib/a.js")).toBe("now a folder");
    expect(installedFile("quota", "pkg")).toBe("now a file");
  });

  test("main.js goes in last", () => {
    const from = join(h.other, "from");
    const dir = join(h.other, "dest");
    writeTree(from, { "main.js": "new" });
    writeTree(dir, { "main.js": "old" });
    // z.js isn't there to copy, so getting past it is the only way to reach main.js.
    expect(() => apply(from, dir, ["main.js", "z.js"], [])).toThrow();
    expect(readFileSync(join(dir, "main.js"), "utf8")).toBe("old");
    apply(from, dir, ["main.js"], []);
    expect(readFileSync(join(dir, "main.js"), "utf8")).toBe("new");
  });
});

describe("when the new version fails", () => {
  test("a failed check on the staged copy changes nothing", async () => {
    installLinked("quota", { ...v1, ...injected });
    const before = hashTree(join(h.herdr, "mods", "quota"));
    const baseline = sources().quota;
    const r = await updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker(false) });
    expect(r).toMatchObject({ ok: false, outcome: "failed", backup: null });
    expect(r.error).toContain("nothing changed");
    expect(r.error).toContain("boom at main.js:1");
    expect(hashTree(join(h.herdr, "mods", "quota"))).toEqual(before);
    expect(sources().quota).toEqual(baseline!);
    expect(backups()).toEqual([]);
    expect(staging()).toEqual([]);
  });

  test("a failed check once installed restores the backup", async () => {
    const dir = installLinked("quota", v1);
    writeTree(dir, injected);
    const before = hashTree(dir);
    const baseline = sources().quota;
    const r = await updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker(true, false) });
    expect(r).toMatchObject({ ok: false, outcome: "rolled_back", backup: null });
    expect(r.error).toContain("boom at main.js:1");
    expect(r.error).toContain("previous version is back");
    expect(hashTree(dir)).toEqual(before);
    expect(installedFile("quota", "old.js")).toBe("going away");
    expect(inMod("quota", "new.js")).toBe(false);
    expect(installedFile("quota", "gpui-kit.d.ts")).toBe("// injected");
    expect(sources().quota).toEqual(baseline!);
    expect(h.entry("quota").status).toBe("up_to_date");
  });

  test("failed attempts don't crowd out older backups", async () => {
    installLinked("quota", v1);
    const old = join(h.hmod, "backups", "quota-2020-01-01T00-00-00-000Z");
    writeTree(old, v1);
    for (let i = 0; i < 4; i++) await updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker(true, false) });
    expect(backups()).toEqual(["quota-2020-01-01T00-00-00-000Z"]);
  });

  test("a download that fails changes nothing", async () => {
    installLinked("quota", v1);
    const fake = fakeFor("quota");
    fake.failing = { pattern: /git\/blobs/, status: 500 };
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(installedFile("quota", "main.js")).toBe("one");
    expect(staging()).toEqual([]);
  });

  test("bytes that don't match their SHA are refused", async () => {
    installLinked("quota", v1);
    const fake = fakeFor("quota");
    fake.corrupt = () => Buffer.from("tampered").toString("base64");
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.error).toContain("doesn't match its SHA");
    expect(installedFile("quota", "main.js")).toBe("one");
  });

  test("the mod's folder has left the repo", async () => {
    installLinked("quota", v1);
    const fake = new FakeGitHub({ "o/r": { commits: [{ sha: sha("two"), files: { "README.md": "moved" } }] } });
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.error).toContain("isn't in o/r");
  });
});

describe("refusing unsafe content", () => {
  const blob = (path: string): TreeEntry => ({ path, mode: "100644", type: "blob", sha: "a" });

  test.each([
    ["../evil.js"],
    ["a/../../evil.js"],
    ["/etc/passwd"],
    ["a//b.js"],
    ["./a.js"],
    ["a\\..\\b.js"],
    ["a\0b.js"],
  ])("a path like %j", (path) => {
    expect(() => installable([blob(path)])).toThrow("outside the mod's folder");
  });

  test("ignored paths are checked too, then left out", () => {
    expect(() => installable([blob(".x/../../evil")])).toThrow("outside");
    expect([...installable([blob("a.js"), blob(".hidden"), blob("node_modules/x.js")]).keys()]).toEqual(["a.js"]);
  });

  const odd = (entry: TreeEntry) => ({ oddities: { "mods/quota": [entry] } });

  test.each([
    ["symlink", { path: "link", mode: "120000", type: "blob", sha: "a" }, "symlink"],
    ["submodule", { path: "sub", mode: "160000", type: "commit", sha: "a" }, "submodule"],
    ["escaping path", { path: "../../evil.js", mode: "100644", type: "blob", sha: "a" }, "outside"],
  ])("a %s upstream stops the update before any download", async (_, entry, words) => {
    installLinked("quota", v1);
    const fake = fakeFor("quota", odd(entry));
    const check = checker();
    const r = await updateOne("quota", false, { gh: client(fake), check });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain(words);
    expect(check.dirs).toEqual([]);
    expect(fake.requests.some((q) => q.url.pathname.includes("/git/blobs/"))).toBe(false);
    expect(installedFile("quota", "main.js")).toBe("one");
    expect(existsSync(join(h.other, "..", "evil.js"))).toBe(false);
  });

  test("a local symlink on the way doesn't get written through", async () => {
    const dir = installLinked("quota", { "main.js": "one", "mod.json": v1["mod.json"] });
    const outside = join(h.other, "outside");
    writeTree(outside, { "util.js": "outside" });
    symlinkSync(outside, join(dir, "lib"));
    const r = await updateOne("quota", true, { gh: client(fakeFor("quota")), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("symlink");
    expect(readFileSync(join(outside, "util.js"), "utf8")).toBe("outside");
    expect(installedFile("quota", "main.js")).toBe("one");
  });

  test("a mod folder that's a symlink is refused", async () => {
    const real = join(h.other, "real-quota");
    writeTree(real, v1);
    symlinkSync(real, join(h.herdr, "mods", "quota"));
    mkdirSync(h.hmod, { recursive: true });
    writeFileSync(
      join(h.hmod, "sources.json"),
      JSON.stringify({ quota: { repo: "o/r", path: "mods/quota", branch: null, commit: sha("one"), files: hashTree(real) } }),
    );
    const r = await updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(readFileSync(join(real, "main.js"), "utf8")).toBe("one");
  });

  test("a person's file where upstream wants a folder is refused, not deleted", async () => {
    const dir = installLinked("quota", { "main.js": "one" });
    writeTree(dir, { lib: "mine" });
    const r = await updateOne("quota", true, { gh: client(fakeFor("quota")), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(installedFile("quota", "lib")).toBe("mine");
  });

  test("a damaged baseline can't delete outside the folder", async () => {
    const dir = installLinked("quota", v1);
    const victim = join(h.herdr, "mods", "victim.txt");
    writeFileSync(victim, "safe");
    const all = sources();
    all.quota!.files["../victim.txt"] = "abc";
    writeFileSync(join(h.hmod, "sources.json"), JSON.stringify(all));
    const r = await updateOne("quota", true, { gh: client(fakeFor("quota")), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(readFileSync(victim, "utf8")).toBe("safe");
    expect(hashTree(dir)["main.js"]).toBeDefined();
  });
});

describe("local edits", () => {
  test("refused without --force, before asking GitHub", async () => {
    const dir = installLinked("quota", v1);
    writeFileSync(join(dir, "main.js"), "my edit");
    const fake = fakeFor("quota");
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("main.js");
    expect(r.error).toContain("--force");
    expect(installedFile("quota", "main.js")).toBe("my edit");
    expect(fake.requests).toEqual([]);
    expect(backups()).toEqual([]);
  });

  test("--force installs, and the backup still has the edits", async () => {
    const dir = installLinked("quota", v1);
    writeFileSync(join(dir, "main.js"), "my edit");
    writeFileSync(join(dir, "old.js"), "edited, and gone upstream");
    const r = await updateOne("quota", true, { gh: client(fakeFor("quota")), check: checker() });
    expect(r).toMatchObject({ ok: true, outcome: "updated" });
    expect(r.overwritten.sort()).toEqual(["main.js", "old.js"]);
    expect(installedFile("quota", "main.js")).toBe("two");
    expect(inMod("quota", "old.js")).toBe(false);
    expect(readFileSync(join(r.backup!, "main.js"), "utf8")).toBe("my edit");
    expect(readFileSync(join(r.backup!, "old.js"), "utf8")).toBe("edited, and gone upstream");
  });

  test("--force with nothing newer keeps the edits", async () => {
    const dir = installLinked("quota", v2, sha("two"));
    writeFileSync(join(dir, "main.js"), "my edit");
    const r = await updateOne("quota", true, { gh: client(fakeFor("quota")), check: checker() });
    expect(r.outcome).toBe("up_to_date");
    expect(installedFile("quota", "main.js")).toBe("my edit");
  });
});

describe("backups", () => {
  test("hold the whole folder, hidden files too", async () => {
    installLinked("quota", { ...v1, ...injected });
    const r = await updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker() });
    expect(r.backup).toMatch(new RegExp(`^${h.hmod}/backups/quota-\\d{4}-.*Z$`));
    expect(readFileSync(join(r.backup!, ".DS_Store"), "utf8")).toBe("finder");
    expect(readFileSync(join(r.backup!, "main.js"), "utf8")).toBe("one");
  });

  test("keeps the last 3, and leaves a mod with a longer name alone", async () => {
    installLinked("quota", v1);
    const stamps = ["2020-01-01", "2020-01-02", "2020-01-03"].map((d) => `quota-${d}T00-00-00-000Z`);
    const others = ["quota-bar-2020-01-01T00-00-00-000Z", "quota-notes"];
    for (const name of [...stamps, ...others]) writeTree(join(h.hmod, "backups", name), { "main.js": "x" });
    const r = await updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker() });
    const left = backups();
    expect(left).toEqual([...others, stamps[1]!, stamps[2]!, r.backup!.split("/").pop()!].sort());
  });
});

describe("what the result tells the person", () => {
  const withKeys = (keys: string) => ({ ...inRepo("quota", v2), "keys.json": keys });

  test("the repo's keys.json changed: said, and not merged", async () => {
    installLinked("quota", v1);
    const fake = new FakeGitHub({
      "o/r": {
        commits: [
          { sha: sha("two"), files: withKeys(`{ "new": 1 }`) },
          { sha: sha("one"), files: { ...inRepo("quota", v1), "keys.json": `{ "old": 1 }` } },
        ],
      },
    });
    writeFileSync(join(h.herdr, "keys.json"), "{}");
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r.keys_changed).toBe(true);
    expect(r.notes.join(" ")).toContain("keys.json changed");
    expect(readFileSync(join(h.herdr, "keys.json"), "utf8")).toBe("{}");
    expect(inMod("quota", "keys.json")).toBe(false);
  });

  test("keys.json the same, or absent: nothing to say", async () => {
    installLinked("quota", v1);
    const fake = new FakeGitHub({
      "o/r": {
        commits: [
          { sha: sha("two"), files: withKeys("{}") },
          { sha: sha("one"), files: { ...inRepo("quota", v1), "keys.json": "{}" } },
        ],
      },
    });
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r.keys_changed).toBe(false);
    expect(r.notes).toEqual([]);
  });

  test("no recorded commit to compare with: says it can't tell", async () => {
    installLinked("quota", v1, null);
    const fake = new FakeGitHub({ "o/r": { commits: [{ sha: sha("two"), files: withKeys("{}") }] } });
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r.keys_changed).toBeNull();
    expect(r.notes.join(" ")).toContain("can't compare");
  });

  test("reports only permissions the old version lacked", async () => {
    installLinked("quota", { ...v1, "main.js": `await exec("ls");` });
    const upstream = {
      ...v2,
      "main.js": `await exec("ls");\nconst r = await fetch("https://example.com");\nawait hc(["ls"]);`,
      "lib/util.js": "await watchFolder(dir);",
    };
    const fake = new FakeGitHub({ "o/r": { commits: [{ sha: sha("two"), files: inRepo("quota", upstream) }] } });
    const r = await updateOne("quota", false, { gh: client(fake), check: checker() });
    expect(r.new_permissions).toEqual(["hc", "fetch", "watchFolder"]);
    expect(r.notes.join(" ")).toContain("reaches the network");
  });

  test("permission scan: imports count, regex exec and other words don't", () => {
    const dir = join(h.other, "scan");
    writeTree(dir, { "a.js": `import { exec as run, watchFolder } from "herdr";` });
    expect(permissionsIn(dir)).toEqual(["exec", "watchFolder"]);
    const quiet = join(h.other, "quiet");
    writeTree(quiet, { "a.js": `/x/.exec(s); prefetch(); arch(1); const hc2 = 1;`, "notes.md": "fetch(" });
    expect(permissionsIn(quiet)).toEqual([]);
  });
});

describe("mods hmod won't update", () => {
  test("shipped with Herdr", async () => {
    h.mod("agents", { "main.js": "shipped" });
    const fake = fakeFor("agents");
    const r = await updateOne("agents", false, { gh: client(fake), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("ships with Herdr");
    expect(installedFile("agents", "main.js")).toBe("shipped");
  });

  test("even with --force", async () => {
    h.mod("agents", { "main.js": "shipped" });
    expect((await updateOne("agents", true, { gh: client(fakeFor("agents")), check: checker() })).outcome).toBe("refused");
  });

  test("unlinked", async () => {
    h.mod("quota", v1);
    const r = await updateOne("quota", true, { gh: client(fakeFor("quota")), check: checker() });
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("no source known");
  });

  test("the person's own clone of a mod", async () => {
    h.mod("my-files", { "main.js": "x", "mod.json": JSON.stringify({ cloned_from: { name: "files", version: "1" } }) });
    const r = await updateOne("my-files", true, { gh: client(fakeFor("my-files")), check: checker() });
    expect(r.outcome).toBe("refused");
  });

  test("a mod that isn't there throws", async () => {
    await expect(updateOne("nope", false, { gh: client(fakeFor("nope")), check: checker() })).rejects.toThrow("no mod called nope");
  });
});

describe("update --all", () => {
  function mixedHome(): FakeGitHub {
    const repos: Record<string, { commits: FakeCommit[] }> = {};
    for (const name of ["c-good", "a-good", "b-bad", "edited"]) {
      installLinked(name, v1, sha("one"), `o/${name}`);
      repos[`o/${name}`] = { commits: history(name) };
    }
    installLinked("level", v2, sha("two"), "o/level");
    repos["o/level"] = { commits: history("level") };
    writeFileSync(join(h.herdr, "mods", "edited", "main.js"), "my edit");
    h.mod("agents", { "main.js": "shipped" });
    h.mod("loose", { "main.js": "from nowhere" });
    h.mod("broken", { "main.js": "x", "mod.json": "{ nope" });
    return new FakeGitHub(repos);
  }

  async function collect(fake: FakeGitHub, check: ModCheck) {
    const events: UpdateEvent[] = [];
    const { ok } = await updateAll((e) => events.push(e), { gh: client(fake), check });
    return { ok, events, done: events.at(-1) as Extract<UpdateEvent, { event: "done" }> };
  }

  test("a mix: in name order, a failure doesn't stop the rest, the rest are listed as skipped", async () => {
    const fake = mixedHome();
    const check: ModCheck = async (dir) => ({ ok: !dir.includes("b-bad"), output: "b-bad is bad" });
    const { ok, events, done } = await collect(fake, check);

    expect(ok).toBe(false);
    expect(events[0]).toMatchObject({ event: "plan", mods: ["a-good", "b-bad", "c-good"] });
    expect(done).toMatchObject({ event: "done", ok: false, updated: ["a-good", "c-good"], failed: ["b-bad"], unchanged: [] });
    expect(done.skipped.map((s) => [s.mod, s.status])).toEqual([
      ["broken", "error"],
      ["edited", "modified"],
      ["loose", "unlinked"],
    ]);
    expect(done.skipped.every((s) => s.reason.length > 0)).toBe(true);

    const results = events.flatMap((e) => (e.event === "result" ? [[e.mod, e.result.outcome]] : []));
    expect(results).toEqual([
      ["a-good", "updated"],
      ["b-bad", "failed"],
      ["c-good", "updated"],
    ]);
    expect(installedFile("a-good", "main.js")).toBe("two");
    expect(installedFile("b-bad", "main.js")).toBe("one");
    expect(installedFile("c-good", "main.js")).toBe("two");
    expect(installedFile("edited", "main.js")).toBe("my edit");
    expect(installedFile("level", "main.js")).toBe("two");
  });

  test("steps for one mod come between plan and its result, one mod at a time", async () => {
    const { events } = await collect(mixedHome(), async () => ({ ok: true, output: "" }));
    const lines = events.flatMap((e) => (e.event === "step" ? [`${e.mod} ${e.step}`] : e.event === "result" ? [`${e.mod} result`] : []));
    const steps = ["downloading", "checking", "backing_up", "installing", "verifying", "result"];
    expect(lines).toEqual(["a-good", "b-bad", "c-good"].flatMap((mod) => steps.map((s) => `${mod} ${s}`)));
  });

  test("nothing to do", async () => {
    installLinked("level", v2, sha("two"));
    const { ok, done } = await collect(fakeFor("level"), async () => ({ ok: true, output: "" }));
    expect(ok).toBe(true);
    expect(done).toMatchObject({ updated: [], failed: [], skipped: [] });
  });

  test("a second run finds nothing left", async () => {
    const fake = mixedHome();
    const check: ModCheck = async () => ({ ok: true, output: "" });
    await collect(fake, check);
    const { done } = await collect(fake, check);
    expect(done.updated).toEqual([]);
    expect(done.failed).toEqual([]);
  });
});

describe("the lock", () => {
  test("a second update is told one is running, and changes nothing", async () => {
    installLinked("quota", v1);
    mkdirSync(h.hmod, { recursive: true });
    await withLock(join(h.hmod, ".update-lock"), async () => {
      const one = updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker() });
      await expect(one).rejects.toThrow("another hmod update is running");
      const all = updateAll(() => {}, { gh: client(fakeFor("quota")), check: checker() });
      await expect(all).rejects.toThrow("another hmod update is running");
    });
    expect(installedFile("quota", "main.js")).toBe("one");
  });

  test("two at once: both finish, the second finding nothing to do", async () => {
    installLinked("quota", v1);
    const go = () => updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker() });
    const outcomes = (await Promise.all([go(), go()])).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["up_to_date", "updated"]);
  });

  test("released after a refused update", async () => {
    h.mod("agents", { "main.js": "shipped" });
    await updateOne("agents", false, { gh: client(fakeFor("agents")), check: checker() });
    expect(existsSync(join(h.hmod, ".update-lock"))).toBe(false);
  });

  test("leftovers from a crashed run are cleared", async () => {
    installLinked("quota", v2, sha("two"));
    writeTree(join(h.hmod, "staging", "dead", "quota"), { "main.js": "half" });
    await updateOne("quota", false, { gh: client(fakeFor("quota")), check: checker() });
    expect(staging()).toEqual([]);
  });
});

describe("the CLI", () => {
  function fakeHerdrApp(script: string): void {
    const path = join(h.other, "herdr-app");
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    process.env.HMOD_HERDR_APP = path;
  }

  test("update --json prints one result and exits 0", async () => {
    installLinked("quota", v1);
    fakeHerdrApp("exit 0");
    const r = await runCli(h, fakeFor("quota"), "update", "quota", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, outcome: "updated", to_version: "2.0.0" });
    expect(installedFile("quota", "main.js")).toBe("two");
  });

  test("a failed `herdr-app check` comes through with its output, and exit 1", async () => {
    installLinked("quota", v1);
    fakeHerdrApp(`echo "check failed: bad mod" >&2; exit 1`);
    const r = await runCli(h, fakeFor("quota"), "update", "quota", "--json");
    expect(r.code).toBe(1);
    const result = JSON.parse(r.stdout);
    expect(result).toMatchObject({ ok: false, outcome: "failed" });
    expect(result.error).toContain("check failed: bad mod");
  });

  test("no herdr-app to run is a failure, not an update", async () => {
    installLinked("quota", v1);
    process.env.HMOD_HERDR_APP = join(h.other, "no-such-program");
    const r = await runCli(h, fakeFor("quota"), "update", "quota", "--json");
    expect(r.code).toBe(1);
    expect(installedFile("quota", "main.js")).toBe("one");
  });

  test("--all --json prints a line per event", async () => {
    installLinked("quota", v1);
    fakeHerdrApp("exit 0");
    const r = await runCli(h, fakeFor("quota"), "update", "--all", "--json");
    expect(r.code).toBe(0);
    const events = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ event: "plan", mods: ["quota"] });
    expect(events.at(-1)).toMatchObject({ event: "done", ok: true, updated: ["quota"] });
  });

  test("--all in words, with a failure", async () => {
    installLinked("quota", v1);
    fakeHerdrApp("exit 1");
    const r = await runCli(h, fakeFor("quota"), "update", "--all");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("quota: failed:");
  });

  test.each([
    [["update"]],
    [["update", "a", "b"]],
    [["update", "a", "--all"]],
    [["update", "--all", "--force"]],
    [["list", "--force"]],
    [["list", "--all"]],
  ])("usage error: %j", (args) => {
    expect(h.run(...args).code).toBe(2);
  });

  test("an unknown mod is an ErrorResult", () => {
    const r = h.run("update", "nope", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
  });
});
