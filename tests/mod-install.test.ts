/** `hmod mod install` against temp homes, through the real CLI. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeHomes, errorOf, type Homes } from "./helpers.ts";

const SOURCE = resolve(import.meta.dir, "..", "mods", "mod-updater");
let h: Homes;
const dest = () => join(h.herdr, "mods", "mod-updater");
const pathFile = () => readFileSync(join(dest(), "hmod-path.js"), "utf8");

beforeEach(() => {
  h = makeHomes();
});
afterEach(() => h.cleanup());

describe("hmod mod install", () => {
  test("copies the mod, marks it, and writes how to run hmod", () => {
    const r = h.json("mod", "install");
    expect(r.ok).toBe(true);
    expect(r.dir).toBe(dest());
    expect(readFileSync(join(dest(), "main.js"), "utf8")).toBe(readFileSync(join(SOURCE, "main.js"), "utf8"));
    expect(readFileSync(join(dest(), "mod.json"), "utf8")).toBe(readFileSync(join(SOURCE, "mod.json"), "utf8"));
    expect(readFileSync(join(dest(), ".hmod-installed"), "utf8").trim()).toBe(SOURCE);
    const argv = JSON.parse(/HMOD = (.*);/.exec(pathFile())![1]!);
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/env", `HMOD_HOME=${h.hmod}`, `HERDR_APP_HOME=${h.herdr}`]);
    expect(argv.at(-1)).toEndWith("src/cli.ts");
    expect(pathFile()).toContain(`HMOD_DATA = ${JSON.stringify(h.hmod)}`);
  });

  test("the argv it writes really runs hmod, on those homes", () => {
    h.json("mod", "install");
    const argv: string[] = JSON.parse(/HMOD = (.*);/.exec(pathFile())![1]!);
    const p = Bun.spawnSync([...argv, "list", "--json"]);
    expect(p.exitCode).toBe(0);
    const { herdr_home, mods } = JSON.parse(p.stdout.toString());
    expect(herdr_home).toBe(h.herdr);
    expect(mods.map((m: any) => m.name)).toEqual(["mod-updater"]);
  });

  test("leaves the committed path module alone", () => {
    h.json("mod", "install");
    expect(readFileSync(join(SOURCE, "hmod-path.js"), "utf8")).toMatch(/\bHMOD = null\b/);
  });

  test("doesn't copy what Herdr injects or hidden files, and keeps those already there", () => {
    h.mod("mod-updater", { ".hmod-installed": "x\n", "gpui-kit.d.ts": "// injected" });
    h.json("mod", "install");
    expect(readFileSync(join(dest(), "gpui-kit.d.ts"), "utf8")).toBe("// injected");
    expect(readdirSync(dest()).sort()).toEqual([".hmod-installed", "gpui-kit.d.ts", "hmod-path.js", "main.js", "mod.json"]);
  });

  test("installs again over its own copy", () => {
    h.json("mod", "install");
    writeFileSync(join(dest(), "main.js"), "old");
    expect(h.json("mod", "install").ok).toBe(true);
    expect(readFileSync(join(dest(), "main.js"), "utf8")).not.toBe("old");
  });

  test("sets up a plain copy of the folder", () => {
    h.mod("mod-updater", { "main.js": "old", "hmod-path.js": "export const HMOD = null;\n" });
    expect(h.json("mod", "install").ok).toBe(true);
    expect(pathFile()).not.toMatch(/\bHMOD = null\b/);
  });

  test("never replaces someone else's mod of that name", () => {
    h.mod("mod-updater", { "main.js": "theirs" });
    const r = h.run("mod", "install", "--json");
    expect(r.code).toBe(1);
    expect(errorOf(r)).toContain("wasn't installed by hmod");
    expect(readFileSync(join(dest(), "main.js"), "utf8")).toBe("theirs");
    expect(existsSync(join(dest(), ".hmod-installed"))).toBe(false);
  });

  test("says so when there's no mods folder", () => {
    const { rmSync } = require("node:fs");
    rmSync(join(h.herdr, "mods"), { recursive: true });
    const r = h.run("mod", "install", "--json");
    expect(r.code).toBe(1);
    expect(errorOf(r)).toContain("no Herdr mods folder");
  });

  test("prints how to open it, and touches no keys", () => {
    const r = h.run("mod", "install");
    expect(r.stdout).toContain("herdr-app do mod.open --name mod-updater");
    expect(existsSync(join(h.herdr, "keys.json"))).toBe(false);
  });

  test("anything but install is a usage error", () => {
    expect(h.run("mod", "remove").code).toBe(2);
    expect(h.run("mod").code).toBe(2);
  });
});
