// The mod (mods/mod-updater/main.js) runs inside Herdr; here it's loaded with stand-ins for Herdr's
// modules so its rows and its jobs can be checked without the app.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = join(import.meta.dir, "..", "mods", "mod-updater");
const TEMP = realpathSync(mkdtempSync(join(tmpdir(), "hmod-mod-test-")));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

// A copy of the mod beside the hmod-path.js that `hmod mod install` would write.
const MOD = join(TEMP, "mod");
const COPY = join(TEMP, "copy");
const DATA = join(TEMP, "data");
const CLI = join(TEMP, "fake-hmod.sh");
for (const dir of [MOD, COPY]) {
  Bun.spawnSync(["mkdir", "-p", dir]);
  copyFileSync(join(SOURCE, "main.js"), join(dir, "main.js"));
}
copyFileSync(join(SOURCE, "hmod-path.js"), join(COPY, "hmod-path.js")); // As Herdr's gallery would.
writeFileSync(join(MOD, "hmod-path.js"), `export const HMOD = ["/bin/sh", ${JSON.stringify(CLI)}];\nexport const HMOD_DATA = ${JSON.stringify(DATA)};\n`);

const world = {
  shared: {} as Record<string, unknown>,
  props: {} as any,
  timers: [] as { ms: number; fn: (cx: any) => void }[],
  overlays: [] as any[],
  closed: [] as string[],
  /** Commands the mod ran. */
  ran: [] as { name: string; args: unknown }[],
  /** hmod commands that ran through exec and returned. */
  calls: [] as string[][],
  /** hmod commands started as detached jobs. */
  jobs: [] as string[][],
  cached: null as any,
  answers: {} as Record<string, { code: number; stdout: string; stderr: string }>,
  execError: null as Error | null,
  /** What's in the job log. null: no file. */
  log: null as string | null,
  alive: true,
  /** Run sh for real, and read the real log. */
  real: false,
};

class FakeInput {
  text: string;
  handlers: any = {};
  constructor(o: { value?: string }) {
    this.text = o.value ?? "";
  }
  static new(o: { value?: string }) {
    return new FakeInput(o);
  }
  value() {
    return this.text;
  }
  on(ev: string, fn: (e: any, cx: any) => void) {
    this.handlers[ev] = fn;
  }
  set_value(v: string) {
    this.text = v;
  }
  focus() {}
}

const NUMERIC = new Set(["flex_shrink", "flex_grow", "gap", "p", "px", "py", "pt", "pb", "mx", "mb", "h", "w", "min_w", "min_h", "rounded", "text_size", "opacity", "border"]);

/** A stand-in element: any builder call chains; children, ids and clicks are kept for the test to read. */
function el(...args: any[]) {
  const node: any = { args, kids: [] as any[], elementId: null, click: null };
  const self: any = new Proxy(node, {
    get(n, k) {
      if (k in n) return n[k];
      if (k === "child") return (c: any) => (n.kids.push(c), self);
      if (k === "children") return (cs: any[]) => (n.kids.push(...cs), self);
      if (k === "when") return (c: any, f: (e: any) => any) => (c ? f(self) : self);
      if (k === "id") return (id: string) => ((n.elementId = id), self);
      if (k === "on_click") return (f: any) => ((n.click = f), self);
      // Real GPUI throws on these without a number, which a forgiving stand-in would hide.
      if (NUMERIC.has(String(k))) {
        return (v: unknown) => {
          if (typeof v !== "number") throw new Error(`${String(k)} expected a number, got ${v}`);
          return self;
        };
      }
      return () => self;
    },
  });
  return self;
}
const walk = (e: any): any[] => (e?.kids ? [e, ...e.kids.flatMap(walk)] : [e]);
const textOf = (e: any) => walk(e).filter((x) => typeof x === "string").join(" ");
const byId = (tree: any, id: string) => walk(tree).find((e) => e?.elementId === id);

async function sh(args: string[]) {
  const p = Bun.spawn(["/bin/sh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

mock.module("gpui-kit", () => ({ View: class {}, div: el }));
mock.module("gpui-base", () => ({ v_flex: el, h_flex: el, InputState: FakeInput, Input: { new: () => el() } }));
mock.module("herdr", () => ({
  exec: async (cmd: string, args: string[]) => {
    if (world.execError) throw world.execError;
    if (cmd === "/bin/sh" && args[0] === "-c") {
      if (world.real) return sh(args);
      if (args[1]!.startsWith("kill -0")) return { code: world.alive ? 0 : 1, stdout: "", stderr: "" };
      // args: -c START RUNNER log header /bin/sh CLI ...hmod args
      world.jobs.push(args.slice(7));
      world.log = "";
      return { code: 0, stdout: "", stderr: "" };
    }
    const hmod = args.slice(1);
    world.calls.push(hmod);
    const key = hmod.slice(0, 2).join(" ");
    return world.answers[key] ?? { code: 0, stdout: JSON.stringify(world.cached), stderr: "" };
  },
  readTextFile: async (path: string) => {
    if (world.real) return existsSync(path) ? Bun.file(path).text() : null;
    return world.log;
  },
  theme: () => new Proxy({}, { get: (_t, k) => String(k) }),
  home: () => TEMP,
  props: () => world.props,
  openOverlay: (o: any) => void world.overlays.push(o),
  closeOverlay: (id: string) => void world.closed.push(id),
  run: (name: string, args: unknown) => void world.ran.push({ name, args }),
  shared: (k: string) => world.shared[k] ?? null,
  setShared: (k: string, v: unknown) => void (world.shared[k] = v),
}));

const { default: ModUpdates } = await import(join(MOD, "main.js"));
const { default: PlainCopy } = await import(join(COPY, "main.js"));

function makeCx() {
  const tasks: Promise<unknown>[] = [];
  const cx: any = {
    spawn: (fn: (cx: any) => Promise<unknown>) => void tasks.push(Promise.resolve().then(() => fn(cx))),
    notify: () => {},
    timer: { every: (ms: number, fn: (cx: any) => void) => world.timers.push({ ms, fn }), after: () => {} },
    focus_handle: () => ({ focus() {} }),
    stop_propagation: () => {},
    async settle() {
      while (tasks.length) await tasks.shift();
    },
  };
  return cx;
}

const entry = (name: string, status: string, more: any = {}) => ({
  name, title: name, kind: "third-party", status, message: null, note: null, dir: `/mods/${name}`, source: null,
  cloned_from: null, adapter: null, adapter_source: null, changed: [], remote_checked: true, update_available: false,
  commits_behind: null, commits_behind_capped: false, installed_version: null, latest_version: null, latest_commit: null,
  suggestions: [], checked_at: null, clone: null, ...more,
});
const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const checked = (mods: any[], last_checked: string | null = minutesAgo(5)) => ({
  ok: true, herdr_home: "/h", cached: true, authenticated: null, last_checked, rate_limit_reset: null, mods,
});
const available = (name: string, more: any = {}) =>
  entry(name, "update_available", { update_available: true, installed_version: "1.0.0", latest_version: "1.2.0", commits_behind: 3, ...more });

beforeEach(() => {
  Object.assign(world, {
    shared: {}, props: {}, timers: [], overlays: [], closed: [], ran: [], calls: [], jobs: [], answers: {},
    execError: null, log: null, alive: true, real: false, cached: checked([]),
  });
});

async function start(View: any = ModUpdates, cx = makeCx()) {
  const v: any = new View();
  v.init({}, cx);
  await cx.settle();
  return { v, cx };
}
const tree = (s: { v: any; cx: any }) => s.v.render(s.cx);
const press = async (s: { v: any; cx: any }, id: string) => {
  const target = byId(tree(s), id);
  expect(target?.click).toBeTruthy();
  target.click(null, s.cx);
  await s.cx.settle();
};
const poll = async (s: { cx: any }) => {
  for (const t of world.timers.filter((t) => t.ms === 500)) t.fn(s.cx);
  await s.cx.settle();
};
const rowText = (s: { v: any; cx: any }, name: string) => textOf(byId(tree(s), `mu-row-${name}`));
/** The log of the job that's running: its header, then these lines. */
const logOf = (job: any, ...lines: any[]) =>
  [JSON.stringify({ event: "job", id: world.shared["mod-updater.job"], ...job }), `{"event":"pid","pid":4242}`, ...lines.map((l) => JSON.stringify(l))].join("\n") + "\n";
const result = (mod: string, more: any = {}) => ({
  ok: true, mod, outcome: "updated", error: null, to_version: "1.2.0", notes: [], ...more,
});

describe("when the CLI can't be run", () => {
  test("a plain copy says how to set it up, and tries nothing", async () => {
    const s = await start(PlainCopy);
    const t = tree(s);
    expect(textOf(t)).toContain("needs the hmod CLI");
    expect(byId(t, "mu-all").click).toBeNull();
    expect(byId(t, "mu-check").click).toBeNull();
    expect(world.calls).toEqual([]);
    expect(world.timers).toEqual([]);
    let opened = "";
    byId(t, "mu-setup").click(null, { open_url: (u: string) => (opened = u) });
    expect(opened).toContain("herdr-mod-updater");
  });

  test("a CLI that's gone shows the same notice", async () => {
    world.answers["check --cached"] = { code: 1, stdout: "", stderr: "error: Module not found cli.ts" };
    const s = await start();
    expect(textOf(tree(s))).toContain("needs the hmod CLI");
    expect(world.jobs).toEqual([]);
  });

  test("exec failing shows it too", async () => {
    world.execError = new Error("no such program");
    expect(textOf(tree(await start()))).toContain("needs the hmod CLI");
  });

  test("hmod failing shows its error, and no check runs", async () => {
    world.answers["check --cached"] = { code: 1, stdout: `{"ok":false,"error":"no Herdr mods folder"}`, stderr: "" };
    expect(textOf(tree(await start()))).toContain("no Herdr mods folder");
    expect(world.jobs).toEqual([]);
  });
});

describe("on open", () => {
  test("shows cached results and doesn't check when they're recent", async () => {
    world.cached = checked([available("quota")]);
    const s = await start();
    expect(world.calls).toEqual([["check", "--cached", "--json"]]);
    expect(world.jobs).toEqual([]);
    expect(textOf(tree(s))).toContain("Checked 5m ago");
    expect(rowText(s, "quota")).toContain("Update available");
  });

  test("checks when they're over 6 hours old, with the old results showing meanwhile", async () => {
    world.cached = checked([available("quota")], minutesAgo(6 * 60 + 1));
    const s = await start();
    expect(world.jobs).toEqual([["check", "--json"]]);
    expect(textOf(tree(s))).toContain("Checking…");
    expect(rowText(s, "quota")).toContain("Update available");
  });

  test("checks when there's never been one", async () => {
    world.cached = checked([], null);
    await start();
    expect(world.jobs).toEqual([["check", "--json"]]);
  });
});

describe("the header", () => {
  test("Update all counts what can go, and is disabled at 0", async () => {
    world.cached = checked([entry("mine", "modified"), entry("a", "up_to_date")]);
    let t = tree(await start());
    expect(textOf(t)).toContain("Update all (0)");
    expect(byId(t, "mu-all").click).toBeNull();

    world.cached = checked([available("one"), available("two"), entry("mine", "modified")]);
    t = tree(await start());
    expect(textOf(t)).toContain("Update all (2)");
    expect(byId(t, "mu-all").click).toBeTruthy();
  });

  test("Check for updates runs a check, and its result replaces the list", async () => {
    const s = await start();
    await press(s, "mu-check");
    expect(world.jobs).toEqual([["check", "--json"]]);
    expect(byId(tree(s), "mu-check").click).toBeNull();

    world.log = logOf({ kind: "check" }, checked([available("fresh")], minutesAgo(0)), { event: "exit", code: 0 });
    await poll(s);
    expect(rowText(s, "fresh")).toContain("1.0.0 → 1.2.0");
    expect(textOf(tree(s))).toContain("Checked just now");
    expect(byId(tree(s), "mu-check").click).toBeTruthy();
  });

  test("says when GitHub's limit stopped a check", async () => {
    const s = await start();
    await press(s, "mu-check");
    world.log = logOf({ kind: "check" }, { ...checked([]), rate_limit_reset: new Date().toISOString() }, { event: "exit", code: 0 });
    await poll(s);
    expect(textOf(tree(s))).toContain("rate limit");
  });
});

describe("rows", () => {
  test("update_available: version, commits behind and Update", async () => {
    world.cached = checked([available("quota")]);
    const s = await start();
    const text = rowText(s, "quota");
    expect(text).toContain("1.0.0 → 1.2.0");
    expect(text).toContain("3 commits behind");
    await press(s, "mu-act-quota");
    expect(world.jobs).toEqual([["update", "quota", "--json"]]);
    expect(rowText(s, "quota")).toContain("Updating");
    expect(byId(tree(s), "mu-act-quota")).toBeUndefined();
  });

  test("a capped count says so", async () => {
    world.cached = checked([available("quota", { commits_behind: 100, commits_behind_capped: true })]);
    expect(rowText(await start(), "quota")).toContain("100+ commits behind");
  });

  test("modified: Edited locally, and Update asks first without starting anything", async () => {
    world.cached = checked([entry("mine", "modified", { update_available: true, changed: ["main.js"], source: { repo: "o/r" } })]);
    const s = await start();
    expect(rowText(s, "mine")).toContain("Edited locally");
    await press(s, "mu-act-mine");
    expect(world.jobs).toEqual([]);
    expect(world.overlays).toHaveLength(1);
    expect(world.overlays[0]).toMatchObject({ mod: "mod-updater", kind: "dialog", props: { ask: { mod: "mine", changed: ["main.js"], repo: "o/r" } } });
  });

  test("modified with nothing newer has no button: it would do nothing", async () => {
    world.cached = checked([entry("mine", "modified", { update_available: false, remote_checked: true })]);
    const s = await start();
    expect(rowText(s, "mine")).toContain("No update to install");
    expect(byId(tree(s), "mu-act-mine")).toBeUndefined();
  });

  test("modified but never checked keeps its button", async () => {
    world.cached = checked([entry("mine", "modified", { remote_checked: false })]);
    expect(byId(tree(await start()), "mu-act-mine").click).toBeTruthy();
  });

  test("error: the message, and Retry checks again", async () => {
    world.cached = checked([entry("bad", "error", { message: "repo is gone" })]);
    const s = await start();
    expect(rowText(s, "bad")).toContain("repo is gone");
    await press(s, "mu-act-bad");
    expect(world.jobs).toEqual([["check", "--json"]]);
  });

  describe("source_changed", () => {
    const held = (more: any = {}) => entry("quota", "source_changed", { note: "o/r has a new owner: it's x/r now, owned by x.", source: { repo: "o/r" }, ...more });

    test("says what changed, offers Confirm again and Unlink, and no Update", async () => {
      world.cached = checked([held()]);
      const s = await start();
      expect(rowText(s, "quota")).toContain("Source changed");
      expect(rowText(s, "quota")).toContain("has a new owner");
      expect(byId(tree(s), "mu-act-quota")).toBeUndefined();
      expect(textOf(tree(s))).toContain("Confirm again");
      expect(textOf(tree(s))).toContain("Unlink");
      expect(rowText(s, "quota")).not.toContain("Update");
    });

    test("doesn't count towards Update all or the status bar", async () => {
      world.cached = checked([held()]);
      expect(textOf(tree(await start()))).toContain("Update all (0)");
    });

    test("Confirm again confirms, then checks; nothing happens until it's pressed", async () => {
      world.cached = checked([held()]);
      const s = await start();
      expect(world.calls.some((c) => c[0] === "confirm")).toBe(false);
      await press(s, "mu-act-quota-confirm");
      expect(world.calls.some((c) => c[0] === "confirm")).toBe(false);
      await press(s, "mu-trust-yes");
      expect(world.calls.at(-1)).toEqual(["confirm", "quota", "--dialog", "--json"]);
      expect(world.jobs).toEqual([["check", "--json"]]);
    });

    test("Unlink unlinks, then checks", async () => {
      world.cached = checked([held()]);
      const s = await start();
      await press(s, "mu-act-quota-unlink");
      expect(world.calls.at(-1)).toEqual(["unlink", "quota", "--dialog", "--json"]);
      expect(world.jobs).toEqual([["check", "--json"]]);
    });

    test("a refusal shows in the row, which keeps its choices", async () => {
      world.cached = checked([held()]);
      world.answers["confirm quota"] = { code: 1, stdout: JSON.stringify({ ok: false, error: "GitHub said 500" }), stderr: "" };
      const s = await start();
      await press(s, "mu-act-quota-confirm");
      await press(s, "mu-trust-yes");
      expect(rowText(s, "quota")).toContain("GitHub said 500");
      expect(byId(tree(s), "mu-act-quota-unlink")).toBeTruthy();
      expect(world.jobs).toEqual([]);
    });

    test("skipped by Update all, it still reads Source changed", async () => {
      world.cached = checked([held()]);
      const s = await start();
      s.v.rows = { quota: { state: "skipped", reason: "o/r has a new owner" } };
      expect(rowText(s, "quota")).toContain("Source changed");
      expect(rowText(s, "quota")).not.toContain("Skipped");
    });
  });

  test("up-to-date and Herdr's mods are folded, with no buttons", async () => {
    world.cached = checked([entry("a", "up_to_date", { installed_version: "2.0" }), entry("agents", "herdr", { kind: "herdr" })]);
    const s = await start();
    expect(textOf(tree(s))).toContain("Up to date (1)");
    expect(textOf(tree(s))).toContain("Updated with Herdr (1)");
    expect(textOf(tree(s))).not.toContain("agents");
    await press(s, "mu-fold-up");
    await press(s, "mu-fold-herdr");
    expect(textOf(tree(s))).toContain("2.0");
    expect(textOf(tree(s))).toContain("agents");
    expect(byId(tree(s), "mu-act-a")).toBeUndefined();
    expect(byId(tree(s), "mu-act-agents")).toBeUndefined();
  });

  test("clones are folded and offer nothing; this mod isn't offered a source", async () => {
    world.cached = checked([entry("my-files", "unlinked", { cloned_from: { name: "files" } }), entry("mod-updater", "unlinked")]);
    const s = await start();
    expect(byId(tree(s), "mu-row-my-files")).toBeUndefined();
    expect(byId(tree(s), "mu-row-mod-updater")).toBeUndefined();
    expect(textOf(tree(s))).toContain("Your clones (1)");
    expect(textOf(tree(s))).toContain("Nothing needs you.");
  });
});

describe("Link source", () => {
  const suggestion = { repo: "a/quota", path: "mods/q", why: "same files as a commit", exact: true, commit: "abc" };
  const linked = { code: 0, stdout: `{"ok":true}`, stderr: "" };
  const opened = async () => {
    world.cached = checked([entry("quota", "unlinked", { suggestions: [suggestion] })]);
    const s = await start();
    await press(s, "mu-act-quota");
    return s;
  };
  const typed = async (s: any, text: string) => {
    s.v.linkInput.set_value(text);
    await press(s, "mu-link");
    if (byId(tree(s), "mu-trust-yes")) await press(s, "mu-trust-yes");
  };

  test("shows suggestions and a field, and linking one checks again", async () => {
    const s = await opened();
    expect(rowText(s, "quota")).toContain("a/quota · mods/q");
    expect(rowText(s, "quota")).toContain("same files as a commit");
    world.answers["link quota"] = linked;
    await press(s, "mu-offer-0");
    expect(world.calls.some((c) => c[0] === "link")).toBe(false);
    await press(s, "mu-trust-yes");
    expect(world.calls.at(-1)).toEqual(["link", "quota", "a/quota", "--path", "mods/q", "--dialog", "--json"]);
    expect(world.jobs).toEqual([["check", "--json"]]);
    expect(byId(tree(s), "mu-link")).toBeUndefined();
  });

  test("a typed owner/repo leaves the folder to hmod", async () => {
    const s = await opened();
    world.answers["link quota"] = linked;
    await typed(s, " me/my-mods ");
    expect(world.calls.at(-1)).toEqual(["link", "quota", "me/my-mods", "--dialog", "--json"]);
  });

  test("Enter in the field links too", async () => {
    const s = await opened();
    world.answers["link quota"] = linked;
    s.v.linkInput.set_value("me/my-mods");
    s.v.linkInput.handlers.submit(null, s.cx);
    await s.cx.settle();
    await press(s, "mu-trust-yes");
    expect(world.calls.at(-1)).toEqual(["link", "quota", "me/my-mods", "--dialog", "--json"]);
  });

  test("a pasted GitHub folder URL gives the repo and its folder", async () => {
    const s = await opened();
    world.answers["link quota"] = linked;
    await typed(s, "https://github.com/me/my-mods/tree/main/mods/other/");
    expect(world.calls.at(-1)).toEqual(["link", "quota", "me/my-mods", "--path", "mods/other", "--dialog", "--json"]);
  });

  test("something that isn't a repo doesn't reach hmod", async () => {
    const s = await opened();
    await typed(s, "quota");
    expect(world.calls.some((c) => c[0] === "link")).toBe(false);
    expect(rowText(s, "quota")).toContain("owner/repo");
  });

  test("hmod's refusal shows in the row, which stays open", async () => {
    const s = await opened();
    world.answers["link quota"] = { code: 1, stdout: `{"ok":false,"error":"quota is already linked"}`, stderr: "" };
    await typed(s, "me/x");
    expect(rowText(s, "quota")).toContain("already linked");
    expect(world.jobs).toEqual([]);
  });

  test("the button folds it away again", async () => {
    const s = await opened();
    await press(s, "mu-act-quota");
    expect(byId(tree(s), "mu-link")).toBeUndefined();
  });
});

describe("Update all", () => {
  const plan = { event: "plan", mods: ["one", "two", "three"], skipped: [{ mod: "mine", status: "modified", reason: "has local edits" }, { mod: "mod-updater", status: "unlinked", reason: "no source known" }] };
  const running = async () => {
    world.cached = checked([available("one"), available("two"), available("three"), entry("mine", "modified", { changed: ["main.js"], update_available: true }), entry("nope", "unlinked")]);
    const s = await start();
    await press(s, "mu-all");
    return s;
  };

  test("runs hmod update --all --json, and rows change one by one", async () => {
    const s = await running();
    expect(world.jobs).toEqual([["update", "--all", "--json"]]);
    expect(textOf(tree(s))).toContain("Checking before updating");

    world.log = logOf({ kind: "all" }, plan);
    await poll(s);
    expect(rowText(s, "one")).toContain("Waiting");
    expect(rowText(s, "mine")).toContain("Skipped");
    expect(rowText(s, "mine")).toContain("has local edits");

    world.log = logOf({ kind: "all" }, plan, { event: "step", mod: "one", step: "backing_up" });
    await poll(s);
    expect(rowText(s, "one")).toContain("Updating: backing up");
    expect(rowText(s, "two")).toContain("Waiting");

    const first = { event: "result", mod: "one", result: result("one") };
    world.log = logOf({ kind: "all" }, plan, first, { event: "step", mod: "two", step: "downloading" });
    await poll(s);
    expect(rowText(s, "one")).toContain("Updated");
    expect(rowText(s, "one")).toContain("Now at 1.2.0");
    expect(rowText(s, "two")).toContain("Updating: downloading");
    expect(rowText(s, "three")).toContain("Waiting");
  });

  test("every button is disabled while it runs", async () => {
    const s = await running();
    world.log = logOf({ kind: "all" }, plan, { event: "result", mod: "one", result: result("one", { ok: false, outcome: "failed", error: "boom" }) });
    await poll(s);
    const t = tree(s);
    for (const id of ["mu-all", "mu-check", "mu-act-one", "mu-act-mine", "mu-act-nope"]) expect(byId(t, id).click).toBeNull();
  });

  test("ends with a summary: what's skipped, failures, keys and permission notes", async () => {
    const s = await running();
    const keys = "o/r's keys.json changed. hmod never merges it: add any keys you want to your own keys.json.";
    const perms = "The new version adds what the old one didn't have: it runs programs (exec).";
    world.cached = checked([available("two"), entry("one", "up_to_date"), entry("three", "up_to_date"), entry("mine", "modified", { changed: ["main.js"] })]);
    world.log = logOf(
      { kind: "all" }, plan,
      { event: "result", mod: "one", result: result("one", { notes: [keys, perms] }) },
      { event: "result", mod: "two", result: result("two", { ok: false, outcome: "rolled_back", error: "failed herdr-app check" }) },
      { event: "result", mod: "three", result: result("three", { outcome: "up_to_date" }) },
      { event: "done", ok: false, updated: ["one"], unchanged: ["three"], failed: ["two"], skipped: plan.skipped },
      { event: "exit", code: 1 },
    );
    await poll(s);
    const summary = textOf(byId(tree(s), "mu-summary"));
    expect(summary).toContain("1 updated · 1 already up to date · 1 failed · 1 skipped");
    expect(summary).toContain(`one: ${keys}`);
    expect(summary).toContain(`one: ${perms}`);
    expect(summary).toContain("two: failed herdr-app check");
    expect(summary).toContain("Skipped mine: has local edits");
    expect(summary).not.toContain("mod-updater");
    // Rows keep their outcome even though the cached list now files "one" under up to date.
    expect(rowText(s, "one")).toContain("Updated");
    expect(rowText(s, "two")).toContain("Failed");
    expect(byId(tree(s), "mu-act-two").click).toBeTruthy();
    expect(textOf(tree(s))).toContain("Update all (1)");
    expect(world.calls.at(-1)).toEqual(["check", "--cached", "--json"]);

    await press(s, "mu-summary-close");
    expect(byId(tree(s), "mu-summary")).toBeUndefined();
    expect(byId(tree(s), "mu-row-one")).toBeUndefined();
  });

  test("Retry on a failed row updates that mod again", async () => {
    const s = await running();
    world.log = logOf({ kind: "all" }, plan, { event: "result", mod: "one", result: result("one", { ok: false, outcome: "failed", error: "boom" }) }, { event: "exit", code: 1 });
    world.cached = checked([available("one")]);
    await poll(s);
    expect(rowText(s, "one")).toContain("boom");
    await press(s, "mu-act-one");
    expect(world.jobs.at(-1)).toEqual(["update", "one", "--json"]);
    expect(byId(tree(s), "mu-summary")).toBeUndefined();
  });

  test("another update running comes back as the summary's error", async () => {
    const s = await running();
    world.log = logOf({ kind: "all" }, { ok: false, error: "another hmod update is running: try again when it finishes" }, { event: "exit", code: 1 });
    await poll(s);
    expect(textOf(byId(tree(s), "mu-summary"))).toContain("another hmod update is running");
  });

  test("a crash fails what was left, with what it printed", async () => {
    const s = await running();
    world.log = `${logOf({ kind: "all" }, { ...plan, skipped: [] })}TypeError: nope\n{"event":"exit","code":1}\n`;
    await poll(s);
    expect(rowText(s, "two")).toContain("TypeError: nope");
    expect(textOf(byId(tree(s), "mu-summary"))).toContain("3 failed");
    expect(byId(tree(s), "mu-all").click).toBeTruthy();
  });

  test("a job whose process vanished ends instead of spinning forever", async () => {
    const s = await running();
    world.log = logOf({ kind: "all" }, plan);
    world.alive = false;
    for (let i = 0; i < 10; i++) await poll(s);
    expect(rowText(s, "two")).toContain("Failed");
    expect(textOf(byId(tree(s), "mu-summary"))).toContain("hmod stopped before it finished");
  });

  test("a job that never starts gives up, and buttons come back", async () => {
    const s = await running();
    world.log = null;
    for (let i = 0; i < 21; i++) await poll(s);
    expect(textOf(tree(s))).toContain("hmod didn't start");
    expect(byId(tree(s), "mu-all").click).toBeTruthy();
  });

  test("exit 127 inside the job means the CLI is gone", async () => {
    const s = await running();
    world.log = logOf({ kind: "all" }, { event: "exit", code: 127 });
    await poll(s);
    expect(textOf(tree(s))).toContain("needs the hmod CLI");
  });

  test("the job not starting shows why", async () => {
    world.cached = checked([available("one")]);
    const s = await start();
    world.execError = new Error("no /bin/sh");
    await press(s, "mu-all");
    expect(textOf(tree(s))).toContain("no /bin/sh");
    expect(s.v.running()).toBe(false);
  });
});

describe("a single update", () => {
  test("ends with its result and any notes", async () => {
    world.cached = checked([available("quota")]);
    const s = await start();
    await press(s, "mu-act-quota");
    world.log = logOf({ kind: "one", mod: "quota" }, result("quota", { notes: ["Mind the keys."] }), { event: "exit", code: 0 });
    await poll(s);
    expect(rowText(s, "quota")).toContain("Updated");
    expect(textOf(byId(tree(s), "mu-summary"))).toContain("quota: Mind the keys.");
  });

  test("a refusal is Failed, with hmod's reason", async () => {
    world.cached = checked([available("quota")]);
    const s = await start();
    await press(s, "mu-act-quota");
    world.log = logOf({ kind: "one", mod: "quota" }, result("quota", { ok: false, outcome: "refused", error: "not allowed" }), { event: "exit", code: 1 });
    await poll(s);
    expect(rowText(s, "quota")).toContain("Failed");
    expect(rowText(s, "quota")).toContain("not allowed");
  });
});

describe("closing and opening again", () => {
  test("a job still running is picked up, and its buttons stay disabled", async () => {
    world.cached = checked([available("one"), available("two")], minutesAgo(9 * 60));
    world.shared["mod-updater.job"] = "abc";
    world.log = logOf({ kind: "all" }, { event: "plan", mods: ["one", "two"], skipped: [] }, { event: "step", mod: "one", step: "installing" });
    const s = await start();
    expect(world.jobs).toEqual([]); // Not even the stale check.
    expect(rowText(s, "one")).toContain("Updating: installing");
    expect(byId(tree(s), "mu-all").click).toBeNull();
  });

  test("one that ended while closed still shows its summary, once", async () => {
    world.cached = checked([available("two")]);
    world.shared["mod-updater.job"] = "abc";
    world.log = logOf({ kind: "one", mod: "one" }, result("one", { notes: ["Mind the keys."] }), { event: "exit", code: 0 });
    let s = await start();
    expect(textOf(byId(tree(s), "mu-summary"))).toContain("Mind the keys.");
    s = await start();
    expect(byId(tree(s), "mu-summary")).toBeUndefined();
  });
});

describe("the ask dialog", () => {
  const ask = { mod: "mine", title: "My mod", changed: ["main.js", "ui.js"], repo: "o/r" };
  beforeEach(() => {
    world.props = { ask, overlay: "ov1" };
  });

  test("says what's replaced and that a backup is kept", async () => {
    const s = await start();
    const text = textOf(tree(s));
    expect(text).toContain("Update My mod?");
    expect(text).toContain("main.js, ui.js");
    expect(text).toContain("o/r");
    expect(text).toContain("A backup of the mod as it is now will be kept in ~/data/backups");
    expect(world.calls).toEqual([]);
  });

  test("Cancel starts nothing", async () => {
    const s = await start();
    await press(s, "mu-no");
    expect(world.closed).toEqual(["ov1"]);
    expect(world.jobs).toEqual([]);
  });

  test("yes starts the forced update, and the list behind picks it up", async () => {
    world.props = {};
    world.cached = checked([entry("mine", "modified", { changed: ["main.js"], update_available: true })]);
    const list = await start();

    world.props = { ask, overlay: "ov1" };
    const dialog = await start();
    await press(dialog, "mu-yes");
    expect(world.jobs).toEqual([["update", "mine", "--force", "--json"]]);
    expect(world.closed).toEqual(["ov1"]);

    world.props = {};
    world.log = logOf({ kind: "one", mod: "mine" });
    await poll(list);
    expect(rowText(list, "mine")).toContain("Updating");
    expect(byId(tree(list), "mu-all").click).toBeNull();
  });

  test("a job that can't start stays in the dialog", async () => {
    const s = await start();
    world.execError = new Error("no /bin/sh");
    await press(s, "mu-yes");
    expect(world.closed).toEqual([]);
    expect(textOf(tree(s))).toContain("no /bin/sh");
  });
});

// exec's 30 second limit is why jobs are detached, so the shell part has to really work.
describe("a job in a real shell", () => {
  const GATE = join(TEMP, "go");
  const script = (lines: string[]) => {
    writeFileSync(CLI, `#!/bin/sh\n${lines.join("\n")}\n`);
    chmodSync(CLI, 0o755);
  };
  const until = async (s: any, done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) {
      await poll(s);
      await Bun.sleep(100); // As in the app, the job gets 20 polls to show up: a detached start can take a while.
    }
    expect(done()).toBe(true);
  };
  beforeEach(() => {
    rmSync(GATE, { force: true });
    rmSync(DATA, { recursive: true, force: true });
    script([
      `echo '{"event":"plan","mods":["one"],"skipped":[]}'`,
      `while [ ! -e '${GATE}' ]; do sleep 0.01; done`,
      `echo 'a line that "isn'"'"'t json'`,
      `printf '%s\\n' "$*" > '${join(TEMP, "args")}'`,
      `echo '{"event":"result","mod":"one","result":{"ok":true,"mod":"one","outcome":"updated","to_version":"2","notes":[]}}'`,
      `exit 3`,
    ]);
  });

  test("exec returns while hmod runs, progress shows, and the end is seen", async () => {
    world.cached = checked([available("one's mod", { name: "one", title: "one" })]);
    const s = await start();
    world.real = true;
    const started = Date.now();
    await press(s, "mu-all");
    expect(Date.now() - started).toBeLessThan(2000); // The script is parked on the gate: exec didn't wait for it.
    await until(s, () => (s.v.rows.one?.state ?? "") === "waiting");
    expect(s.v.running()).toBe(true);

    writeFileSync(GATE, "");
    await until(s, () => !s.v.running());
    expect(s.v.rows.one.state).toBe("updated");
    expect(await Bun.file(join(TEMP, "args")).text()).toBe("update --all --json\n");
  });

  test("a mod name stays one argument, however odd", async () => {
    const name = `it's "odd" $(touch x) mod`;
    world.cached = checked([available(name)]);
    const s = await start();
    world.real = true;
    await press(s, `mu-act-${name}`);
    writeFileSync(GATE, "");
    await until(s, () => !s.v.running());
    expect(await Bun.file(join(TEMP, "args")).text()).toBe(`update ${name} --json\n`);
    expect(s.v.rows[name]).toBeDefined();
  });

  test("a CLI that can't be run ends the job as not set up", async () => {
    world.cached = checked([available("one")]);
    const s = await start();
    world.real = true;
    rmSync(CLI);
    await press(s, "mu-all");
    await until(s, () => !s.v.running());
    expect(textOf(tree(s))).toContain("needs the hmod CLI");
  });
});

describe("an offer is only a possibility", () => {
  const exact = {
    repo: "a/quota", path: "mods/q", why: "Every file matches commit abc", exact: true, commit: "abc", commits_past_match: 3,
    evidence: ["Owner a · created 2025-01-02 · 4 stars · not a fork", "The mod's folder has changed since that commit: 3 newer commits."],
  };
  const other = { ...exact, repo: "b/quota" };

  /** Every button's `primary` as drawn: the mod's own helper, watched. */
  const pressable = (s: any) => {
    const seen: Record<string, boolean> = {};
    const real = s.v.button;
    s.v.button = function (t: any, id: string, label: string, onClick: any, o: any = {}) {
      seen[id] = o.primary === true;
      return real.call(this, t, id, label, onClick, o);
    };
    tree(s);
    s.v.button = real;
    return seen;
  };

  test.each([
    ["one exact match", [exact]],
    ["an exact match beside a partial one", [exact, { ...other, exact: false }]],
    ["several exact matches", [exact, other]],
    ["only a partial match", [{ ...exact, exact: false }]],
  ])("%s: says Possible source, never that one was found, and no button is primary", async (_name, suggestions) => {
    world.cached = checked([entry("quota", "unlinked", { suggestions })]);
    const s = await start();
    expect(rowText(s, "quota")).toContain("Possible source");
    expect(textOf(byId(tree(s), "mu-act-quota"))).toContain("Link source");
    await press(s, "mu-act-quota");
    await press(s, "mu-offer-0");
    const text = rowText(s, "quota");
    for (const words of ["Source found", "Confirm source", "confirm it before updating"]) expect(text).not.toContain(words);
    const buttons = pressable(s);
    expect(Object.keys(buttons)).toEqual(expect.arrayContaining(["mu-act-quota", "mu-offer-0", "mu-trust-yes", "mu-trust-no"]));
    expect(Object.entries(buttons).filter(([id, primary]) => primary && id !== "mu-all")).toEqual([]);
    expect(textOf(tree(s))).toContain("Update all (0)");
  });

  test("the panel shows the evidence, and says what none of it proves", async () => {
    world.cached = checked([entry("quota", "unlinked", { suggestions: [exact] })]);
    const s = await start();
    await press(s, "mu-act-quota");
    const text = rowText(s, "quota");
    expect(text).toContain("anyone can publish a copy");
    expect(text).toContain("can be faked");
    expect(text).toContain("Owner a · created 2025-01-02 · 4 stars · not a fork");
    expect(text).toContain("has changed since that commit");
    expect(world.calls.some((c) => c[0] === "link")).toBe(false);
  });

  test("offers saved before there was evidence still draw", async () => {
    const { evidence: _, commits_past_match: __, ...old } = exact;
    world.cached = checked([entry("quota", "unlinked", { suggestions: [old] })]);
    const s = await start();
    await press(s, "mu-act-quota");
    expect(rowText(s, "quota")).toContain("a/quota · mods/q");
  });

  test("a list that may be incomplete says so on the row and in the panel, with why", async () => {
    const gaps = [{ kind: "repo_failed", detail: "hmod couldn't read bad/quota, so skipped it." }];
    world.cached = checked([entry("quota", "unlinked", { suggestions: [exact], offer_gaps: gaps })]);
    const s = await start();
    expect(rowText(s, "quota")).toContain("this list may be incomplete");
    await press(s, "mu-act-quota");
    expect(rowText(s, "quota")).toContain("This list may be incomplete.");
    expect(rowText(s, "quota")).toContain("hmod couldn't read bad/quota");
  });

  test("no offers and a gap: it doesn't claim nothing's out there", async () => {
    const gaps = [{ kind: "rate_limit", detail: "GitHub's rate limit stopped hmod reading 2 repos." }];
    world.cached = checked([entry("quota", "unlinked", { offer_gaps: gaps })]);
    const s = await start();
    expect(rowText(s, "quota")).toContain("No source known");
    expect(rowText(s, "quota")).toContain("may have missed it");
  });

  test("no gaps: no note", async () => {
    world.cached = checked([entry("quota", "unlinked", { suggestions: [exact, other] })]);
    const s = await start();
    await press(s, "mu-act-quota");
    expect(rowText(s, "quota").toLowerCase()).not.toContain("may be incomplete");
  });

  test("the confirmation says who's being trusted, for an offer and for a typed repo", async () => {
    world.cached = checked([entry("quota", "unlinked", { suggestions: [exact] })]);
    const s = await start();
    await press(s, "mu-act-quota");
    await press(s, "mu-offer-0");
    expect(rowText(s, "quota")).toContain("a, and anyone who later controls a/quota, can run code on your computer.");
    await press(s, "mu-trust-no");
    expect(byId(tree(s), "mu-trust")).toBeUndefined();
    expect(world.calls.some((c) => c[0] === "link")).toBe(false);
    s.v.linkInput.set_value("me/mine");
    await press(s, "mu-link");
    expect(rowText(s, "quota")).toContain("me, and anyone who later controls me/mine, can run code on your computer.");
  });

  test("Confirm again names whoever holds the repo now", async () => {
    const change = { what: ["owner"], detail: "o/r has a new owner", repo_now: "x/r" };
    world.cached = checked([entry("quota", "source_changed", { source: { repo: "o/r" }, source_changed: change, note: change.detail })]);
    const s = await start();
    await press(s, "mu-act-quota-confirm");
    expect(rowText(s, "quota")).toContain("x, and anyone who later controls x/r, can run code on your computer.");
    expect(pressable(s)["mu-trust-yes"]).toBe(false);
  });
});

describe("a first update", () => {
  const first = (name: string) => available(name, { first_update_pending: true, note: `First update from a/${name}: update this mod by itself to go ahead. Update all leaves it out until then` });

  test("isn't counted by Update all, and the row says why and keeps its Update", async () => {
    world.cached = checked([first("new"), available("old")]);
    const s = await start();
    expect(textOf(tree(s))).toContain("Update all (1)");
    expect(rowText(s, "new")).toContain("Update all leaves it out");
    expect(rowText(s, "new")).toContain("1.0.0 → 1.2.0");
    await press(s, "mu-act-new");
    expect(world.jobs).toEqual([["update", "new", "--json"]]);
  });

  test("with nothing else waiting, Update all has nothing to do", async () => {
    world.cached = checked([first("new")]);
    expect(textOf(tree(await start()))).toContain("Update all (0)");
  });

  test("skipped by Update all, the row gives the reason and can still update", async () => {
    world.cached = checked([first("new"), available("old")]);
    const s = await start();
    await press(s, "mu-all");
    world.log = logOf({ kind: "all" }, { event: "plan", mods: ["old"], skipped: [{ mod: "new", status: "update_available", reason: "First update from a/new" }] });
    await poll(s);
    expect(rowText(s, "new")).toContain("First update from a/new");
    expect(byId(tree(s), "mu-act-new")).toBeTruthy();
  });

  test("the status bar counts only what Update all would install", async () => {
    world.props = { bar: true };
    world.cached = checked([first("new"), available("old")]);
    expect(textOf(tree(await start()))).toContain("Mod updates (1)");
  });
});

describe("the status bar button", () => {
  const bar = async (View: any = ModUpdates) => {
    world.props = { bar: true };
    return start(View);
  };

  test("says nothing extra when no updates are waiting", async () => {
    world.cached = checked([entry("quota", "up_to_date")]);
    expect(textOf(tree(await bar())).trim()).toBe("Mod updates");
  });

  test("counts only what Update all would install", async () => {
    world.cached = checked([available("a"), available("b"), entry("mine", "modified", { update_available: true }), entry("q", "unlinked")]);
    expect(textOf(tree(await bar()))).toContain("Mod updates (2)");
  });

  test("a click opens the dialog", async () => {
    await press(await bar(), "mu-bar");
    expect(world.ran).toEqual([{ name: "mod.open", args: { name: "mod-updater" } }]);
  });

  test("only reads the last check: it never starts one, even when that check is old", async () => {
    world.cached = checked([available("a")], minutesAgo(60 * 24));
    await bar();
    expect(world.calls).toEqual([["check", "--cached", "--json"]]);
    expect(world.jobs).toEqual([]);
  });

  test("picks up a new count on its slow timer", async () => {
    world.cached = checked([available("a")]);
    const s = await bar();
    world.cached = checked([]);
    for (const t of world.timers) t.fn(s.cx);
    await s.cx.settle();
    expect(textOf(tree(s)).trim()).toBe("Mod updates");
  });

  test("keeps its count when a reread fails", async () => {
    world.cached = checked([available("a")]);
    const s = await bar();
    world.answers["check --cached"] = { code: 1, stdout: "", stderr: "nope" };
    for (const t of world.timers) t.fn(s.cx);
    await s.cx.settle();
    expect(textOf(tree(s))).toContain("Mod updates (1)");
  });

  test("still opens the dialog when the CLI isn't set up, and runs nothing", async () => {
    const s = await bar(PlainCopy);
    expect(world.calls).toEqual([]);
    expect(world.timers).toEqual([]);
    await press(s, "mu-bar");
    expect(world.ran).toHaveLength(1);
  });
});
