/**
 * The JSON hmod prints with --json. Later commands and the mod depend on these shapes:
 * add fields freely, but don't rename or remove them.
 */

/** Where a mod came from, as far as hmod can tell. */
export type ModKind =
  /** Listed in installed.json: ships with Herdr and updates with the app. */
  | "herdr"
  /** Installed from a local git clone by its own tool (see CLONE_ADAPTERS). Never gets GitHub files. */
  | "clone-installed"
  /** Everything else, including the person's own mods and mod.clone copies (see `cloned_from`). */
  | "third-party";

export type ModStatus =
  /** Updates with the app: no Update button. */
  | "herdr"
  | "up_to_date"
  | "update_available"
  /** Local files differ from the baseline in sources.json; `changed` lists them. */
  | "modified"
  /** No source known. */
  | "unlinked"
  /** Couldn't work the status out; `message` says why. */
  | "error";

/** What mod.clone writes into the clone's mod.json. */
export interface ClonedFrom {
  name: string;
  version: string | null;
}

/** Where a linked mod's files live on GitHub. */
export interface SourceRef {
  /** "owner/repo" */
  repo: string;
  /** The mod's folder in the repo, e.g. "mods/quota". */
  path: string;
  /** null: the repo's default branch. */
  branch: string | null;
  /** The commit the baseline came from. null: linked by hand, and no check has worked it out yet. */
  commit: string | null;
}

/**
 * One entry of sources.json, which maps mod name -> SourceRecord.
 * `files` is the baseline, relative path -> git blob SHA-1: the files at `commit`. It's how local
 * edits are told from updates, so it never comes from what's on disk at `hmod link`: until `commit`
 * is known it means nothing, and what's on disk could be edits.
 */
export interface SourceRecord extends SourceRef {
  files: Record<string, string>;
  /**
   * The local files equalled no version found, so the baseline is the HEAD of that moment, standing
   * in for a version nobody knows. HEAD can then equal the baseline and still be worth installing.
   */
  baseline_assumed?: boolean;
}

export type Sources = Record<string, SourceRecord>;

export interface ModEntry {
  /** Folder name in <herdr home>/mods. Installs may be renamed, so it needn't match the repo's. */
  name: string;
  /** mod.json's title, else the name. */
  title: string;
  kind: ModKind;
  status: ModStatus;
  /** Why status is "error"; otherwise null. */
  message: string | null;
  /** Something worth showing next to the mod, or null. */
  note: string | null;
  /** The mod's folder. */
  dir: string;
  /** The linked source; null when unlinked. Never set for herdr, clone-installed or cloned mods. */
  source: SourceRef | null;
  /** Set when mod.clone made this mod. Clones are the person's: never linked or updated. */
  cloned_from: ClonedFrom | null;
  /** Which CLONE_ADAPTERS entry handles this mod ("hcoord"); null unless kind is clone-installed. */
  adapter: string | null;
  /** The folder a clone-installed mod is installed from; null otherwise. */
  adapter_source: string | null;
  /** Relative paths that differ from the baseline (or, clone-installed, from adapter_source). */
  changed: string[];
  /**
   * Whether status reflects GitHub. `hmod list` never touches the network, so it's false there:
   * a linked mod's up_to_date only means "no local edits".
   */
  remote_checked: boolean;
}

/** `hmod list --json` */
export interface ListResult {
  ok: true;
  herdr_home: string;
  mods: ModEntry[];
}

/** `hmod link --json` */
export interface LinkResult {
  ok: true;
  mod: string;
  source: SourceRef;
  /** False when the mod was already linked to exactly this. */
  linked: boolean;
}

/** A line of links.jsonl. */
export interface LinkLogEntry {
  at: string;
  event: "link" | "unlink";
  mod: string;
  repo: string;
  path: string;
  branch: string | null;
  /** What did it. Only a person can link: the dialog or the terminal. */
  via: "dialog" | "terminal";
  /** Why the last check offered this source. null: typed by hand, or (unlink) not applicable. */
  offered_because: string | null;
}

/** `hmod unlink --json` */
export interface UnlinkResult {
  ok: true;
  mod: string;
  /** False when it wasn't linked. */
  unlinked: boolean;
}

/** Any command with --json that fails prints this on stdout, and exits non-zero. */
export interface ErrorResult {
  ok: false;
  error: string;
}
