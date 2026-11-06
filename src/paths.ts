import { homedir } from "node:os";
import { join } from "node:path";

/** hmod's data folder. `HMOD_HOME` overrides it (tests use a temp folder). */
export function hmodHome(): string {
  return process.env.HMOD_HOME || join(process.env.HOME || homedir(), ".herdr-mod-updater");
}

/** Herdr's home. `HERDR_APP_HOME` overrides it (tests use a temp folder). */
export function herdrHome(): string {
  return process.env.HERDR_APP_HOME || join(process.env.HOME || homedir(), ".config", "herdr-app");
}

export const paths = {
  sources: () => join(hmodHome(), "sources.json"),
  /** One JSON line per link and unlink, so it's clear later why a mod trusts a repo. */
  linkLog: () => join(hmodHome(), "links.jsonl"),
  /** Serialises every write to sources.json. */
  sourcesLock: () => join(hmodHome(), ".lock"),
  mods: () => join(herdrHome(), "mods"),
  mod: (name: string) => join(herdrHome(), "mods", name),
  installed: () => join(herdrHome(), "installed.json"),
};
