/** What's in <herdr home>/mods, and what can be said about each mod without the network. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HmodError } from "./errors.ts";
import { diffTrees, hashTree, readJson } from "./fsutil.ts";
import type { ClonedFrom, ListResult, ModEntry, ModKind, Sources } from "./model.ts";
import { herdrHome, paths } from "./paths.ts";
import { loadSources, sourceRef } from "./store.ts";

/** A mod that its own tool installs from a local git clone, because mod and tool must stay in step. */
export interface CloneAdapter {
  id: string;
  /** A hidden file in the mod folder, holding the path of the folder it was installed from. */
  marker: string;
  /** Files written at install time: they differ from the source on purpose. */
  generated: string[];
  /** The command that reinstalls it. */
  update: string;
}

/** To support another such mod, add it here. */
export const CLONE_ADAPTERS: CloneAdapter[] = [
  { id: "hcoord", marker: ".hcoord-installed", generated: ["hcoord-path.js"], update: "hcoord mod install" },
  { id: "hmod", marker: ".hmod-installed", generated: ["hmod-path.js"], update: "hmod mod install" },
];

/** A hidden file whose first line names the tool that installs and updates the mod. Hidden: Herdr ignores it. */
export const MANAGED_MARKER = ".hmod-managed";

/** One folder of the mods folder, before its status is worked out. */
export interface InventoryItem {
  name: string;
  title: string;
  kind: ModKind;
  dir: string;
  cloned_from: ClonedFrom | null;
  adapter: CloneAdapter | null;
  /** Who manages it, when kind is managed. */
  managed_by: string | null;
  /** mod.json couldn't be read. */
  problem: string | null;
}

function shippedMods(): Set<string> {
  const installed = readJson<unknown>(paths.installed());
  if (typeof installed !== "object" || installed === null || Array.isArray(installed)) {
    throw new HmodError(`${paths.installed()} isn't a JSON object`);
  }
  // Other keys are layouts, like "layout:main".
  return new Set(Object.keys(installed).filter((k) => !k.includes(":")));
}

function modFolders(): string[] {
  const dir = paths.mods();
  if (!existsSync(dir)) {
    throw new HmodError(`no Herdr mods folder at ${dir}: is the Herdr app installed? ($HERDR_APP_HOME overrides)`);
  }
  return readdirSync(dir)
    .filter((name) => {
      if (name.startsWith(".")) return false;
      try {
        return statSync(join(dir, name)).isDirectory(); // Follows links: a linked folder is a mod too.
      } catch {
        return false;
      }
    })
    .sort();
}

function readModJson(dir: string): { json: Record<string, unknown>; problem: string | null } {
  const path = join(dir, "mod.json");
  if (!existsSync(path)) return { json: {}, problem: null };
  try {
    const json: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
      return { json: json as Record<string, unknown>, problem: null };
    }
    return { json: {}, problem: "mod.json isn't a JSON object" };
  } catch (e: any) {
    return { json: {}, problem: `can't read mod.json: ${e.message}` };
  }
}

function clonedFrom(json: Record<string, unknown>): ClonedFrom | null {
  const c = json.cloned_from as { name?: unknown; version?: unknown } | null | undefined;
  if (typeof c !== "object" || c === null || typeof c.name !== "string") return null;
  return { name: c.name, version: typeof c.version === "string" ? c.version : null };
}

export function scanMods(): InventoryItem[] {
  const shipped = shippedMods();
  return modFolders().map((name) => {
    const dir = paths.mod(name);
    const { json, problem } = readModJson(dir);
    const title = typeof json.title === "string" && json.title.trim() ? json.title : name;
    const base = { name, title, dir, cloned_from: null, adapter: null, managed_by: null, problem };
    if (shipped.has(name)) return { ...base, kind: "herdr" as const, problem: null };
    const marker = join(dir, MANAGED_MARKER);
    if (existsSync(marker)) {
      const by = readFileSync(marker, "utf8").split(/\r?\n/)[0]?.trim() || "another tool";
      return { ...base, kind: "managed" as const, managed_by: by, problem: null };
    }
    const adapter = CLONE_ADAPTERS.find((a) => existsSync(join(dir, a.marker))) ?? null;
    if (adapter) return { ...base, kind: "clone-installed" as const, adapter };
    return { ...base, kind: "third-party" as const, cloned_from: clonedFrom(json) };
  });
}

/** Why hmod won't link this mod, or null if it can be. */
export function linkRefusal(item: InventoryItem): string | null {
  if (item.kind === "herdr") return `${item.name} ships with Herdr and updates with the app`;
  if (item.kind === "managed") return `${item.name} is managed by ${item.managed_by}: update it there`;
  if (item.adapter) return `${item.name} is installed from a local clone: update it with \`${item.adapter.update}\``;
  if (item.cloned_from) return `${item.name} is your own clone of ${item.cloned_from.name}: clones are never updated`;
  return null;
}

function cloneInstalledStatus(entry: ModEntry, adapter: CloneAdapter): ModEntry {
  const source = readFileSync(join(entry.dir, adapter.marker), "utf8").trim();
  if (!source) return { ...entry, status: "error", message: `${adapter.marker} is empty` };
  entry = { ...entry, adapter_source: source };
  if (!existsSync(source)) return { ...entry, status: "error", message: `its source folder is gone: ${source}` };
  const generated = (rel: string) => adapter.generated.includes(rel);
  const changed = diffTrees(hashTree(entry.dir), hashTree(source)).filter((rel) => !generated(rel));
  return changed.length
    ? { ...entry, status: "update_available", changed, note: `Differs from ${source}: run \`${adapter.update}\`` }
    : { ...entry, status: "up_to_date" };
}

/** What a mod's status is from local files alone. Never throws: a failure is status "error". */
export function localStatus(item: InventoryItem, sources: Sources): ModEntry {
  const entry: ModEntry = {
    name: item.name,
    title: item.title,
    kind: item.kind,
    status: "unlinked",
    message: null,
    note: null,
    dir: item.dir,
    source: null,
    cloned_from: item.cloned_from,
    adapter: item.adapter?.id ?? null,
    adapter_source: null,
    managed_by: item.managed_by,
    changed: [],
    remote_checked: false,
  };
  if (item.kind === "herdr") return { ...entry, status: "herdr" };
  if (item.kind === "managed") return { ...entry, status: "managed", note: `Managed by ${item.managed_by}` };
  if (item.problem) return { ...entry, status: "error", message: item.problem };
  try {
    if (item.adapter) return cloneInstalledStatus(entry, item.adapter);
    if (item.cloned_from) {
      const { name, version } = item.cloned_from;
      return { ...entry, note: `Your clone of ${name}${version ? ` (${version})` : ""}: it's yours and never updated` };
    }
    const record = sources[item.name];
    if (!record) return entry;
    if (record.commit === null) {
      return { ...entry, source: sourceRef(record), status: "up_to_date", note: "Linked: the first check works out which version this is" };
    }
    const changed = diffTrees(hashTree(item.dir), record.files);
    return { ...entry, source: sourceRef(record), status: changed.length ? "modified" : "up_to_date", changed };
  } catch (e: any) {
    return { ...entry, status: "error", message: e?.message ?? String(e) };
  }
}

export function listMods(): ListResult {
  const items = scanMods();
  const sources = loadSources();
  return { ok: true, herdr_home: herdrHome(), mods: items.map((item) => localStatus(item, sources)) };
}
