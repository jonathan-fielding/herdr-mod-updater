// Mod updates: every installed mod, which have updates, and buttons that install them.
// Opens as a dialog with `mod.open mod-updater`. The same mod with props { ask } is the dialog asking
// before local edits are replaced.
// Data and actions all go through the hmod CLI: `hmod mod install` writes how to run it into
// hmod-path.js, and without it this only says how to set it up.
//
// exec() stops a program after 30 seconds and returns its output only at the end, but a check or an
// update can take minutes. So those run as jobs: a detached hmod, its --json output going to a log that
// this mod reads every half second. Closing the dialog leaves a job running, and opening it again picks
// the job up, because shared state names the job and the log says how far it got.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, readTextFile, theme, home, props, openOverlay, closeOverlay, shared, setShared } from "herdr";
import { HMOD, HMOD_DATA } from "./hmod-path.js";

const MOD_NAME = "mod-updater";
const SETUP_URL = "https://github.com/jonathan-fielding/herdr-mod-updater";
const STALE_MS = 6 * 60 * 60 * 1000;
const POLL_MS = 500;
/** How often a running job's process is looked for, in polls. */
const ALIVE_EVERY = 10;
/** Polls to wait for a job's log to show that job before giving up on it. */
const START_POLLS = 20;
/** Shared: the id of the newest job, and of the newest one this mod has finished showing. */
const JOB = "mod-updater.job";
const SEEN = "mod-updater.seen";

const STEPS = {
  downloading: "downloading", checking: "checking", backing_up: "backing up",
  installing: "installing", verifying: "verifying", pulling: "pulling",
};

const jobLog = () => `${HMOD_DATA}/mod-job.log`;
const tilde = (path) => (path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const act = (fn) => (_e, cx) => cx.spawn(async (cx) => fn(cx));

/** Never rejects. `unavailable`: the CLI couldn't be run at all, as opposed to a command that failed. */
async function hmod(args) {
  if (!HMOD) return { ok: false, unavailable: true, text: "hmod isn't set up", stdout: "" };
  try {
    const r = await exec(HMOD[0], [...HMOD.slice(1), ...args]);
    // 126/127: the program isn't there. Bun's error: it is, but the clone holding cli.ts has moved.
    const unavailable = r.code === 126 || r.code === 127 || (r.code !== 0 && /Module not found|Cannot find module/.test(r.stderr));
    return { ok: r.code === 0, unavailable, text: (r.stdout + r.stderr).trim(), stdout: r.stdout };
  } catch (e) {
    return { ok: false, unavailable: true, text: String(e?.message ?? e), stdout: "" };
  }
}

function parsed(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// Runs in the detached shell: $0 is the job's header line, the rest is the hmod command.
const RUNNER = `printf '%s\\n{"event":"pid","pid":%s}\\n' "$0" "$$"; "$@" 2>&1; printf '{"event":"exit","code":%s}\\n' "$?"`;
// Empties the log before returning, so a poll can't take the last job's for this one. No wait: this
// shell ends at once, which is what gets past exec's limit.
const START = `log=$1; shift; mkdir -p "\${log%/*}" && : > "$log" && { nohup /bin/sh -c "$0" "$@" > "$log" 2>&1 < /dev/null & }`;

/** Starts hmod detached. `job` is what the log's reader needs: { kind: "check" | "all" | "one", mod? }. Returns an error, or null. */
async function startJob(job, args) {
  const id = Date.now().toString(36);
  try {
    const r = await exec("/bin/sh", ["-c", START, RUNNER, jobLog(), JSON.stringify({ event: "job", id, ...job }), ...HMOD, ...args]);
    if (r.code !== 0) return r.stderr.trim() || `couldn't start hmod (exit code ${r.code})`;
  } catch (e) {
    return String(e?.message ?? e);
  }
  setShared(JOB, id);
  return null;
}

async function jobAlive(pid) {
  try {
    return (await exec("/bin/sh", ["-c", `kill -0 ${Number(pid)}`])).code === 0;
  } catch {
    return false;
  }
}

/** The log's lines. A line still being written fails to parse and lands in `stray`, which only matters once the job has ended. */
function readLog(text) {
  const log = { header: null, pid: null, exit: null, events: [], stray: [] };
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const o = parsed(line);
    if (o?.event === "job") log.header = o;
    else if (o?.event === "pid") log.pid = o.pid;
    else if (o?.event === "exit") log.exit = o;
    else if (o) log.events.push(o);
    else log.stray.push(line);
  }
  return log;
}

/** What a job's log adds up to, worked out from the start each time: { rows, check, summary }. */
function tally(log) {
  const job = log.header;
  const rows = {};
  const summary = { updated: [], unchanged: [], failed: [], skipped: [], notes: [], error: null };
  let check = null;
  if (job.mod) rows[job.mod] = { state: "updating" };

  const result = (r) => {
    const name = r.mod;
    if (r.outcome === "updated") {
      rows[name] = { state: "updated", version: r.to_version };
      summary.updated.push(name);
    } else if (r.ok) {
      rows[name] = { state: "unchanged" };
      summary.unchanged.push(name);
    } else {
      rows[name] = { state: "failed", error: r.error };
      summary.failed.push({ mod: name, error: r.error });
    }
    for (const note of r.notes ?? []) summary.notes.push({ mod: name, note });
  };

  for (const e of log.events) {
    if (e.event === "plan") {
      for (const name of e.mods) rows[name] = { state: "waiting" };
      for (const s of e.skipped) {
        if (s.mod === MOD_NAME && s.status === "unlinked") continue; // This mod is never offered a source.
        rows[s.mod] = { state: "skipped", reason: s.reason };
        summary.skipped.push(s);
      }
    } else if (e.event === "step") rows[e.mod] = { state: "updating", step: e.step };
    else if (e.event === "result") result(e.result);
    else if (e.event === undefined && e.outcome) result(e);
    else if (e.event === undefined && Array.isArray(e.mods)) check = e;
    else if (e.event === undefined && e.ok === false) summary.error = e.error;
  }

  if (log.exit) {
    const said = log.stray.join("\n").trim();
    if (!summary.error && !check && log.exit.code !== 0 && !summary.updated.length && !summary.failed.length) {
      summary.error = said || `hmod stopped with exit code ${log.exit.code}`;
    }
    for (const [name, row] of Object.entries(rows)) {
      if (row.state !== "waiting" && row.state !== "updating") continue;
      const error = summary.error ?? "hmod stopped before getting to this one";
      rows[name] = { state: "failed", error };
      summary.failed.push({ mod: name, error });
    }
  }
  return { rows, check, summary };
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return "just now"; // Unreadable, or a clock that moved.
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** What was typed or pasted into Link source: owner/repo, or with the mod's folder after it, or a GitHub URL of either. */
function parseSource(text) {
  const clean = text.trim().replace(/^(https?:\/\/)?github\.com\//, "").replace(/\/tree\/[^/]+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  return { repo: parts.slice(0, 2).join("/"), path: parts.slice(2).join("/") || null };
}

function versions(m) {
  const out = [];
  if (m.latest_version && m.latest_version !== m.installed_version) {
    out.push(m.installed_version ? `${m.installed_version} → ${m.latest_version}` : `Version ${m.latest_version}`);
  } else if (m.installed_version) out.push(`Version ${m.installed_version}`);
  if (m.commits_behind) out.push(`${m.commits_behind}${m.commits_behind_capped ? "+" : ""} commit${m.commits_behind === 1 ? "" : "s"} behind`);
  return out.join(" · ");
}

const needsAttention = (m) =>
  m.status === "update_available" || m.status === "modified" || m.status === "error" ||
  (m.status === "unlinked" && !m.cloned_from && m.name !== MOD_NAME); // Clones are never updated. This mod comes with hmod.

export default class ModUpdates extends View {
  init(_props, cx) {
    if (props()?.ask) return this.initAsk(cx);
    this.data = null;
    this.error = null;
    this.notSetUp = !HMOD;
    this.rows = {};
    this.summary = null;
    this.kind = null; // what the running job is
    this.open = {}; // folded sections showing
    this.linking = null; // the mod whose Link source is showing
    this.linkError = null;
    this.linkBusy = false;
    this.waited = 0;
    this.beats = 0;
    this.linkInput = InputState.new({ value: "", placeholder: "owner/repo" });
    this.linkInput.on("submit", act((cx) => this.linkTyped(cx)));
    if (this.notSetUp) return;
    cx.timer.every(POLL_MS, (cx) => cx.spawn(async (cx) => this.poll(cx)));
    cx.timer.every(30000, (cx) => cx.notify()); // "Checked 5m ago" moves on
    cx.spawn(async (cx) => {
      await this.reload(cx);
      await this.poll(cx);
      if (this.data && !this.running() && this.stale()) await this.check(cx);
      cx.notify();
    });
  }

  /** Whether a job hasn't been seen to its end. */
  running() {
    const id = shared(JOB);
    return !!HMOD && !!id && id !== shared(SEEN);
  }

  stale() {
    const at = this.data?.last_checked;
    return !at || !(Date.now() - Date.parse(at) < STALE_MS);
  }

  /** What the last check found, with no network call. */
  async reload(cx) {
    const r = await hmod(["check", "--cached", "--json"]);
    const out = parsed(r.stdout);
    if (r.unavailable) this.notSetUp = true;
    else if (r.ok && out?.mods) {
      this.data = out;
      this.error = null;
    } else this.error = out?.error ?? r.text;
    cx.notify();
  }

  /** Follows the running job through its log. A timer calls this, whichever copy or dialog started the job. */
  async poll(cx) {
    if (!this.running() || this.polling) return;
    this.polling = true;
    try {
      const id = shared(JOB);
      let log = readLog(await readTextFile(jobLog()).catch(() => null));
      if (log.header?.id !== id) {
        if (++this.waited > START_POLLS) await this.gaveUp(cx, id);
        return;
      }
      this.waited = 0;
      if (!log.exit && log.pid && ++this.beats % ALIVE_EVERY === 0 && !(await jobAlive(log.pid))) {
        log = readLog(await readTextFile(jobLog()).catch(() => null)); // It may have finished just now.
        log.exit ??= { code: -1 };
        log.stray = ["hmod stopped before it finished"];
      }
      this.kind = log.header.kind;
      const t = tally(log);
      if (this.kind !== "check") this.rows = t.rows;
      if (log.exit) await this.finish(cx, id, log, t);
      cx.notify();
    } finally {
      this.polling = false;
    }
  }

  async gaveUp(cx, id) {
    setShared(SEEN, id);
    this.kind = null;
    this.waited = 0;
    this.error = "hmod didn't start.";
    cx.notify();
  }

  async finish(cx, id, log, t) {
    setShared(SEEN, id);
    const kind = this.kind;
    this.kind = null;
    if (log.exit.code === 126 || log.exit.code === 127) {
      this.notSetUp = true;
      this.rows = {};
      return;
    }
    if (kind === "check" && t.check) {
      this.data = t.check;
      this.error = null;
      return;
    }
    if (kind === "check") {
      this.error = t.summary.error ?? "The check didn't finish.";
      return;
    }
    this.summary = t.summary;
    await this.reload(cx);
  }

  async begin(cx, job, args, rows = {}) {
    if (this.running()) return;
    this.rows = rows;
    this.summary = null;
    this.error = null;
    this.kind = job.kind;
    this.linking = null;
    cx.notify();
    const failed = await startJob(job, args);
    if (failed) {
      this.kind = null;
      this.rows = {};
      this.error = failed;
    }
    cx.notify();
  }

  check(cx) {
    return this.begin(cx, { kind: "check" }, ["check", "--json"]);
  }

  updateAll(cx) {
    return this.begin(cx, { kind: "all" }, ["update", "--all", "--json"]);
  }

  update(m, cx) {
    return this.begin(cx, { kind: "one", mod: m.name }, ["update", m.name, "--json"], { [m.name]: { state: "updating" } });
  }

  /** Update on a mod with local edits: replacing them needs a yes. */
  askUpdate(m) {
    const ask = { mod: m.name, title: m.title, changed: m.changed, repo: m.source?.repo ?? null };
    openOverlay({ mod: MOD_NAME, kind: "dialog", width: 460, height: 260, props: { ask } });
  }

  toggleLink(m) {
    this.linking = this.linking === m.name ? null : m.name;
    this.linkError = null;
    this.linkInput.set_value("");
    if (this.linking) this.linkInput.focus();
  }

  linkTyped(cx) {
    const { repo, path } = parseSource(this.linkInput.value());
    if (!repo.includes("/")) {
      this.linkError = "Type the repo as owner/repo.";
      cx.notify();
      return;
    }
    return this.link(cx, repo, path);
  }

  async link(cx, repo, path) {
    const mod = this.linking;
    if (!mod || this.linkBusy || this.running()) return;
    this.linkBusy = true;
    this.linkError = null;
    cx.notify();
    const r = await hmod(["link", mod, repo, ...(path ? ["--path", path] : []), "--json"]);
    this.linkBusy = false;
    if (!r.ok) {
      this.linkError = parsed(r.stdout)?.error ?? r.text;
      cx.notify();
      return;
    }
    return this.check(cx); // What it's now linked to decides its status.
  }

  // ------------------------------------------------------------- asking before replacing local edits

  initAsk(cx) {
    this.askError = null;
    this.askBusy = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  /** Starts the job from here: the list behind this dialog picks it up. */
  async confirmUpdate(cx) {
    if (this.askBusy) return;
    this.askBusy = true;
    cx.notify();
    const { mod } = props().ask;
    this.askError = await startJob({ kind: "one", mod }, ["update", mod, "--force", "--json"]);
    this.askBusy = false;
    if (!this.askError) closeOverlay(props().overlay);
    cx.notify();
  }

  renderAsk(t) {
    const a = props().ask;
    const backups = tilde(`${HMOD_DATA}/backups`);
    const files = a.changed.slice(0, 4).join(", ") + (a.changed.length > 4 ? `, and ${a.changed.length - 4} more` : "");
    const edits = files ? `Your edits to ${files} will be replaced` : "Your local edits will be replaced";
    return v_flex()
      .id("mu-ask")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(`Update ${a.title}?`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().id("mu-ask-body").flex_1().min_h(0).gap(6).overflow_y_scrollbar().text_color(t.muted)
        .child(div().child(`${edits} with the newest version${a.repo ? ` from ${a.repo}` : ""}.`))
        .child(div().child(`A backup of the mod as it is now will be kept in ${backups}.`))
        .when(Boolean(this.askError), (el) => el.child(div().text_color(t.blocked).child(this.askError))))
      .child(h_flex().justify_end().gap(8)
        .child(this.button(t, "mu-no", "Cancel", () => closeOverlay(props().overlay)))
        .child(this.button(t, "mu-yes", "Update and keep a backup", act((cx) => this.confirmUpdate(cx)), { primary: true, enabled: !this.askBusy })));
  }

  // ------------------------------------------------------------- the list

  button(t, id, label, onClick, { primary = false, enabled = true } = {}) {
    return h_flex().id(id).flex_none().h(28).px(12).items_center().rounded(6).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_size(12).text_color(primary ? t.solid_foreground : t.foreground)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(label);
  }

  /** The status word on a row, and its color. */
  rowStatus(t, m, row) {
    switch (row?.state) {
      case "waiting": return ["Waiting", t.dim];
      case "updating": return [row.step ? `Updating: ${STEPS[row.step] ?? row.step}` : "Updating", t.working];
      case "updated": return ["Updated", t.done];
      case "unchanged": return ["Already up to date", t.done];
      case "failed": return ["Failed", t.blocked];
      case "skipped": return ["Skipped", t.muted];
    }
    switch (m.status) {
      case "update_available": return ["Update available", t.accent];
      case "modified": return ["Edited locally", t.blocked];
      case "unlinked": return ["No source known", t.muted];
      case "error": return ["Error", t.blocked];
      default: return ["Up to date", t.dim];
    }
  }

  /** The line under a row's name. */
  rowDetail(m, row) {
    if (row?.state === "failed") return row.error;
    if (row?.state === "skipped") return row.reason;
    if (row?.state === "updated") return row.version ? `Now at ${row.version}` : "";
    if (row) return versions(m);
    if (m.status === "error") return m.message;
    if (m.status === "unlinked") return m.suggestions?.length ? `${plural(m.suggestions.length, "possible source")} found` : "Where this mod came from isn't known";
    if (m.status === "modified") {
      const files = m.changed.slice(0, 3).join(", ") + (m.changed.length > 3 ? ", …" : "");
      return [files, m.update_available ? versions(m) || "An update exists" : m.remote_checked ? "No update to install" : ""].filter(Boolean).join(" · ");
    }
    return versions(m);
  }

  /** A row's button, or null. */
  rowAction(t, m, row) {
    const on = !this.running() && !this.linkBusy;
    const id = `mu-act-${m.name}`;
    if (row && row.state !== "failed" && row.state !== "skipped") return null;
    const updating = m.status === "modified" ? () => this.askUpdate(m) : act((cx) => this.update(m, cx));
    if (row?.state === "failed") return this.button(t, id, "Retry", updating, { enabled: on });
    if (m.status === "update_available") return this.button(t, id, "Update", updating, { primary: true, enabled: on });
    // With nothing newer, updating over local edits would do nothing.
    if (m.status === "modified") return m.remote_checked && !m.update_available ? null : this.button(t, id, "Update", updating, { enabled: on });
    if (m.status === "unlinked") return this.button(t, id, "Link source", () => this.toggleLink(m), { enabled: on });
    if (m.status === "error") return this.button(t, id, "Retry", act((cx) => this.check(cx)), { enabled: on });
    return null;
  }

  linkPanel(t, m) {
    const on = !this.running() && !this.linkBusy;
    const offer = (s, i) => h_flex().flex_none().gap(8).items_center()
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(`${s.repo} · ${s.path}`))
        .child(div().truncate().text_size(11).text_color(t.dim).child(s.why)))
      .child(this.button(t, `mu-offer-${i}`, "Link", act((cx) => this.link(cx, s.repo, s.path)), { enabled: on }));
    return v_flex().flex_none().gap(8).pt(8).text_size(12)
      .children((m.suggestions ?? []).map(offer))
      .child(h_flex().flex_none().gap(8).items_center()
        .child(Input.new(this.linkInput).flex_1().min_w(0).h(28).px(8).items_center().rounded(6).border(1)
          .border_color(t.input).bg(t.background).text_color(t.foreground))
        .child(this.button(t, "mu-link", "Link", act((cx) => this.linkTyped(cx)), { enabled: on })))
      .when(Boolean(this.linkError), (el) => el.child(div().text_color(t.blocked).child(this.linkError)));
  }

  row(t, m) {
    const state = this.rows[m.name];
    const [status, color] = this.rowStatus(t, m, state);
    const detail = this.rowDetail(m, state);
    const button = this.rowAction(t, m, state);
    return v_flex().id(`mu-row-${m.name}`).flex_none().mx(12).mb(6).px(12).py(8).rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(10).items_center()
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_shrink_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(m.title))
            .child(div().flex_none().text_size(12).text_color(color).child(status)))
          .when(Boolean(detail), (el) => el.child(div().text_size(12).text_color(t.dim).child(detail))))
        .when(button !== null, (el) => el.child(button)))
      .when(this.linking === m.name, (el) => el.child(this.linkPanel(t, m)));
  }

  /** A section that's folded until clicked. */
  folded(t, id, label, mods) {
    if (!mods.length) return [];
    const open = !!this.open[id];
    const head = h_flex().id(`mu-fold-${id}`).flex_none().h(28).mx(12).px(4).gap(6).items_center().cursor_pointer()
      .text_size(12).text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        this.open[id] = !open;
        cx.notify();
      })
      .child(div().flex_none().w(10).child(open ? "▾" : "▸"))
      .child(`${label} (${mods.length})`);
    const line = (m) => h_flex().flex_none().h(24).mx(12).px(20).gap(8).items_center().text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(m.title))
      .child(div().flex_none().text_color(t.dim).child(m.installed_version ?? ""));
    return [head, ...(open ? mods.map(line) : [])];
  }

  summaryCard(t) {
    const s = this.summary;
    const counts = [
      s.updated.length && `${s.updated.length} updated`,
      s.unchanged.length && `${s.unchanged.length} already up to date`,
      s.failed.length && `${s.failed.length} failed`,
      s.skipped.length && `${s.skipped.length} skipped`,
    ].filter(Boolean);
    const line = (text, color = t.muted) => div().text_size(12).text_color(color).child(text);
    return v_flex().id("mu-summary").flex_none().mx(12).mb(10).p(12).gap(4).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).font_medium().text_color(t.foreground).child(counts.join(" · ") || "Nothing to update"))
        .child(div().id("mu-summary-close").flex_none().px(4).cursor_pointer().text_color(t.dim).hover((x) => x.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.summary = null;
            this.rows = {};
            cx.notify();
          })
          .child("✕")))
      .when(Boolean(s.error), (el) => el.child(line(s.error, t.blocked)))
      .children(s.failed.filter((f) => f.error !== s.error).map((f) => line(`${f.mod}: ${f.error}`, t.blocked)))
      .children(s.notes.map((n) => line(`${n.mod}: ${n.note}`, t.foreground)))
      .children(s.skipped.map((x) => line(`Skipped ${x.mod}: ${x.reason}`)));
  }

  setupNotice(t) {
    return v_flex().flex_none().px(16).pb(10).gap(4).text_size(12).text_color(t.dim)
      .child(div().child("Mod updates needs the hmod CLI. Install it, then run hmod mod install."))
      .child(div().id("mu-setup").text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => cx.open_url(SETUP_URL))
        .child(SETUP_URL));
  }

  /** Beside the title: when the last check was, or what's going on now. */
  statusText() {
    if (this.kind === "check") return "Checking…";
    if (this.kind === "all" && !Object.keys(this.rows).length) return "Checking before updating…";
    if (this.running()) return "Updating…";
    const at = this.data?.last_checked;
    return at ? `Checked ${ago(at)}` : this.notSetUp ? "" : "Not checked yet";
  }

  render(cx) {
    const t = theme();
    if (props()?.ask) return this.renderAsk(t);
    const mods = this.data?.mods ?? [];
    const free = !this.running() && !this.notSetUp;
    const n = mods.filter((m) => m.status === "update_available").length;
    const shown = (m) => needsAttention(m) || this.rows[m.name];
    const attention = mods.filter(shown);
    const rest = mods.filter((m) => !shown(m));
    const limit = this.data?.rate_limit_reset;
    const quiet = this.data && !attention.length && !this.summary;
    return v_flex().id("mu-root").size_full().min_h(0).bg(t.popover).text_size(13)
      .child(v_flex().flex_none().px(16).pt(14).pb(10).gap(10)
        .child(h_flex().gap(10).items_center()
          .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child("Mod updates"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.statusText()))
          .child(this.button(t, "mu-check", "Check for updates", act((cx) => this.check(cx)), { enabled: free })))
        .child(h_flex().child(this.button(t, "mu-all", `Update all (${n})`, act((cx) => this.updateAll(cx)), { primary: true, enabled: free && n > 0 }))))
      .when(this.notSetUp, (el) => el.child(this.setupNotice(t)))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(16).pb(10).text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(limit), (el) => el.child(div().flex_none().px(16).pb(10).text_size(12).text_color(t.dim)
        .child(`GitHub's rate limit lifts ${new Date(limit).toLocaleTimeString()}: some mods couldn't be checked.`)))
      .child(v_flex().id("mu-list").flex_1().min_h(0).pb(10).overflow_y_scrollbar()
        .when(Boolean(this.summary), (el) => el.child(this.summaryCard(t)))
        .when(Boolean(quiet), (el) => el.child(div().flex_none().px(16).py(10).text_color(t.muted).child("Nothing needs you.")))
        .children(attention.map((m) => this.row(t, m)))
        .children(this.folded(t, "up", "Up to date", rest.filter((m) => m.status === "up_to_date")))
        .children(this.folded(t, "herdr", "Updated with Herdr", rest.filter((m) => m.status === "herdr")))
        .children(this.folded(t, "clones", "Your clones", rest.filter((m) => m.cloned_from))));
  }
}
