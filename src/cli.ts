#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { offeredBecause, cachedCheck, checkMods, type CheckEntry, type CheckResult } from "./check.ts";
import { HmodError, UsageError } from "./errors.ts";
import { linkRefusal, listMods, scanMods } from "./inventory.ts";
import { installMod } from "./modinstall.ts";
import { updateAll, updateOne, type UpdateEvent, type UpdateResult } from "./update.ts";
import type { ErrorResult, LinkLogEntry, LinkResult, ListResult, ModEntry, SourceRef, UnlinkResult } from "./model.ts";
import { logLink, sourceRef, updateSources } from "./store.ts";

const HELP = `hmod ${pkg.version}: the mods in your Herdr app, and where they came from

  hmod list [--json]                              every installed mod and its status
  hmod check [--cached] [--json]                  ask GitHub what's new, and offer possible sources for
                                                  unlinked mods by their content. It never links one:
                                                  that's hmod link. --cached shows the last answer,
                                                  with no network call
  hmod link <mod> <owner/repo> [--path mods/x] [--branch b] [--json]
                                                  record where a mod came from. Edits are kept safe:
                                                  the first check works out the version.
                                                  --path defaults to mods/<mod>, --branch to the
                                                  repo's default
  hmod unlink <mod> [--json]                      forget where a mod came from
  hmod update <mod> [--force] [--json]            install the newest version of a mod. Local edits stop
                                                  it, unless --force: a backup is made either way
  hmod update --all [--json]                      update every mod with an update, one at a time.
                                                  Modified, unlinked and error mods are skipped.
                                                  --json prints one line per step of progress
  hmod mod install [--json]                       put Mod updates in Herdr's mods folder
  hmod --version

Data: ~/.herdr-mod-updater ($HMOD_HOME overrides). Herdr: ~/.config/herdr-app ($HERDR_APP_HOME overrides).
`;

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const BAD_BRANCH = /^-|[\s~^:?*[\\]|\.\.|@\{/;

function repoPath(path: string): string {
  const clean = path.replace(/^\.\//, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  if (!clean || parts.some((p) => !p || p === "." || p === "..")) {
    throw new UsageError(`bad --path "${path}": it should be a folder in the repo, like mods/my-mod`);
  }
  return clean;
}

type Via = LinkLogEntry["via"];

async function link(mod: string, repo: string, opts: { path?: string; branch?: string }, via: Via): Promise<LinkResult> {
  if (!REPO.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) {
    throw new UsageError(`bad repo "${repo}": it should look like owner/repo`);
  }
  if (opts.branch !== undefined && (!opts.branch || BAD_BRANCH.test(opts.branch))) {
    throw new UsageError(`bad --branch "${opts.branch}"`);
  }
  const path = repoPath(opts.path ?? `mods/${mod}`);
  const branch = opts.branch ?? null;
  const item = scanMods().find((m) => m.name === mod);
  if (!item) throw new HmodError(`no mod called ${mod} in the mods folder`);
  const refusal = linkRefusal(item);
  if (refusal) throw new HmodError(`can't link: ${refusal}`);
  return updateSources((sources) => {
    const existing = sources[mod];
    if (existing) {
      if (existing.repo === repo && existing.path === path && existing.branch === branch) {
        return { ok: true, mod, source: sourceRef(existing), linked: false };
      }
      // Relinking would forget the baseline, and with it the installed commit.
      throw new HmodError(`${mod} is already linked to ${existing.repo}: run \`hmod unlink ${mod}\` first`);
    }
    const source: SourceRef = { repo, path, branch, commit: null };
    logLink({ event: "link", mod, repo, path, branch, via, offered_because: offeredBecause(mod, repo, path) });
    sources[mod] = { ...source, files: {} }; // Nothing from disk: it could be edits. A check fills this in.
    return { ok: true, mod, source, linked: true };
  });
}

function unlink(mod: string, via: Via): Promise<UnlinkResult> {
  return updateSources((sources) => {
    const existing = sources[mod];
    const unlinked = existing !== undefined;
    if (existing) {
      const { repo, path, branch } = existing;
      logLink({ event: "unlink", mod, repo, path, branch, via, offered_because: null });
    }
    delete sources[mod];
    return { ok: true, mod, unlinked };
  });
}

function modLine(m: ModEntry): string {
  const where = m.source ? `  ${m.source.repo}` : "";
  const extra = m.message ?? m.note;
  return `${m.name.padEnd(24)} ${m.status.padEnd(16)} ${m.title}${where}${extra ? `  (${extra})` : ""}`;
}

function listText(r: ListResult): string {
  return r.mods.map(modLine).join("\n") || "no mods installed";
}

function checkLine(m: CheckEntry): string {
  const behind = m.commits_behind ? ` ${m.commits_behind}${m.commits_behind_capped ? "+" : ""} behind` : "";
  const version = m.latest_version && m.latest_version !== m.installed_version ? ` -> ${m.latest_version}` : "";
  const offers = m.suggestions.map((s) => `\n    maybe ${s.repo} ${s.path}: ${s.why}`);
  return `${modLine(m)}${behind}${version}${offers.join("")}`;
}

function checkText(r: CheckResult): string {
  const when = r.cached ? `\nas of ${r.last_checked ?? "never: run hmod check"}` : "";
  return `${r.mods.map(checkLine).join("\n") || "no mods installed"}${when}`;
}

const short = (commit: string | null) => commit?.slice(0, 7) ?? "?";

function updateText(r: UpdateResult): string {
  if (!r.ok) return `${r.mod}: ${r.outcome.replace("_", " ")}: ${r.error}`;
  if (r.outcome === "up_to_date") return `${r.mod}: up to date`;
  const from = r.from_version ?? short(r.from_commit);
  const to = r.to_version ?? short(r.to_commit);
  const backup = r.backup ? ` (backup: ${r.backup})` : "";
  return [`${r.mod}: updated ${from} -> ${to}${backup}`, ...r.notes.map((n) => `  ${n}`)].join("\n");
}

function updateEventText(e: UpdateEvent): string | null {
  if (e.event === "result") return updateText(e.result);
  if (e.event !== "plan") return null;
  const skips = e.skipped.map((s) => `${s.mod}: skipped: ${s.reason}`);
  return [...skips, ...(e.mods.length ? [] : ["nothing to update"])].join("\n") || null;
}

function parse(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        path: { type: "string" },
        branch: { type: "string" },
        cached: { type: "boolean" },
        force: { type: "boolean" },
        all: { type: "boolean" },
        dialog: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e: any) {
    throw new UsageError(e.message);
  }
}

async function main(args: string[]): Promise<void> {
  const { values, positionals } = parse(args);
  const [command, ...rest] = positionals;
  const print = <T>(result: T, text: (r: T) => string): void => {
    process.stdout.write(`${values.json ? JSON.stringify(result) : text(result)}\n`);
  };

  if (values.version) return void process.stdout.write(`${pkg.version}\n`);
  if (values.help || !command) return void process.stdout.write(HELP);
  const noFlags = (...names: ("path" | "branch")[]) => {
    for (const n of names) if (values[n] !== undefined) throw new UsageError(`--${n} only goes with hmod link`);
  };

  if (values.cached && command !== "check") throw new UsageError("--cached only goes with hmod check");
  if (values.dialog && command !== "link" && command !== "unlink") throw new UsageError("--dialog only goes with hmod link and unlink");
  const via: Via = values.dialog ? "dialog" : "terminal";
  for (const flag of ["force", "all"] as const) {
    if (values[flag] && command !== "update") throw new UsageError(`--${flag} only goes with hmod update`);
  }

  switch (command) {
    case "check":
      noFlags("path", "branch");
      if (rest.length) throw new UsageError("usage: hmod check [--cached] [--json]");
      return print(await (values.cached ? cachedCheck() : checkMods()), checkText);
    case "list":
      noFlags("path", "branch");
      if (rest.length) throw new UsageError("usage: hmod list [--json]");
      return print(listMods(), listText);
    case "link": {
      const [mod, repo, ...more] = rest;
      if (!mod || !repo || more.length) {
        throw new UsageError("usage: hmod link <mod> <owner/repo> [--path mods/x] [--branch b] [--json]");
      }
      return print(await link(mod, repo, values, via), (r) => {
        const line = `${r.linked ? "linked" : "already linked"}: ${r.mod} -> ${r.source.repo} ${r.source.path}${r.source.branch ? ` (${r.source.branch})` : ""}`;
        return r.linked ? `${line}\nedits are kept safe, the first check works out the version` : line;
      });
    }
    case "unlink": {
      noFlags("path", "branch");
      const [mod, ...more] = rest;
      if (!mod || more.length) throw new UsageError("usage: hmod unlink <mod> [--json]");
      return print(await unlink(mod, via), (r) => `${r.unlinked ? "unlinked" : "wasn't linked"}: ${r.mod}`);
    }
    case "update": {
      noFlags("path", "branch");
      const [mod, ...more] = rest;
      if (more.length || (values.all === true) === (mod !== undefined) || (values.all && values.force)) {
        throw new UsageError("usage: hmod update <mod> [--force] [--json] or hmod update --all [--json]");
      }
      if (mod === undefined) {
        const { ok } = await updateAll((event) => {
          const line = values.json ? JSON.stringify(event) : updateEventText(event);
          if (line !== null) process.stdout.write(`${line}\n`);
        });
        if (!ok) process.exitCode = 1;
        return;
      }
      const result = await updateOne(mod, values.force === true);
      if (!result.ok) process.exitCode = 1;
      return print(result, updateText);
    }
    case "mod": {
      noFlags("path", "branch");
      if (rest.length !== 1 || rest[0] !== "install") throw new UsageError("usage: hmod mod install [--json]");
      return print(installMod(), (r) => r.lines.join("\n"));
    }
    default:
      throw new UsageError(`unknown command: ${command} (try hmod --help)`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof HmodError)) throw e;
  if (process.argv.includes("--json")) {
    const failure: ErrorResult = { ok: false, error: e.message };
    process.stdout.write(`${JSON.stringify(failure)}\n`);
  } else {
    process.stderr.write(`hmod: ${e.message}\n`);
  }
  process.exitCode = e.exitCode;
}
