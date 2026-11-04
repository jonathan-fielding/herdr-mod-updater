import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ErrorResult, ListResult, ModEntry } from "../src/model.ts";

const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");

export interface Homes {
  herdr: string;
  hmod: string;
  /** A place outside both, for things like a stand-in git clone. */
  other: string;
  run: (...args: string[]) => { code: number; stdout: string; stderr: string };
  json: <T = any>(...args: string[]) => T;
  mod: (name: string, files: Record<string, string>) => string;
  entry: (name: string) => ModEntry;
  cleanup: () => void;
}

/** Temp Herdr and hmod homes. Commands run with the env vars pointing at them, never the real ones. */
export function makeHomes(shipped: string[] = []): Homes {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hmod-test-")));
  const herdr = join(base, "herdr");
  const hmod = join(base, "hmod");
  const other = join(base, "other");
  mkdirSync(join(herdr, "mods"), { recursive: true });
  mkdirSync(other);
  const installed: Record<string, unknown> = { "layout:main": { json: "abc" } };
  for (const name of shipped) installed[name] = { "main.js": "abc" };
  writeFileSync(join(herdr, "installed.json"), JSON.stringify(installed));

  const run: Homes["run"] = (...args) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], {
      env: { ...process.env, HERDR_APP_HOME: herdr, HMOD_HOME: hmod, HOME: base },
    });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };
  const json: Homes["json"] = (...args) => JSON.parse(run(...args, "--json").stdout);
  return {
    herdr,
    hmod,
    other,
    run,
    json,
    mod: (name, files) => {
      const dir = join(herdr, "mods", name);
      writeTree(dir, files);
      return dir;
    },
    entry: (name) => {
      const found = json<ListResult>("list").mods.find((m) => m.name === name);
      if (!found) throw new Error(`no ${name} in hmod list`);
      return found;
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export function writeTree(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

/** One mod of every kind, as a real Herdr home has them. */
export function fixtureHome(): Homes {
  const h = makeHomes(["agents"]);
  const injected = { "gpui-kit.d.ts": "// injected", "jsconfig.json": "{}" };
  h.mod("agents", { "main.js": "shipped", "mod.json": `{ "place": "left", "title": "Agents" }`, ...injected });
  h.mod("quota", { "main.js": "third party", "mod.json": `{ "place": "none", "title": "Quota" }`, ...injected });
  h.mod("no-mod-json", { "main.js": "bare" });
  h.mod("broken", { "main.js": "x", "mod.json": "{ nope" });
  h.mod("my-files", {
    "main.js": "clone",
    "mod.json": JSON.stringify({ place: "none", cloned_from: { name: "files", version: "0.1.13" } }),
  });
  const source = join(h.other, "clone", "mods", "hcoord");
  writeTree(source, { "main.js": "hcoord", "mod.json": `{ "title": "Projects" }`, "hcoord-path.js": "export const HCOORD = null;" });
  h.mod("hcoord", {
    "main.js": "hcoord",
    "mod.json": `{ "title": "Projects" }`,
    "hcoord-path.js": `export const HCOORD = ["bun", "cli.ts"];`,
    ".hcoord-installed": `${source}\n`,
    ...injected,
  });
  writeFileSync(join(h.herdr, "mods", ".DS_Store"), "");
  writeFileSync(join(h.herdr, "mods", "stray-file"), "");
  symlinkSync(join(h.other, "gone"), join(h.herdr, "mods", "dangling"));
  return h;
}

export function errorOf(r: { stdout: string }): string {
  return (JSON.parse(r.stdout) as ErrorResult).error;
}
