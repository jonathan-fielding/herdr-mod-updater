import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { HmodError } from "./errors.ts";

/** Writes via a temp file in the same folder + fsync + rename, so readers never see a partial file. */
export function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

export function readJson<T>(path: string): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new HmodError(`missing file: ${path}`);
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e: any) {
    throw new HmodError(`invalid JSON in ${path}: ${e.message}`);
  }
}

export interface LockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /** A lock whose holder is alive is still taken over after this long (a hung holder). */
  staleMs?: number;
}

function readLock(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Lock file content: "<pid> <epoch ms> <random>". */
function isStale(path: string, content: string, staleMs: number): boolean {
  const [pidText, timeText] = content.trim().split(" ");
  const pid = Number(pidText);
  const time = Number(timeText);
  if (!Number.isInteger(pid) || !Number.isFinite(time)) {
    // Created but not written yet, or garbage: stale only once it's clearly abandoned.
    try {
      return Date.now() - statSync(path).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
  return !pidAlive(pid) || Date.now() - time > staleMs;
}

/**
 * Runs `fn` while holding an exclusive lock file (created with O_EXCL). Waiting holders retry
 * with jitter. A lock left by a dead process (or one older than `staleMs`) is taken over.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  { timeoutMs = 15_000, staleMs = 5 * 60_000 }: LockOptions = {},
): Promise<T> {
  const token = `${process.pid} ${Date.now()} ${randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o644);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
    const held = readLock(lockPath);
    if (held !== null && isStale(lockPath, held, staleMs)) {
      // Re-check right before removing, so we don't remove a lock someone just took over.
      if (readLock(lockPath) === held) {
        try {
          unlinkSync(lockPath);
        } catch {}
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new HmodError(
        `timed out after ${timeoutMs} ms waiting for ${lockPath} (held by: ${held?.trim() || "unknown"})`,
      );
    }
    await Bun.sleep(3 + Math.random() * 20);
  }
  try {
    return await fn();
  } finally {
    if (readLock(lockPath) === token) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}

/** Files Herdr injects into mod folders, and folders it treats as generated. */
const IGNORED_NAMES = new Set(["gpui-kit.d.ts", "jsconfig.json", "node_modules"]);

/**
 * Whether a mod file is left out of comparisons (`rel` is relative, "/"-separated). Anything that
 * replaces a mod's files must also leave these in place: never delete them.
 */
export function isIgnored(rel: string): boolean {
  return rel.split("/").some((part) => part.startsWith(".") || IGNORED_NAMES.has(part));
}

/** The id git gives this content as a blob: SHA-1 of "blob <size>\0<content>". */
export function gitBlobSha(content: Uint8Array): string {
  return createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}

/**
 * relpath -> git blob SHA-1 for every file under `dir`, skipping ignored ones. A symlink hashes as
 * its target path (as git stores it) and is never followed, so a link loop can't hang this.
 */
export function hashTree(dir: string): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      if (isIgnored(child)) continue;
      const path = join(dir, child);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(child);
      else if (stat.isSymbolicLink()) files[child] = gitBlobSha(Buffer.from(readlinkSync(path)));
      else if (stat.isFile()) files[child] = gitBlobSha(readFileSync(path));
    }
  };
  walk("");
  return files;
}

/** The relative paths that are only in one of the two trees, or differ between them. */
export function diffTrees(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !Object.hasOwn(a, k) || !Object.hasOwn(b, k) || a[k] !== b[k])
    .sort();
}
