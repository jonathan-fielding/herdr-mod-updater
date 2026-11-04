/** Copies the Mod updates mod into Herdr's mods folder. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HmodError } from "./errors.ts";
import { isIgnored } from "./fsutil.ts";
import { herdrHome, hmodHome, paths } from "./paths.ts";

export const MOD_NAME = "mod-updater";
export const MOD_SOURCE = resolve(import.meta.dir, "..", "mods", MOD_NAME);
const CLI = resolve(import.meta.dir, "cli.ts");
const PATH_FILE = "hmod-path.js";
/** Marks a mod folder as hmod's, so install never replaces someone else's. Hidden: Herdr ignores it. */
const MARKER = ".hmod-installed";

/** `hmod mod install --json` */
export interface ModInstallResult {
  ok: true;
  dir: string;
  source: string;
  /** What to do next, already worded. */
  lines: string[];
}

/** The mod runs hmod with this exact bun and cli.ts, so it never depends on the app's PATH. */
export function pathModule(): string {
  const bun = Bun.which("bun") ?? process.execPath;
  // exec() takes no environment, so non-default homes go through env(1).
  const homes = ["HMOD_HOME", "HERDR_APP_HOME"].filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  const argv = homes.length ? ["/usr/bin/env", ...homes, bun, CLI] : [bun, CLI];
  return [
    "// Written by `hmod mod install`: how this mod runs hmod, and where hmod keeps its data.",
    `export const HMOD = ${JSON.stringify(argv)};`,
    `export const HMOD_DATA = ${JSON.stringify(hmodHome())};`,
    "",
  ].join("\n");
}

/** mods/mod-updater copied as it is (Herdr's gallery does this): still hmod's, just not set up. */
function isPlainCopy(dest: string): boolean {
  const path = join(dest, PATH_FILE);
  return existsSync(path) && /\bHMOD = null\b/.test(readFileSync(path, "utf8"));
}

export function installMod(): ModInstallResult {
  const dest = paths.mod(MOD_NAME);
  if (!existsSync(paths.mods())) {
    throw new HmodError(`no Herdr mods folder at ${paths.mods()}: is the Herdr app installed? ($HERDR_APP_HOME overrides)`);
  }
  if (existsSync(dest) && !existsSync(join(dest, MARKER)) && !isPlainCopy(dest)) {
    throw new HmodError(`${dest} exists and wasn't installed by hmod; move it away first`);
  }
  mkdirSync(dest, { recursive: true });
  // Only the installed copy gets the real path: the repo's hmod-path.js stays the committed default.
  const files = readdirSync(MOD_SOURCE).filter((f) => !isIgnored(f) && f !== PATH_FILE);
  // Code last: Herdr reloads on every save, and main.js imports hmod-path.js.
  writeFileSync(join(dest, MARKER), `${MOD_SOURCE}\n`);
  writeFileSync(join(dest, PATH_FILE), pathModule());
  for (const f of files.filter((f) => f !== "main.js")) cpSync(join(MOD_SOURCE, f), join(dest, f), { recursive: true });
  cpSync(join(MOD_SOURCE, "main.js"), join(dest, "main.js"));
  return {
    ok: true,
    dir: dest,
    source: MOD_SOURCE,
    lines: [
      `installed Mod updates to ${dest}`,
      `check it: herdr-app check ${dest}`,
      `open it: herdr-app do mod.open --name ${MOD_NAME}`,
      `Herdr's palette can't list a mod. For a key, add "cmd-shift-u": "mod.open:${MOD_NAME}" to "global" in ${join(herdrHome(), "keys.json")}, if you don't use it`,
    ],
  };
}
