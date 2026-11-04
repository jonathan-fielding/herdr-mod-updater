/**
 * Mods their own tool installs from a local git clone (see CLONE_ADAPTERS in inventory.ts). hmod
 * never copies files over these: it pulls the clone, then has the tool install its own mod, so the
 * mod and the tool stay in step. It never forces, stashes or resets the clone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HmodError } from "./errors.ts";
import type { InventoryItem } from "./inventory.ts";

/** hmod won't try this at all, as opposed to trying and failing. */
export class UpdateRefused extends HmodError {
  constructor(message: string) {
    super(message);
    this.name = "UpdateRefused";
  }
}

/** How a tool gets run: a generated file in its mod holds the argv, and these args install the mod. */
interface Installer {
  file: string;
  constant: string;
  args: string[];
  /** Left out of the install's environment: the generated argv alone decides these, or a shell's value would be written into the mod. */
  unset?: string[];
  /** hmod updating itself: a failed install leaves hmod running on code that may not start. */
  self?: boolean;
}

/** Keyed by CloneAdapter id. */
const INSTALLERS: Record<string, Installer> = {
  hcoord: { file: "hcoord-path.js", constant: "HCOORD", args: ["mod", "install"] },
  hmod: { file: "hmod-path.js", constant: "HMOD", args: ["mod", "install"], unset: ["HMOD_HOME"], self: true },
};

const GIT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 120_000;

export interface Ran {
  ok: boolean;
  stdout: string;
  /** stderr, or stdout if it had nothing to say. */
  output: string;
}

/** Runs a program with no stdin, so it can't sit waiting for an answer. Never throws. */
export async function run(argv: string[], options: { cwd?: string; timeoutMs: number; unset?: string[] }): Promise<Ran> {
  try {
    const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    for (const key of options.unset ?? []) delete env[key];
    const p = Bun.spawn(argv, {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs,
      env,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const output = stderr.trim() || stdout.trim() || (code === 0 ? "" : `exit code ${code}`);
    return { ok: code === 0, stdout: stdout.trim(), output };
  } catch (e: any) {
    return { ok: false, stdout: "", output: `can't run ${argv[0]}: ${e?.message ?? e}` };
  }
}

/** A remote URL can hold a token, and git prints it in its errors. */
const stripCredentials = (text: string) => text.replace(/\/\/[^/@\s]*@/g, "//");

/**
 * The argv in a generated file like `export const HCOORD = ["bun", "cli.ts"];`. Read as text, not
 * imported: hmod has no business running a mod's files.
 */
export function installerArgv(item: InventoryItem, installer: Installer): string[] {
  const path = join(item.dir, installer.file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new UpdateRefused(`${path} is missing, so hmod can't tell how to run ${item.name}'s tool`);
  }
  const found = text.match(new RegExp(`\\b${installer.constant}\\s*=\\s*(\\[.*\\]|null)`));
  let argv: unknown = undefined;
  try {
    argv = found && JSON.parse(found[1]!);
  } catch {}
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string" && a)) {
    throw new UpdateRefused(`${path} doesn't say how to run ${item.name}'s tool: set it up with \`${item.adapter?.update}\``);
  }
  return argv as string[];
}

export interface CloneUpdate {
  root: string;
  branch: string;
  from_commit: string;
  to_commit: string;
  /** False when the clone had nothing new and the installed copy already matched it. */
  installed: boolean;
}

async function git(root: string, ...args: string[]): Promise<Ran> {
  const result = await run(["git", "-C", root, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  return { ...result, output: stripCredentials(result.output) };
}

/** Pulls the clone that `source` is in and reinstalls the mod. `stale`: the install lags the clone already. */
export async function updateClone(
  item: InventoryItem,
  source: string,
  stale: boolean,
  step: (step: "pulling" | "installing") => void,
): Promise<CloneUpdate> {
  const adapter = item.adapter;
  const installer = adapter && INSTALLERS[adapter.id];
  if (!adapter || !installer) throw new UpdateRefused(`hmod doesn't know how to update ${item.name}`);
  const argv = installerArgv(item, installer);

  const top = await git(source, "rev-parse", "--show-toplevel");
  if (!top.ok) throw new UpdateRefused(`${source} isn't in a git clone: ${top.output}`);
  const root = top.stdout;
  const status = await git(root, "status", "--porcelain");
  if (!status.ok) throw new HmodError(`git status failed in ${root}: ${status.output}`);
  if (status.stdout) throw new UpdateRefused(`${root} has uncommitted changes: commit or move them yourself, then update again`);
  const branch = (await git(root, "symbolic-ref", "--quiet", "--short", "HEAD")).stdout;
  if (!branch) throw new UpdateRefused(`${root} isn't on a branch`);
  const remote = (await git(root, "config", "--get", `branch.${branch}.remote`)).stdout;
  const merge = (await git(root, "config", "--get", `branch.${branch}.merge`)).stdout;
  if (remote !== "origin" || !merge) throw new UpdateRefused(`${branch} in ${root} doesn't track origin`);

  const head = async () => (await git(root, "rev-parse", "HEAD")).stdout;
  const from_commit = await head();
  step("pulling");
  const pull = await git(root, "pull", "--ff-only");
  if (!pull.ok) throw new HmodError(`git pull --ff-only failed in ${root}: ${pull.output}`);
  const to_commit = await head();
  if (to_commit === from_commit && !stale) return { root, branch, from_commit, to_commit, installed: false };

  step("installing");
  const install = await run([...argv, ...installer.args], { cwd: root, timeoutMs: INSTALL_TIMEOUT_MS, unset: installer.unset });
  if (!install.ok) {
    const moved = to_commit !== from_commit;
    const pulled = moved ? ` (${root} is now at ${to_commit.slice(0, 7)}: the pull stands)` : "";
    // The clone was clean before the pull, so going back loses nothing.
    const self = moved && installer.self
      ? `. The installed mod is still the old version, but it runs hmod from the new code. To go back: \`git -C ${root} reset --hard ${from_commit.slice(0, 7)}\``
      : "";
    throw new HmodError(`\`${adapter.update}\` failed${pulled}${self}: ${install.output}`);
  }
  return { root, branch, from_commit, to_commit, installed: true };
}
