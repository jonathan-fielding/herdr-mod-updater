import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitBlobSha, hashTree } from "../src/fsutil.ts";
import type { LinkLogEntry, LinkResult, Sources, UnlinkResult } from "../src/model.ts";
import { errorOf, fixtureHome, OFFLINE_API, OFFLINE_CLI, type Homes } from "./helpers.ts";
import { repoIds } from "./repo-ids.ts";

let h: Homes;
beforeEach(() => {
  h = fixtureHome();
});
afterEach(() => h.cleanup());

const sources = (): Sources => JSON.parse(readFileSync(join(h.hmod, "sources.json"), "utf8"));

const linkLog = (): LinkLogEntry[] =>
  readFileSync(join(h.hmod, "links.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

/** Linked, with the baseline a check would have worked out. */
function resolved(mod: string, dir: string): void {
  mkdirSync(h.hmod, { recursive: true });
  const record = { repo: "someone/herdr-quota", ...repoIds("someone/herdr-quota"), path: `mods/${mod}`, branch: null, commit: "abc", files: hashTree(dir) };
  writeFileSync(join(h.hmod, "sources.json"), JSON.stringify({ [mod]: record }));
}

describe("hmod link", () => {
  test("records the source and nothing from disk", () => {
    const r = h.json<LinkResult>("link", "quota", "someone/herdr-quota");
    expect(r).toEqual({
      ok: true,
      mod: "quota",
      linked: true,
      source: { repo: "someone/herdr-quota", path: "mods/quota", branch: null, commit: null },
      trust: "someone, and anyone who later controls someone/herdr-quota, can run code on your computer.",
    });
    const record = sources().quota!;
    expect(record.repo).toBe("someone/herdr-quota");
    expect(record.files).toEqual({});
  });

  test("takes --path and --branch, and the local name may differ from the repo's", () => {
    h.json("link", "quota", "someone/herdr-quota", "--path", "mods/herdr-quota/", "--branch", "dev");
    expect(sources().quota).toMatchObject({ path: "mods/herdr-quota", branch: "dev" });
  });

  test("a linked mod with no edits lists as up to date, unchecked", () => {
    h.json("link", "quota", "someone/herdr-quota");
    expect(h.entry("quota")).toMatchObject({
      status: "up_to_date",
      remote_checked: false,
      source: { repo: "someone/herdr-quota", path: "mods/quota", branch: null, commit: null },
    });
    expect((h.entry("quota").source as any).files).toBeUndefined();
  });

  test("a local edit, addition or removal lists as modified", () => {
    const dir = join(h.herdr, "mods", "quota");
    resolved("quota", dir);
    writeFileSync(join(dir, "main.js"), "edited");
    writeFileSync(join(dir, "extra.js"), "new");
    rmSync(join(dir, "mod.json"));
    expect(h.entry("quota")).toMatchObject({ status: "modified", changed: ["extra.js", "main.js", "mod.json"] });
  });

  test("files Herdr injects later don't count as edits", () => {
    const dir = join(h.herdr, "mods", "no-mod-json");
    resolved("no-mod-json", dir);
    writeFileSync(join(dir, "gpui-kit.d.ts"), "// injected");
    writeFileSync(join(dir, "jsconfig.json"), "{}");
    writeFileSync(join(dir, ".DS_Store"), "x");
    expect(h.entry("no-mod-json").status).toBe("up_to_date");
  });

  test("linking the same thing again changes nothing", () => {
    const dir = join(h.herdr, "mods", "quota");
    resolved("quota", dir);
    writeFileSync(join(dir, "main.js"), "edited");
    expect(h.json<LinkResult>("link", "quota", "someone/herdr-quota").linked).toBe(false);
    expect(h.entry("quota").status).toBe("modified");
  });

  test("linking somewhere else is refused until unlinked", () => {
    h.json("link", "quota", "someone/herdr-quota");
    const r = h.run("link", "quota", "other/herdr-quota", "--json");
    expect(r.code).toBe(1);
    expect(errorOf(r)).toContain("already linked");
    expect(sources().quota!.repo).toBe("someone/herdr-quota");
  });

  test.each([
    ["agents", "ships with Herdr"],
    ["hcoord", "local clone"],
    ["my-files", "clone of files"],
    ["missing", "no mod called"],
  ])("refuses %s", (mod, why) => {
    const r = h.run("link", mod, "someone/repo", "--json");
    expect(r.code).toBe(1);
    expect(errorOf(r)).toContain(why);
    expect(existsSync(join(h.hmod, "sources.json"))).toBe(false);
  });

  test.each([
    [["quota", "not-a-repo"]],
    [["quota", "a/b/c"]],
    [["quota", "a/.."]],
    [["quota", "a/b", "--path", "../x"]],
    [["quota", "a/b", "--path", "/etc"]],
    [["quota", "a/b", "--branch", "-x"]],
    [["quota", "a/b", "--branch", "a..b"]],
    [["quota"]],
  ])("bad usage: %j", (args) => {
    expect(h.run("link", ...args, "--json").code).toBe(2);
  });

  test("a mod name can't reach outside the mods folder", () => {
    expect(h.run("link", "../installed.json", "a/b", "--path", "x", "--json").code).toBe(1);
  });
});

describe("hmod unlink", () => {
  test("forgets the source; the mod is unlinked again and its files stay", () => {
    h.json("link", "quota", "someone/herdr-quota");
    expect(h.json<UnlinkResult>("unlink", "quota")).toEqual({ ok: true, mod: "quota", unlinked: true });
    expect(sources().quota).toBeUndefined();
    expect(h.entry("quota").status).toBe("unlinked");
    expect(existsSync(join(h.herdr, "mods", "quota", "main.js"))).toBe(true);
  });

  test("a mod that wasn't linked is fine", () => {
    expect(h.json<UnlinkResult>("unlink", "quota").unlinked).toBe(false);
  });

  test("works for a mod that's been uninstalled", () => {
    h.json("link", "quota", "someone/herdr-quota");
    rmSync(join(h.herdr, "mods", "quota"), { recursive: true });
    expect(h.json<UnlinkResult>("unlink", "quota").unlinked).toBe(true);
  });
});

describe("sources.json", () => {
  test("parallel links all survive, leaving no lock or temp file", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `m${i}`);
    for (const n of names) h.mod(n, { "main.js": n });
    const procs = names.map((n) =>
      Bun.spawn([...OFFLINE_CLI, "link", n, `someone/${n}`], {
        env: { ...process.env, HERDR_APP_HOME: h.herdr, HMOD_HOME: h.hmod, HMOD_GITHUB_API: OFFLINE_API },
        stdout: "ignore",
      }),
    );
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual(names.map(() => 0));
    expect(Object.keys(sources()).sort()).toEqual(names);
    expect(readdirSync(h.hmod).sort()).toEqual(["links.jsonl", "sources.json"]);
    expect(linkLog().map((e) => e.mod).sort()).toEqual(names);
  });

  test("a mod called like an Object property is an ordinary name", () => {
    h.mod("constructor", { "main.js": "x" });
    expect(h.entry("constructor").status).toBe("unlinked");
    h.json("link", "constructor", "someone/thing");
    expect(h.entry("constructor").status).toBe("up_to_date");
  });

  test("corrupt: says so rather than treating every mod as unlinked", () => {
    mkdirSync(h.hmod, { recursive: true });
    writeFileSync(join(h.hmod, "sources.json"), "{ nope");
    const r = h.run("list", "--json");
    expect(r.code).toBe(1);
    expect(errorOf(r)).toContain("sources.json");
    expect(h.run("unlink", "quota", "--json").code).toBe(1);
    expect(readFileSync(join(h.hmod, "sources.json"), "utf8")).toBe("{ nope");
  });

  test("a bad entry is refused", () => {
    mkdirSync(h.hmod, { recursive: true });
    writeFileSync(join(h.hmod, "sources.json"), `{ "quota": { "repo": 1 } }`);
    expect(errorOf(h.run("list", "--json"))).toContain(`bad entry for "quota"`);
  });
});

describe("hashing", () => {
  test("matches git's blob ids", () => {
    expect(gitBlobSha(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  test("handles binary content and subfolders, skipping hidden ones and node_modules", () => {
    const dir = h.mod("tree", { "art/a.txt": "a", ".git/config": "x", "node_modules/p/i.js": "x", "art/.hidden": "x" });
    writeFileSync(join(dir, "art", "b.bin"), Buffer.from([0, 255, 0, 10]));
    const tree = hashTree(dir);
    expect(Object.keys(tree).sort()).toEqual(["art/a.txt", "art/b.bin"]);
    const git = Bun.spawnSync(["git", "hash-object", join(dir, "art", "b.bin")]).stdout.toString().trim();
    expect(tree["art/b.bin"]).toBe(git);
  });
});

test("--version, --help and unknown commands", () => {
  expect(h.run("--version").stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  expect(h.run("--help").stdout).toContain("hmod link");
  expect(h.run("nonsense").code).toBe(2);
  expect(h.run("list", "--path", "x").code).toBe(2);
});

describe("the link log", () => {
  test("a link says what, where and how, and an unlink says what it forgot", () => {
    h.mod("quota", { "main.js": "x" });
    h.json("link", "quota", "someone/herdr-quota", "--path", "mods/q", "--branch", "dev");
    h.json("unlink", "quota");
    const [linked, unlinked] = linkLog();
    expect(linked).toMatchObject({ event: "link", mod: "quota", repo: "someone/herdr-quota", path: "mods/q", branch: "dev", via: "terminal", offered_because: null });
    expect(unlinked).toMatchObject({ event: "unlink", mod: "quota", repo: "someone/herdr-quota", path: "mods/q", via: "terminal" });
    expect(Date.parse(linked!.at)).toBeGreaterThan(0);
  });

  test("--dialog says the dialog did it", () => {
    h.mod("quota", { "main.js": "x" });
    h.json("link", "quota", "someone/herdr-quota", "--dialog");
    expect(linkLog()[0]!.via).toBe("dialog");
  });

  test("a link the last check offered keeps why it was offered", () => {
    h.mod("quota", { "main.js": "x" });
    const offer = { repo: "someone/herdr-quota", path: "mods/quota", why: "Every file matches commit abc", exact: true, commit: "abc" };
    mkdirSync(h.hmod, { recursive: true });
    writeFileSync(join(h.hmod, "check.json"), JSON.stringify({ last_checked: null, mods: { quota: { suggestions: [offer] } } }));
    h.json("link", "quota", "someone/herdr-quota");
    expect(linkLog()[0]!.offered_because).toBe(offer.why);
  });

  test("nothing changed, nothing logged", () => {
    h.mod("quota", { "main.js": "x" });
    h.json("link", "quota", "someone/herdr-quota");
    h.json("link", "quota", "someone/herdr-quota");
    h.json("unlink", "never-linked");
    expect(linkLog()).toHaveLength(1);
  });

  test("a link that can't be logged doesn't happen", () => {
    h.mod("quota", { "main.js": "x" });
    mkdirSync(join(h.hmod, "links.jsonl"), { recursive: true });
    expect(h.run("link", "quota", "someone/herdr-quota").code).not.toBe(0);
    expect(existsSync(join(h.hmod, "sources.json"))).toBe(false);
  });

  test("--dialog is refused where it means nothing", () => {
    expect(h.run("list", "--dialog").code).not.toBe(0);
  });
});
