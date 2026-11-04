<h1 align="center">herdr-mod-updater</h1>

<h3 align="center">See which of your Herdr mods have updates, and install them with one button</h3>

<p align="center">herdr-mod-updater (<code>hmod</code>) adds a <b>Mod updates</b> dialog to the <a href="https://herdr.dev">Herdr</a> desktop app. It lists every mod you have installed, asks GitHub which ones have something newer, and gives you an <b>Update</b> button per mod and <b>Update all</b> at the top. Every update is checked before it goes in and backed up, and it rolls back if the new version won't load.</p>

<p align="center"><sub>✓&nbsp;Runs&nbsp;on&nbsp;your&nbsp;machine &nbsp; ✓&nbsp;State&nbsp;in&nbsp;plain&nbsp;files &nbsp; ✓&nbsp;Never&nbsp;replaces&nbsp;your&nbsp;edits&nbsp;without&nbsp;asking &nbsp; ✓&nbsp;macOS,&nbsp;Bun</sub></p>

<br />

## Nothing records where a mod came from

Herdr's gallery installs a mod by copying a folder, so a week later nothing says which repo it was or which version you have. Names don't settle it: four different repos are called `herdr-quota`, and an install may be renamed if its name was taken.

So hmod goes by content. It hashes the files in each mod and looks for a repo with the `herdr-mod` topic holding those exact files at some commit. If exactly one repo does, the mod is linked to it. If several do, or only some files match, hmod shows you the candidates and you choose. A name alone never links anything.

```
Your mods folder                     hmod                             GitHub
 ├─ weather-bar  ─── same files ───  linked to demo/weather-bar  ───  2 commits newer
 ├─ herdr-quota  ─── same files ───  in 2 repos: you pick
 ├─ my-timer     ─── edited ───────  No source known: link it by hand
 └─ files        ─── ships with Herdr: updates with the app
```

## Why not just copy the folder again?

| | **hmod** | Copying from the gallery by hand |
|---|:---:|:---:|
| **Tells you which mods have updates** | ✅ | ❌ |
| **Tells you which installed files you've edited** | ✅ | ❌ |
| **Checks the new version loads before installing it** | ✅ | ❌ |
| **Keeps a backup and rolls back a failed update** | ✅ | ❌ |
| **Warns when an update starts using `exec`, `hc` or `fetch`** | ✅ | ❌ |

## What it looks like in Herdr

There's no screenshot yet. With two mods waiting and three settled, the dialog reads:

```
Mod updates   Checked 5m ago             [ Check for updates ]
[ Update all (1) ]

 Weather bar  Update available                     [ Update ]
 1.2.0 → 1.3.0 · 2 commits behind

 Clipboard log  Edited locally                     [ Update ]
 main.js · 0.1.0 → 0.2.0 · 1 commit behind

 Quota  No source known                       [ Link source ]
 2 possible sources found

 ▸ Up to date (1)
 ▸ Updated with Herdr (1)
```

### 🔍 Only what needs you

Mods with an update, local edits, an unknown source or an error get a row with a button. Mods that are fine fold away under **Up to date**, **Updated with Herdr** and **Your clones**. Opening the dialog shows the last answer straight away, and checks again if that answer is more than 6 hours old.

### ⬆️ Updates that can't leave a mod half done

An update downloads the new files to a staging folder, checks each one against its git SHA, and runs `herdr-app check` on them. Only then does it back up your mod and install, one file at a time with `main.js` last, because Herdr reloads on every save. It verifies the result and runs `herdr-app check` again. If that fails, the old version goes back.

### ✋ Your edits stay yours

hmod remembers what it installed, so it can tell an update from a local edit. A mod you've edited says **Edited locally**, and **Update all** skips it. Its own **Update** button asks first, names the files, and keeps a backup. hmod never touches the files Herdr injects (`gpui-kit.d.ts`, `jsconfig.json`) or any dotfile.

### 🔔 A heads-up on what changed

After an update, hmod tells you if the new version mentions `exec`, `hc`, `fetch` or `watchFolder` when the old one didn't, and if the repo's `keys.json` changed. The permission check reads the source as text, so treat it as a heads-up and not a guard.

## Get started in three steps

<table>
<tr>
<td align="center" valign="top" width="33%"><h3>1️⃣</h3><b>Install</b><br /><sub>Paste one line into Claude Code, or clone this repo and follow a few steps. See <a href="#install">Install</a> below.</sub></td>
<td align="center" valign="top" width="33%"><h3>2️⃣</h3><b>Open it</b><br /><sub>Press the key you set up, or run <code>herdr-app do mod.open --name mod-updater</code>. The first time, it checks every mod by itself.</sub></td>
<td align="center" valign="top" width="33%"><h3>3️⃣</h3><b>Update</b><br /><sub>Click <b>Update</b> on a mod, or <b>Update all</b>. For a mod with no known source, click <b>Link source</b> and say which repo it came from.</sub></td>
</tr>
</table>

## Install

The quickest way is to paste this into Claude Code:

```
Read ~/.config/herdr-app/AGENTS.md, then install https://github.com/jonathan-fielding/herdr-mod-updater by following the Install section of its README.
```

Or do it yourself with the steps below.

### 1. Check you have the prerequisites

- macOS
- the Herdr app, with `herdr-app` on your `PATH`
- git
- [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
- optional: the [GitHub CLI](https://cli.github.com) (`gh`), signed in. hmod works without it, but GitHub allows far fewer requests without a token, and a check may stop partway until the limit lifts

### 2. Get the code and the `hmod` command

```sh
git clone https://github.com/jonathan-fielding/herdr-mod-updater.git
cd herdr-mod-updater

# put `hmod` on your PATH: a small shim that runs this checkout's CLI with Bun
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec %s %s/src/cli.ts "$@"\n' "$(command -v bun)" "$PWD" > ~/.local/bin/hmod
chmod +x ~/.local/bin/hmod
hmod --version
```

If `hmod` isn't found, add `~/.local/bin` to your `PATH` (`herdr-app` usually lives there too).

Keep the clone where it is. The dialog runs hmod from this folder, and updating hmod pulls into it.

### 3. Install the dialog

```sh
hmod mod install
herdr-app check ~/.config/herdr-app/mods/mod-updater
```

This copies the mod to `~/.config/herdr-app/mods/mod-updater`. Don't edit the installed copy: the next install overwrites it.

### 4. Give it a key

Herdr's palette can't list a mod, so without a key you open it with:

```sh
herdr-app do mod.open --name mod-updater
```

To use a key, add this to the `global` section of `~/.config/herdr-app/keys.json`, if you aren't already using it. `hmod mod install` doesn't touch that file.

```json
"cmd-shift-u": "mod.open:mod-updater"
```

The key opens the dialog, and pressing it again closes it.

### From the Herdr mod gallery

Herdr's gallery copies `mods/mod-updater/` into your mods folder and runs `herdr-app check`. That gives you the dialog and nothing else: it's a front end for the `hmod` CLI, which the gallery doesn't install. Until the CLI is set up, the dialog says so and links here.

To finish, do steps 1 and 2 above, then run `hmod mod install`. It takes over the gallery copy and records where your bun and `cli.ts` are.

### Updating

Mod updates lists itself like any other mod. Click **Update** on its row, which pulls your clone and reinstalls the dialog, or do the same by hand:

```sh
cd herdr-mod-updater
git pull
hmod mod install
```

The dialog and the CLI have to stay in step, so it's never copied from GitHub, and it can't be linked. The clone needs to be clean, on a branch that tracks origin. If the new code can't install, the error says how to go back.

### Removing it

```sh
rm -rf ~/.config/herdr-app/mods/mod-updater ~/.herdr-mod-updater ~/.local/bin/hmod
```

That removes the dialog, hmod's records and backups, and the command. Your other mods stay as they are. Delete the clone and any key you added yourself.

## Using the Mod updates dialog

**The top**
- **Check for updates** asks GitHub about every mod. It can take a while with many mods, and you can close the dialog meanwhile: the check keeps going, and opening the dialog again picks it up.
- **Update all (N)** checks first, then updates every mod with an update, one at a time. One failing doesn't stop the rest. A card at the top of the list then sums up what was updated, failed and skipped, with anything you should know.

**What a row can say**

| Row says | Status in the CLI | Means | Button |
|---|---|---|---|
| Update available | `update_available` | a newer version exists | **Update** |
| Edited locally | `modified` | your files differ from what was installed | **Update**, which asks first; none if there's nothing newer |
| No source known | `unlinked` | hmod can't tell where it came from | **Link source** |
| Error | `error` | the status couldn't be worked out; the row says why | **Retry** |
| under Up to date | `up_to_date` | nothing newer | none |
| under Updated with Herdr | `herdr` | ships with Herdr and updates with the app | none |
| under Your clones | `unlinked` | made with `mod.clone`: yours, and never updated | none |

**Link source** shows any possible sources hmod found, each with a **Link** button and how well it matched. You can also type `owner/repo`, `owner/repo/mods/name`, or paste a GitHub URL of either. Linking starts a check.

**While an update runs**, its row goes through `Updating: downloading`, `checking`, `backing up`, `installing` and `verifying`. Buttons stay disabled until it ends. Closing the dialog doesn't stop it.

## Limits

- **A mod you've renamed or edited usually needs a manual link.** hmod links by itself only when every file equals one commit in one repo, so an edit rules that out, and so does a rename that changed the mod's own `mods/<name>/` paths. Search also goes by the mod's name and title, so a mod with a new name may not turn its repo up at all. Link these with **Link source**, or from a terminal. Give `--path` when the folder in the repo has a different name from yours:

  ```sh
  hmod link my-quota owner/herdr-quota --path mods/herdr-quota
  ```

- **Linking makes what's on disk the baseline.** That includes any edits you've made, so hmod stops seeing them as edits. If they differ from the repo, the mod shows **Update available**, and the next update replaces them with no question asked, even from **Update all**. The backup still has them. To keep your edits, don't update that mod, or copy them back from the backup afterwards.
- **Automatic matching only looks at repos with the `herdr-mod` topic**, up to 20 for each mod, at `mods/<name>/` on the default branch, in the 30 newest commits that touched that folder. For anything else, link by hand: `--path` takes any folder, and `--branch` any branch (the dialog's link box always uses the default branch).
- **`keys.json` is never merged.** hmod tells you when a repo's `keys.json` changed. Add the keys you want yourself.
- **`RECIPE.md` and `preview.png` aren't installed.** Only the mod's own folder is.
- **Mods with symlinks or git submodules are refused.** A mod too big for GitHub to list in one go fails with an error.
- **hmod installs code it hasn't read.** Herdr mods run in the app, and an update can do anything the new version's code does. The heads-up above is a text search.

## Questions

### Will it overwrite my edits?

Not from a mod marked **Edited locally**. **Update all** skips those, and a single **Update** asks first and keeps a backup. See the second point under [Limits](#limits) for the one case where edits aren't marked.

### How do I undo an update?

There's no undo command. Backups are plain copies in `~/.herdr-mod-updater/backups/<mod>-<time>/`, and the last 3 for each mod are kept. Copy one back:

```sh
cp -R ~/.herdr-mod-updater/backups/<mod>-<time>/. ~/.config/herdr-app/mods/<mod>/
```

Any file the update added stays until you delete it. The mod will then show as **Edited locally**, because it no longer matches what hmod installed.

### What about hcoord?

[herdr-coordinator](https://github.com/jonathan-fielding/herdr-project-coordinator)'s mod has to stay in step with its CLI, so hmod never copies GitHub files over it. Its **Update** runs `git pull --ff-only` in your hcoord clone, then `hcoord mod install`. It won't start if the clone has uncommitted changes, isn't on a branch, or doesn't track origin. hmod updates its own mod the same way. Other mods installed from a clone would need an entry in `src/inventory.ts` and `src/adapters.ts`.

### Why can't I update a mod that ships with Herdr?

Mods listed in Herdr's `installed.json` update with the app, so anything hmod put there would be replaced. To change one, clone it with `mod.clone`. Clones are yours, and hmod leaves them alone.

### Does anything leave my machine?

hmod reads from `api.github.com`, and for a linked mod downloads its files from there. If you're signed in to `gh`, requests carry that token, which hmod asks `gh` for on each run and doesn't store. Searching sends your mods' names and titles, and asking whether a repo has a file sends that file's SHA. For hcoord and for its own mod it runs `git fetch` and `git pull` against the clone's origin. The dialog itself makes no network requests.

### How do I check it's working?

`hmod list` works with no network. `hmod check` shows what GitHub says. `herdr-app check ~/.config/herdr-app/mods/mod-updater` checks the installed dialog.

## Reference

### Data and settings

Everything lives in `~/.herdr-mod-updater/` (`HMOD_HOME` overrides it):

```
sources.json                each linked mod: repo, folder, branch, commit, and the hashes of what was installed
check.json                  the last answer from GitHub
github-cache/               GitHub's replies, kept so repeat checks cost less of the rate limit
backups/<mod>-<time>/       copies made before updates, the last 3 per mod
staging/                    downloads in progress, removed afterwards
mod-job.log                 the running or last job the dialog started
```

| Environment variable | Default | Meaning |
|---|---|---|
| `HMOD_HOME` | `~/.herdr-mod-updater` | hmod's data folder |
| `HERDR_APP_HOME` | `~/.config/herdr-app` | Herdr's home. Set when you run `hmod mod install`, both of these are recorded so the dialog uses them too |
| `HMOD_HERDR_APP` | `herdr-app` | the program that runs `check` |
| `HMOD_GITHUB_API` | `https://api.github.com` | a stand-in server for testing, which never gets your token |

### The CLI

The dialog drives it, so you rarely need it. `hmod --help` lists everything, and `--json` on any command but `--help` and `--version` prints machine-readable output.

| Command | Does |
|---|---|
| `hmod list` | every mod and its status, from local files. With no network, a linked mod's `up_to_date` only means no local edits |
| `hmod check` | asks GitHub what's new, and finds unlinked mods' sources by content |
| `hmod check --cached` | the last answer, with no network call |
| `hmod link <mod> <owner/repo> [--path mods/x] [--branch b]` | records where a mod came from. `--path` defaults to `mods/<mod>`, `--branch` to the repo's default |
| `hmod unlink <mod>` | forgets where a mod came from |
| `hmod update <mod> [--force]` | installs the newest version. Local edits stop it, unless `--force` |
| `hmod update --all` | updates every mod with an update, skipping modified, unlinked and error mods |
| `hmod mod install` | puts the dialog in Herdr's mods folder |
| `hmod --version` | the version |

Commands exit non-zero on failure. `hmod update --all --json` prints one line per step.

### How it's built

- `mods/mod-updater/`: the dialog, a Herdr mod. It reads `hmod check --cached --json` and calls the CLI for everything else. Long jobs run as a detached `hmod` writing to `mod-job.log`, which the dialog reads every half second, because a mod's `exec` stops a program after 30 seconds. `hmod-path.js` holds a blank default there, and `hmod mod install` writes the real path into the installed copy only.
- `src/`: the `hmod` CLI. `inventory.ts` works out local status, `match.ts` finds sources by content, `check.ts` asks GitHub, `update.ts` installs and rolls back, and `adapters.ts` handles hcoord and hmod's own mod.
- `tests/`: the suite never touches your real homes or the network. It uses temp homes and a stand-in GitHub (`tests/fake-github.ts`).

To work on it, install the dev dependencies first:

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
