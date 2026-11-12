<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Source workflow

In source mode (`"mode": "source"` in `fireforge.json`) the fork's changes are ordinary files tracked by git. This page covers how they map onto Firefox, how upstream files are declared, how FireForge brings them into a workspace, and how a patch queue is written from them. [getting-started.md](getting-started.md) shows the daily loop; [workspaces.md](workspaces.md) covers the workspaces builds run in.

## The mapping

```json
{
  "mode": "source",
  "source": {
    "root": "src",
    "metadataRoot": ".fireforge-sources",
    "pristineCommit": "3f1c...e9"
  }
}
```

- `source.root` (`src` by default): `src/<path>` supplies the Firefox file `<path>`. `src/browser/base/content/browser.js` is `browser/base/content/browser.js` in the engine.
- `source.metadataRoot` (`.fireforge-sources` by default): holds one override record per upstream file the project touches.
- `source.pristineCommit`: the commit the pinned Firefox archive imports as. Every host derives the same commit from the same archive, so the pin is exact.

A file under `src/` whose path Firefox does not have is a created file. It needs nothing else. A file whose path Firefox has needs an override record, which says which upstream version the edit started from.

The owned files are what git sees in the working tree: tracked files and untracked files git does not ignore. FireForge never captures or retains a copy, so two clean checkouts of one commit read the same. `src/.gitattributes` and `src/.gitignore` configure git and are not engine files.

## Declaring an upstream file: `override`

```sh
npx fireforge override browser/base/content/browser.js
$EDITOR src/browser/base/content/browser.js
```

`override` writes the record and copies the pristine bytes to `src/<path>` for you to edit. An edit made before the override is refused: move it aside, run `override`, and put it back.

- `--delete` declares that the project deletes the upstream file. The record is a tombstone and there is no owned file.
- `--component <name>`: the component the change belongs to: a group of upstream changes that lint, policy and waivers name by this name, and one patch of an export ([Groups](#groups)). The default is the path's top directory.
- `--classification registration|exception`: `registration` (the default) wires an addition into Firefox, such as a `jar.mn` line; `exception` is a reviewed change to upstream behaviour and needs `--adr <path>`, a decision record in the project.

The record lives at `<metadataRoot>/overrides/<path>.json`:

```json
{
  "base": {
    "blob": "8c3f0d2a5e1b4c7d9f6a2b0e3d5c7a9b1e4f6d8c",
    "commit": "3f1c7b2d9e0a4c6f8b1d3e5a7c9f0b2d4e6a8c1f",
    "mode": "100644"
  },
  "classification": "registration",
  "component": "browser",
  "kind": "override"
}
```

`base` is the upstream identity: the pristine commit, the file's blob and mode at that commit. `kind` is `override` or `delete`.

The first override in a repository also configures the merge driver (see below).

The commands that edit tracked files for you (`register`, `wire`, `token add`, `furnace`) write the owned copy under `src/`. Their first edit of an upstream build manifest declares its override as a `registration` on the way.

## Giving a file back: `restore`

```sh
npx fireforge restore browser/base/content/browser.js
```

`restore` removes the record and the owned file; the next build brings the upstream bytes back into the workspace. It refuses while the owned file has uncommitted edits; `--discard` drops them.

## `status` and `verify`

```sh
npx fireforge status
npx fireforge verify
```

Both read `src/` and the pristine repository directly; neither needs a workspace or a build.

`status` lists every owned path with its group, and these problems:

| Code                 | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `undeclared`         | The file exists upstream but has no override record                                       |
| `stale`              | The record's base is not the pinned upstream file, or the path is not upstream at the pin |
| `orphaned`           | A record without its owned file                                                           |
| `adr-missing`        | An exception whose decision record does not exist                                         |
| `ignored`            | A file under `src/` that git ignores, so a commit would not hold it                       |
| `filtered`           | Git attributes (`text`, `eol`, `filter`, ...) could change the file's bytes on commit     |
| `unmerged`           | An unresolved merge conflict                                                              |
| `tombstone-has-file` | A `delete` record with an owned file beside it                                            |
| `case-collision`     | Two paths that differ only in case                                                        |
| `unsupported-kind`   | A link, submodule or directory where a regular file belongs                               |
| `path-conflict`      | A file where upstream has a directory, or the reverse                                     |
| `invalid-path`       | A path Firefox cannot hold                                                                |
| `invalid-record`     | A record that does not parse or does not match its schema                                 |

Each problem carries the command that fixes it. The last seven make a path's content undefined: builds, tests and `export` refuse until they are fixed. `status --check` exits 1 while anything is listed.

`verify` checks every override record and owned file against the pristine repository and reports the same kinds of problem.

## Groups

Every owned path is in exactly one group. A group is what `patchLint.waivers`, `patchPolicy.scopeRules`, `patchPolicy.reservedRanges` and lint findings name, and one patch of an export. Its ID is a name the project wrote, used as it is:

| Group                                               | ID                                                       |
| --------------------------------------------------- | -------------------------------------------------------- |
| The upstream changes of a component                 | The component, as the override records spell it          |
| Created files an `exportQueue.groups` entry matches | The entry's `name`                                       |
| The remaining created files, by directory           | `created-<directory>`, such as `created-browser-modules` |
| The files a Furnace component deploys               | The component's tag, such as `moz-my-widget`             |

```sh
npx fireforge status --groups
```

```
214 owned path(s) in 4 group(s), and 1 Furnace component(s)
  ui-sidebar  component  3 path(s)
  created-browser-modules  created  180 path(s)
  ui-tiles  created  31 path(s)
  moz-my-widget  furnace  2 path(s)
```

An ID depends only on the group's own names and paths: adding a group renames nothing, and an export's numbering is no part of it. Two groups may not share an ID (`source-group-name-collision`): give the `exportQueue` group another name than the component.

The size rules (`large-patch-lines`, `large-patch-files`) judge components, whose extent is the fork's reach into upstream. Created files and Furnace components are judged file by file (`file-too-large`), whatever group they are in.

## Materialization

A workspace is an engine checkout with its build, kept under `~/.fireforge/workspaces/`. Every command that works in a workspace (the ones with a `--workspace` option, and `gate`) leases one and first materializes the checkout into it: the engine becomes exactly the pristine commit plus your owned files. It then deploys the Furnace components, so the engine holds what this checkout builds whichever checkout leased it before.

- Only paths that differ are written. A ledger in the workspace remembers what was written for each owned file and the file's size, modification time, change time and inode, so an unchanged run reads no file content.
- A path the ledger records and the checkout does not own gets its upstream bytes back, or is removed when upstream has none.
- Two checkouts can lease the same workspace one after the other; each lease writes only the difference.
- The writes and the ledger update are one transaction. An interrupted materialization is undone before the next one looks at the engine.

**The drift rule.** Materialization changes an engine file only when the file holds bytes it can account for: what it wrote last time, what Furnace deployed on top of that, or the pristine bytes for a path it never wrote. Anything else was changed by someone else (an editor pointed into the workspace, a script), and the command stops with `materialize-drift`, listing the files:

```
Engine files changed outside FireForge; materialization would overwrite them:
  browser/base/content/browser.js
```

Save what you need from those files, then reset the workspace and run the command again:

```sh
npx fireforge workspace repair w1
```

Edit the files under `src/`, never the files inside a workspace.

## Writing a patch queue: `export`

```sh
npx fireforge export
npx fireforge export --out ../mybrowser-patches
```

`export` writes the owned changes as a patch queue that `fireforge import` in a patch-mode project replays byte for byte, for a public mirror, for CI that consumes patches, or to go back to patch mode. It writes into `patches/` by default or into `--out`, which must be empty or hold a queue FireForge generated. Before anything is written, the queue is replayed onto the pristine commit and must produce exactly the tree this checkout builds.

The patches are the [groups](#groups) of the owned paths under `src/`, one patch each:

1. Every component is one patch: all modified and deleted upstream files with that component.
2. Created files follow, because a created file can take the place of an upstream file a component deletes. A created file joins the first `exportQueue.groups` entry one of whose globs matches it.
3. The remaining created files group by directory: the deepest directory whose files together fit `exportQueue.maxGroupBytes` (1 MiB by default) is one patch.

Within each of the two, patches apply in ID order, and are numbered from 1. A patch is named after its group's ID in lowercase with other characters as hyphens; an ID spelled like a patch file (`012-ui-sidebar.patch`) gives that name (`ui-sidebar`). Nothing is put in front of a name: its first word is the patch's category. An ID that leaves no name starting with a letter cannot be exported (`source-group-unexportable`), and two IDs that give one name collide. Each path is in exactly one patch, so no patch depends on another's context, and an edit to one file changes only that file's patch.

The files Furnace deploys are not in the queue: a consumer gets them from `components/` and `furnace.json`, which deploy at its build.

The manifest carries each patch's tier (from `exportQueue.componentTiers` or the group's `tier`) and the lint waivers `patchLint.waivers` declares for its group.

## The merge driver

Two branches that each first-touch one upstream file both add `src/<path>` with no common ancestor in the project's history, so plain git sees an add/add conflict over the whole file. FireForge's merge driver merges them against the pristine blob the override record names instead.

`src/.gitattributes` routes owned files through it:

```
* -text
* merge=fireforge
```

The driver itself is configured in the repository's git config, shared by all its worktrees. The first `override` installs it; to install it in a fresh clone:

```sh
npx fireforge merge-driver install
```

The driver needs Git 2.44 or later, which tells it which commit the ancestor came from. It uses the pristine blob only when that commit lacks the path. With an older Git, or when no single merge base exists (several merge bases, `git am -3`, a stash), it merges the empty ancestor as given, which is git's own add/add conflict.

## Moving to another Firefox version: `rebase`

```sh
git status   # must be clean
npx fireforge rebase --to 140.10.0esr
```

`rebase` needs a committed tree. It downloads the version (`--product`, `--sha256`, `--candidate`), then merges every owned file three ways: the old pristine file is the base, your file is ours, the new pristine file is theirs. The result is written to `src/`, the override records and the pin in `fireforge.json` in one transaction. Review it with `git diff`; undo it with git.

A conflict is left the way git leaves one: conflict markers in the owned file, and the three versions as unmerged entries in the index, so `git status` lists it, `git checkout --ours` or `--theirs` picks a side, and a commit is refused until it is resolved. The records of conflicted paths already name the new upstream file, so resolving is only a matter of the file's content. `rebase` exits 10 when conflicts remain.

```sh
$EDITOR src/browser/base/content/browser.js
git add src/browser/base/content/browser.js
npx fireforge status
git commit -am "Rebase onto 140.10.0esr"
```

`--continue`, `--abort` and `--dry-run` belong to patch mode; in source mode git is the undo.

## Coming from patch mode, going back

`fireforge migrate --to-source` converts a committed patch-mode project in place ([patch-workflow.md](patch-workflow.md#moving-to-source-mode)). Each patch becomes a component, and `exportQueue.groups` keeps each patch's created files together (as `<patch>-created` when the patch also changed upstream files), so a later `export` writes a queue shaped like the one you had.

To go back to patch mode:

```sh
npx fireforge export
```

Then edit `fireforge.json` by hand: set `"mode": "patches"` and remove the `source` block (`config set` refuses to change `mode`, because the two keys change together). Remove `src/` and the metadata root, and apply the queue to a fresh engine:

```sh
git rm -r src .fireforge-sources
npx fireforge download
npx fireforge import
```
