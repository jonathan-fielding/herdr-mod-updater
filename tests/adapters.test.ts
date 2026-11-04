/** The hcoord adapter against real, temporary git repos. Nothing here leaves the temp folder. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHub } from "../src/github.ts";
import { updateAll, updateOne, type ModCheck, type UpdateEvent } from "../src/update.ts";
import { FakeGitHub } from "./fake-github.ts";
import { makeHomes, writeTree, type Homes } from "./helpers.ts";

/** Stands in for hcoord's CLI: `mod install` copies the clone's mod over the installed one. */
const TOOL = `#!/bin/sh
[ "$1 $2" = "mod install" ] || exit 9
[ -f fail-install ] && { echo "install broke" >&2; exit 3; }
cp "mods/hcoord/main.js" "$HERDR_APP_HOME/mods/hcoord/main.js"
`;
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let h: Homes;
let origin: string;
let clone: string;
/** Someone else's clone, to push new commits from. */
let upstream: string;
const installed = () => join(h.herdr, "mods", "hcoord");
const mainJs = () => readFileSync(join(installed(), "main.js"), "utf8");

const saveEnv = { HERDR_APP_HOME: process.env.HERDR_APP_HOME, HMOD_HOME: process.env.HMOD_HOME };
beforeEach(() => {
  h = makeHomes();
  process.env.HERDR_APP_HOME = h.herdr;
  process.env.HMOD_HOME = h.hmod;
  origin = join(h.other, "origin.git");
  clone = join(h.other, "clone");
  upstream = join(h.other, "upstream");
  Bun.spawnSync(["git", "init", "--quiet", "--bare", "-b", "main", origin]);
  git(h.other, "clone", "--quiet", origin, upstream);
  git(upstream, "checkout", "--quiet", "-b", "main");
  writeTree(upstream, {
    "mods/hcoord/main.js": "hcoord one",
    "mods/hcoord/mod.json": `{ "title": "Projects", "version": "1.0.0" }`,
    "mods/hcoord/hcoord-path.js": "export const HCOORD = null;",
    "tool.sh": TOOL,
  });
  commit("first");
  git(h.other, "clone", "--quiet", origin, clone);
  h.mod("hcoord", {
    "main.js": "hcoord one",
    "mod.json": `{ "title": "Projects", "version": "1.0.0" }`,
    "hcoord-path.js": `// Written by \`hcoord mod install\`: how this mod runs hcoord.\nexport const HCOORD = ${JSON.stringify(["/bin/sh", join(clone, "tool.sh")])};\n`,
    ".hcoord-installed": `${join(clone, "mods", "hcoord")}\n`,
  });
});
afterEach(() => {
  h.cleanup();
  for (const [key, value] of Object.entries(saveEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function commit(message: string): void {
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", message);
  git(upstream, "push", "--quiet", "origin", "main");
}

function newVersion(content = "hcoord two"): void {
  writeFileSync(join(upstream, "mods", "hcoord", "main.js"), content);
  commit("next");
}

/** GitHub must never be asked about this mod, and its files never checked in place. */
const deps = () => {
  const fake = new FakeGitHub({});
  const check: ModCheck = async () => {
    throw new Error("no herdr-app check here");
  };
  return { fake, gh: new GitHub({ fetch: fake.fetch }), check };
};
const update = (force = false) => updateOne("hcoord", force, deps());

describe("the hcoord adapter", () => {
  test("pulls the clone, then has the tool install its own mod", async () => {
    const before = git(clone, "rev-parse", "HEAD");
    newVersion();
    const d = deps();
    const r = await updateOne("hcoord", false, d);
    expect(r).toMatchObject({ ok: true, outcome: "updated", from_commit: before, to_commit: git(upstream, "rev-parse", "HEAD") });
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(mainJs()).toBe("hcoord two");
    expect(d.fake.requests).toEqual([]);
    expect(existsSync(join(h.hmod, "backups"))).toBe(false);
  });

  test("generated files stay as the tool left them", async () => {
    const path = readFileSync(join(installed(), "hcoord-path.js"), "utf8");
    newVersion();
    await update();
    expect(readFileSync(join(installed(), "hcoord-path.js"), "utf8")).toBe(path);
  });

  test("nothing new and nothing stale: no install", async () => {
    const r = await update();
    expect(r).toMatchObject({ ok: true, outcome: "up_to_date" });
  });

  test("the install lags a clone that's already current: installs", async () => {
    writeFileSync(join(installed(), "main.js"), "an older install");
    const r = await update();
    expect(r.outcome).toBe("updated");
    expect(mainJs()).toBe("hcoord one");
  });

  test("reports permissions the new version adds", async () => {
    newVersion(`await exec("ls");`);
    const r = await update();
    expect(r.new_permissions).toEqual(["exec"]);
  });

  test("a dirty tree is refused and left as it is", async () => {
    newVersion();
    writeFileSync(join(clone, "mods", "hcoord", "main.js"), "work in progress");
    const head = git(clone, "rev-parse", "HEAD");
    const r = await update();
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("uncommitted changes");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(clone, "mods", "hcoord", "main.js"), "utf8")).toBe("work in progress");
    expect(mainJs()).toBe("hcoord one");
  });

  test("--force doesn't get past a dirty tree", async () => {
    writeFileSync(join(clone, "untracked.txt"), "x");
    const r = await update(true);
    expect(r.outcome).toBe("refused");
    expect(existsSync(join(clone, "untracked.txt"))).toBe(true);
  });

  test("a detached HEAD is refused", async () => {
    git(clone, "checkout", "--quiet", "--detach");
    const r = await update();
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("isn't on a branch");
  });

  test("a branch that doesn't track origin is refused", async () => {
    git(clone, "checkout", "--quiet", "-b", "local-work");
    const r = await update();
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("doesn't track origin");
  });

  test("a branch tracking another remote is refused", async () => {
    git(clone, "remote", "add", "fork", origin);
    git(clone, "fetch", "--quiet", "fork");
    git(clone, "branch", "--quiet", "--set-upstream-to=fork/main", "main");
    expect((await update()).outcome).toBe("refused");
  });

  test("a diverged clone fails as git says, with its commits intact", async () => {
    newVersion();
    writeFileSync(join(clone, "local.txt"), "mine");
    git(clone, "add", "-A");
    git(clone, "commit", "--quiet", "-m", "local");
    const head = git(clone, "rev-parse", "HEAD");
    const r = await update();
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.error).toContain("git pull --ff-only failed");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(mainJs()).toBe("hcoord one");
  });

  test("a failed install is reported as it is, and says the pull stands", async () => {
    newVersion();
    writeFileSync(join(upstream, "fail-install"), "");
    commit("break it");
    const r = await update();
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.error).toContain("install broke");
    expect(r.error).toContain("the pull stands");
  });

  test("an origin token doesn't reach the error", async () => {
    git(clone, "remote", "set-url", "origin", `file://sekret@${join(h.other, "missing.git")}`);
    const r = await update();
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("sekret");
  });

  test.each([
    ["null, as a plain copy has it", "export const HCOORD = null;"],
    ["an empty list", "export const HCOORD = [];"],
    ["not JSON", "export const HCOORD = [run()];"],
    ["no constant", "export {};"],
  ])("hcoord-path.js holding %s is refused before the pull", async (_, content) => {
    writeFileSync(join(installed(), "hcoord-path.js"), content);
    newVersion();
    const head = git(clone, "rev-parse", "HEAD");
    const r = await update();
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });

  test("a source folder that's gone is refused", async () => {
    writeFileSync(join(installed(), ".hcoord-installed"), join(h.other, "gone", "mods", "hcoord"));
    const r = await update();
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    expect(r.error).toContain("gone");
  });

  test("--all updates it with the others", async () => {
    newVersion();
    const events: UpdateEvent[] = [];
    const { ok } = await updateAll((e) => events.push(e), deps());
    expect(ok).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: "done", updated: ["hcoord"] });
    const steps = events.flatMap((e) => (e.event === "step" ? [e.step] : []));
    expect(steps).toEqual(["pulling", "installing"]);
    expect(mainJs()).toBe("hcoord two");
    expect(readdirSync(h.hmod)).not.toContain("backups");
  });
});
