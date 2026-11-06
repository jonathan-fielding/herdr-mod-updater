/** sources.json: what each linked mod came from, and the baseline of what was installed. */
import { appendFileSync, mkdirSync } from "node:fs";
import { HmodError } from "./errors.ts";
import { atomicWrite, readJson, withLock } from "./fsutil.ts";
import type { LinkLogEntry, SourceRecord, SourceRef, Sources } from "./model.ts";
import { hmodHome, paths } from "./paths.ts";

function isRecord(v: unknown): v is SourceRecord {
  const r = v as SourceRecord | null;
  return (
    typeof r === "object" && r !== null &&
    typeof r.repo === "string" && typeof r.path === "string" &&
    (r.branch === null || typeof r.branch === "string") &&
    (r.commit === null || typeof r.commit === "string") &&
    typeof r.files === "object" && r.files !== null &&
    (r.repo_id === undefined || typeof r.repo_id === "number") &&
    (r.owner_id === undefined || typeof r.owner_id === "number") &&
    (r.first_update_pending === undefined || typeof r.first_update_pending === "boolean")
  );
}

/** Whether the person has confirmed this link's ids. */
export function isPinned(r: SourceRecord): boolean {
  return r.repo_id !== undefined && r.owner_id !== undefined;
}

/** What linking or confirming a repo hands over, for anyone who reads it before or after. */
export function trustWarning(repo: string, owner = repo.split("/")[0]): string {
  return `${owner}, and anyone who later controls ${repo}, can run code on your computer.`;
}

/** No prototype, so a mod called "constructor" or "__proto__" is an ordinary key. */
export function loadSources(): Sources {
  const sources: Sources = Object.create(null);
  let raw: unknown;
  try {
    raw = readJson<unknown>(paths.sources());
  } catch (e) {
    if (e instanceof HmodError && e.message.startsWith("missing file")) return sources;
    throw e;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HmodError(`${paths.sources()} isn't a JSON object`);
  }
  for (const [name, record] of Object.entries(raw)) {
    if (!isRecord(record)) throw new HmodError(`${paths.sources()}: bad entry for "${name}"`);
    sources[name] = record;
  }
  return sources;
}

/** Changes sources.json under its lock. `change` sees the latest content and edits it in place. */
export async function updateSources<T>(change: (sources: Sources) => T): Promise<T> {
  mkdirSync(hmodHome(), { recursive: true });
  return withLock(paths.sourcesLock(), () => {
    const sources = loadSources();
    const result = change(sources);
    atomicWrite(paths.sources(), `${JSON.stringify(sources, null, 2)}\n`);
    return result;
  });
}

/** Call within updateSources: if this can't be written, the link doesn't happen either. */
export function logLink(entry: Omit<LinkLogEntry, "at">): void {
  appendFileSync(paths.linkLog(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/** The record without its baseline: what the JSON output shows. */
export function sourceRef({ repo, path, branch, commit }: SourceRecord): SourceRef {
  return { repo, path, branch, commit };
}
