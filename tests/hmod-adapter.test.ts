/**
 * The hmod adapter: hmod updating its own mod, against real, temporary git repos. The clone holds a
 * copy of this repo's own code, so the update runs the real CLI, out of the clone it's pulling.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorOf, makeHomes, writeTree, type Homes } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..");
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let h: Homes;
let clone: string;
/** Someone else's clone, to push new commits from. */
let upstream: string;
const installed = () => join(h.herdr, "mods", "mod-updater");
const read = (rel: string) => readFileSync(join(installed(), rel), "utf8");
const argvIn = (text: string): string[] => JSON.parse(/\bHMOD = (.*);/.exec(text)![1]!);

/** Runs the clone's CLI as a person's shell would. HMOD_GITHUB_API: nothing may reach the real GitHub. */
function hmod(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(clone, "src", "cli.ts"), ...args], {
    env: { ...process.env, HOME: join(h.other, "home"), HMOD_GITHUB_API: "http://127.0.0.1:9", HERDR_APP_HOME: h.herdr, HMOD_HOME: h.hmod, ...env },
  });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
const update = (env: Record<string, string> = {}) => JSON.parse(hmod(env, "update", "mod-updater", "--json").stdout);

function push(files: Record<string, string>): string {
  writeTree(upstream, files);
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "next");
  git(upstream, "push", "--quiet", "origin", "main");
  return git(upstream, "rev-parse", "HEAD");
}

beforeEach(() => {
  h = makeHomes();
  const origin = join(h.other, "origin.git");
  clone = join(h.other, "clone");
  upstream = join(h.other, "upstream");
  Bun.spawnSync(["git", "init", "--quiet", "--bare", "-b", "main", origin]);
  git(h.other, "clone", "--quiet", origin, upstream);
  git(upstream, "checkout", "--quiet", "-b", "main");
  for (const rel of ["src", "mods", "package.json", ".gitignore"]) cpSync(join(REPO, rel), join(upstream, rel), { recursive: true });
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "first");
  git(upstream, "push", "--quiet", "origin", "main");
  git(h.other, "clone", "--quiet", origin, clone);
  const setUp = hmod({}, "mod", "install");
  if (setUp.code !== 0) throw new Error(setUp.stderr);
});
afterEach(() => {
  h.cleanup();
});

describe("hmod seeing its own mod", () => {
  test("an installed copy is clone-installed, and its generated file doesn't count as a change", () => {
    expect(JSON.parse(hmod({}, "list", "--json").stdout).mods).toMatchObject([
      {
        name: "mod-updater",
        kind: "clone-installed",
        adapter: "hmod",
        status: "up_to_date",
        adapter_source: join(clone, "mods", "mod-updater"),
      },
    ]);
  });

  test("behind its clone, it needs an update", () => {
    writeFileSync(join(installed(), "main.js"), "older");
    expect(JSON.parse(hmod({}, "list", "--json").stdout).mods[0]).toMatchObject({
      status: "update_available",
      changed: ["main.js"],
      note: expect.stringContaining("hmod mod install"),
    });
  });

  test("linking it is refused, and records nothing", () => {
    const r = hmod({}, "link", "mod-updater", "someone/herdr-mod-updater", "--json");
    expect(r.code).toBe(1);
    expect(errorOf(r)).toContain("update it with `hmod mod install`");
    expect(existsSync(join(h.hmod, "sources.json"))).toBe(false);
  });

  test("a source linked before it was installed is ignored: GitHub's copy never lands on it", () => {
    writeTree(h.hmod, {
      "sources.json": JSON.stringify({ "mod-updater": { repo: "someone/repo", path: "mods/mod-updater", branch: null, commit: null, files: {} } }),
    });
    const generated = read("hmod-path.js");
    const next = push({ "mods/mod-updater/main.js": "version two" });
    expect(update()).toMatchObject({ ok: true, outcome: "updated", to_commit: next });
    expect(read("main.js")).toBe("version two");
    expect(read("hmod-path.js")).toBe(generated);
  });
});

describe("hmod updating itself", () => {
  test("pulls the clone it's running from, then installs from the new code", () => {
    const before = git(clone, "rev-parse", "HEAD");
    const cli = read("hmod-path.js");
    const next = push({
      "mods/mod-updater/main.js": "version two",
      // The install has to come from what was just pulled, not from the process doing the update.
      "src/modinstall.ts": readFileSync(join(clone, "src", "modinstall.ts"), "utf8").replace(
        'const files = readdirSync',
        'writeFileSync(join(dest, "pulled-code-ran"), "");\n  const files = readdirSync',
      ),
    });
    expect(update()).toMatchObject({ ok: true, outcome: "updated", from_commit: before, to_commit: next });
    expect(git(clone, "rev-parse", "HEAD")).toBe(next);
    expect(read("main.js")).toBe("version two");
    expect(existsSync(join(installed(), "pulled-code-ran"))).toBe(true);
    expect(read("hmod-path.js")).toBe(cli);
    expect(existsSync(join(h.hmod, "backups"))).toBe(false);
    expect(hmod({}, "list", "--json").code).toBe(0);
  });

  test("the argv and the data folder survive, and never become the committed null", () => {
    const argv = argvIn(read("hmod-path.js"));
    expect(argv).toContain(`HMOD_HOME=${h.hmod}`);
    push({ "mods/mod-updater/main.js": "version two" });
    expect(update().ok).toBe(true);
    expect(argvIn(read("hmod-path.js"))).toEqual(argv);
    expect(read("hmod-path.js")).toContain(`HMOD_DATA = ${JSON.stringify(h.hmod)}`);
  });

  test("a different HMOD_HOME in the shell doesn't replace the mod's data folder", () => {
    const argv = argvIn(read("hmod-path.js"));
    const shell = join(h.other, "shell-data");
    push({ "mods/mod-updater/main.js": "version two" });
    expect(update({ HMOD_HOME: shell }).ok).toBe(true);
    expect(read("main.js")).toBe("version two");
    expect(argvIn(read("hmod-path.js"))).toEqual(argv);
    expect(read("hmod-path.js")).toContain(`HMOD_DATA = ${JSON.stringify(h.hmod)}`);
  });

  test("a default data folder stays the default whatever the shell has", () => {
    // Installed with no HMOD_HOME: the argv doesn't name one, and HMOD_DATA is under HOME.
    expect(hmod({ HMOD_HOME: "" }, "mod", "install").code).toBe(0);
    const generated = read("hmod-path.js");
    expect(generated).not.toContain("HMOD_HOME=");
    const shell = join(h.other, "shell-data");
    push({ "mods/mod-updater/main.js": "version two" });
    expect(update({ HMOD_HOME: shell }).ok).toBe(true);
    expect(read("main.js")).toBe("version two");
    expect(read("hmod-path.js")).toBe(generated);
  });

  test("--all updates it too", () => {
    push({ "mods/mod-updater/main.js": "version two" });
    expect(hmod({}, "check", "--json").code).toBe(0);
    const events = hmod({}, "update", "--all", "--json").stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ event: "done", ok: true, updated: ["mod-updater"] });
    expect(read("main.js")).toBe("version two");
  });

  test("the new code not starting is a clear failure, and says how to go back", () => {
    const before = git(clone, "rev-parse", "HEAD");
    const old = read("main.js");
    const generated = read("hmod-path.js");
    const next = push({ "mods/mod-updater/main.js": "version two", "src/cli.ts": "this is ( not code" });
    const r = update();
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.error).toContain("`hmod mod install` failed");
    expect(r.error).toContain(`now at ${next.slice(0, 7)}: the pull stands`);
    expect(r.error).toContain(`git -C ${clone} reset --hard ${before.slice(0, 7)}`);
    expect(read("main.js")).toBe(old);
    expect(read("hmod-path.js")).toBe(generated);

    // The way back it names really works.
    git(clone, "reset", "--hard", before.slice(0, 7));
    expect(JSON.parse(hmod({}, "list", "--json").stdout).mods[0].status).toBe("up_to_date");
  });

  test("a failed install with nothing pulled doesn't offer a way back", () => {
    const pathFile = join(installed(), "hmod-path.js");
    writeFileSync(join(installed(), "main.js"), "older");
    writeFileSync(pathFile, `export const HMOD = ["/bin/sh", "-c", "echo install broke >&2; exit 3", "sh"];\nexport const HMOD_DATA = "/x";\n`);
    const r = update();
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.error).toContain("install broke");
    expect(r.error).not.toContain("reset --hard");
  });

  test("a dirty clone is refused and left as it is", () => {
    const next = push({ "mods/mod-updater/main.js": "version two" });
    writeFileSync(join(clone, "src", "wip.ts"), "work in progress");
    const r = update();
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("uncommitted changes");
    expect(git(clone, "rev-parse", "HEAD")).not.toBe(next);
    expect(existsSync(join(clone, "src", "wip.ts"))).toBe(true);
  });

  test("a marker with an unset hmod-path.js is refused before the pull", () => {
    const head = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(installed(), "hmod-path.js"), "export const HMOD = null;\nexport const HMOD_DATA = null;\n");
    push({ "mods/mod-updater/main.js": "version two" });
    const r = update();
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("hmod mod install");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("a plain copy, as Herdr's gallery leaves it", () => {
  const COMMITTED = "export const HMOD = null;\nexport const HMOD_DATA = null;\n";
  beforeEach(() => {
    h.cleanup();
    h = makeHomes();
    h.mod("mod-updater", { "main.js": "copy", "mod.json": `{ "title": "Mod updates" }`, "hmod-path.js": COMMITTED });
  });

  test("is an ordinary unlinked mod, not clone-installed", () => {
    expect(h.entry("mod-updater")).toMatchObject({ kind: "third-party", adapter: null, status: "unlinked", adapter_source: null });
  });

  test("update is refused with what to do next, and changes nothing", () => {
    const r = JSON.parse(h.run("update", "mod-updater", "--json").stdout);
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("no source known");
    expect(read("hmod-path.js")).toBe(COMMITTED);
  });

  test("can be linked, since there's nothing generated to lose", () => {
    const r = h.json("link", "mod-updater", "someone/herdr-mod-updater");
    expect(r).toMatchObject({ ok: true, linked: true });
    expect(h.entry("mod-updater")).toMatchObject({ kind: "third-party", status: "up_to_date" });
  });

  test("once set up it's clone-installed, and a link from before stops counting", () => {
    h.json("link", "mod-updater", "someone/herdr-mod-updater");
    expect(h.run("mod", "install").code).toBe(0);
    expect(h.entry("mod-updater")).toMatchObject({ kind: "clone-installed", adapter: "hmod", source: null });
    expect(argvIn(read("hmod-path.js")).length).toBeGreaterThan(0);
  });
});
