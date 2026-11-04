/** sources.json: what each linked mod came from, and the baseline of what was installed. */
import { mkdirSync } from "node:fs";
import { HmodError } from "./errors.ts";
import { atomicWrite, readJson, withLock } from "./fsutil.ts";
import type { SourceRecord, SourceRef, Sources } from "./model.ts";
import { hmodHome, paths } from "./paths.ts";

function isRecord(v: unknown): v is SourceRecord {
  const r = v as SourceRecord | null;
  return (
    typeof r === "object" && r !== null &&
    typeof r.repo === "string" && typeof r.path === "string" &&
    (r.branch === null || typeof r.branch === "string") &&
    (r.commit === null || typeof r.commit === "string") &&
    typeof r.files === "object" && r.files !== null
  );
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

/** The record without its baseline: what the JSON output shows. */
export function sourceRef({ repo, path, branch, commit }: SourceRecord): SourceRef {
  return { repo, path, branch, commit };
}
