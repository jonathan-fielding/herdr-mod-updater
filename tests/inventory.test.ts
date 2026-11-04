import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ListResult } from "../src/model.ts";
import { errorOf, fixtureHome, makeHomes, type Homes } from "./helpers.ts";

let h: Homes;
beforeEach(() => {
  h = fixtureHome();
});
afterEach(() => h.cleanup());

describe("hmod list --json on a home with every kind", () => {
  test("lists each folder, sorted, and nothing else", () => {
    const list = h.json<ListResult>("list");
    expect(list.ok).toBe(true);
    expect(list.herdr_home).toBe(h.herdr);
    expect(list.mods.map((m) => m.name)).toEqual(["agents", "broken", "hcoord", "my-files", "no-mod-json", "quota"]);
  });

  test("shipped mods are herdr", () => {
    expect(h.entry("agents")).toMatchObject({ kind: "herdr", status: "herdr", title: "Agents", source: null });
  });

  test("layouts in installed.json aren't taken for mods", () => {
    h.mod("layout", { "main.js": "x" });
    expect(h.entry("layout").kind).toBe("third-party");
  });

  test("a third-party mod with no source is unlinked", () => {
    expect(h.entry("quota")).toMatchObject({ kind: "third-party", status: "unlinked", title: "Quota", note: null });
  });

  test("the title falls back to the folder name", () => {
    expect(h.entry("no-mod-json").title).toBe("no-mod-json");
  });

  test("a mod.clone copy is unlinked, marked as the person's own", () => {
    const e = h.entry("my-files");
    expect(e).toMatchObject({
      kind: "third-party",
      status: "unlinked",
      cloned_from: { name: "files", version: "0.1.13" },
    });
    expect(e.note).toContain("files (0.1.13)");
  });

  test("a broken mod.json is an error on that mod alone", () => {
    const e = h.entry("broken");
    expect(e.status).toBe("error");
    expect(e.message).toContain("mod.json");
    expect(h.entry("quota").status).toBe("unlinked");
  });

  test("hcoord is clone-installed and in step with its clone, whatever hcoord-path.js holds", () => {
    expect(h.entry("hcoord")).toMatchObject({
      kind: "clone-installed",
      status: "up_to_date",
      adapter: "hcoord",
      adapter_source: join(h.other, "clone", "mods", "hcoord"),
      changed: [],
    });
  });

  test("hcoord behind its clone needs an update", () => {
    writeFileSync(join(h.other, "clone", "mods", "hcoord", "main.js"), "newer");
    expect(h.entry("hcoord")).toMatchObject({ status: "update_available", changed: ["main.js"] });
  });

  test("hcoord with its clone gone is an error", () => {
    rmSync(join(h.other, "clone"), { recursive: true });
    const e = h.entry("hcoord");
    expect(e.status).toBe("error");
    expect(e.message).toContain("gone");
  });

  test("an empty marker is an error", () => {
    writeFileSync(join(h.herdr, "mods", "hcoord", ".hcoord-installed"), "\n");
    expect(h.entry("hcoord").status).toBe("error");
  });

  test("nothing claims to have asked GitHub", () => {
    expect(h.json<ListResult>("list").mods.every((m) => !m.remote_checked)).toBe(true);
  });

  test("a mod folder that's a symlink is listed", () => {
    mkdirSync(join(h.other, "dev-mod"));
    symlinkSync(join(h.other, "dev-mod"), join(h.herdr, "mods", "dev-mod"));
    expect(h.entry("dev-mod").status).toBe("unlinked");
  });

  test("list writes nothing to the data folder", () => {
    h.run("list", "--json");
    expect(Bun.file(join(h.hmod, "sources.json")).size).toBe(0);
  });

  test("text output names each mod", () => {
    const { stdout, code } = h.run("list");
    expect(code).toBe(0);
    expect(stdout).toContain("my-files");
    expect(stdout).toContain("unlinked");
  });
});

describe("a home that isn't usable", () => {
  test("no mods folder", () => {
    rmSync(join(h.herdr, "mods"), { recursive: true });
    const r = h.run("list", "--json");
    expect(r.code).toBe(1);
    expect(errorOf(r)).toContain("no Herdr mods folder");
  });

  test("no installed.json: shipped mods can't be told apart, so it fails", () => {
    unlinkSync(join(h.herdr, "installed.json"));
    const r = h.run("list", "--json");
    expect(r.code).toBe(1);
    expect(errorOf(r)).toContain("installed.json");
  });

  test("errors go to stderr without --json", () => {
    unlinkSync(join(h.herdr, "installed.json"));
    const r = h.run("list");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("hmod: missing file");
  });

  test("an empty home is an empty list", () => {
    const empty = makeHomes();
    expect(empty.json<ListResult>("list").mods).toEqual([]);
    empty.cleanup();
  });
});

test("the test homes are never the real ones", () => {
  expect(h.herdr.startsWith(join(homedir(), ".config"))).toBe(false);
  expect(h.hmod).not.toBe(join(homedir(), ".herdr-mod-updater"));
});
