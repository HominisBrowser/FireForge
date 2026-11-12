<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Patch workflow

In patch mode (`"mode": "patches"` in `fireforge.json`) you edit Firefox in place under `engine/`, and FireForge stores your changes as a queue of patches in `patches/`. This page covers the queue in depth. [getting-started.md](getting-started.md) shows the daily loop.

## The queue

`patches/` holds one `.patch` file per patch and a manifest, `patches.json`:

```
patches/
  patches.json
  001-branding-assets.patch
  010-ui-sidebar.patch
  012-ui-toolbar.patch
```

A patch file is plain `git diff` output: `a/` and `b/` prefixes, three lines of context, full blob ids, binary files as `GIT binary patch` sections, and no rename detection (a rename is a deletion plus an addition). The same change always gives the same bytes.

The manifest is the one record of which patches exist, their order and what is known about each:

```json
{
  "version": 2,
  "firefox": { "product": "firefox-esr", "version": "140.9.0esr" },
  "patches": [
    {
      "order": 1,
      "name": "branding-assets",
      "description": "Logos, icons and brand strings",
      "tier": "branding"
    },
    {
      "order": 10,
      "name": "ui-sidebar",
      "description": "The sidebar panel",
      "lintIgnore": [
        "file-too-large",
        { "rule": "large-patch-lines", "max": 1800, "reason": "Reviewed: one feature" }
      ],
      "stagedDependencies": [
        {
          "file": "browser/base/content/browser-sidebar.js",
          "creates": "browser/modules/Sidebar.sys.mjs"
        }
      ]
    },
    { "order": 12, "name": "ui-toolbar", "description": "Toolbar buttons" }
  ],
  "retired": [{ "order": 11, "name": "ui-old-toolbar", "reason": "Folded into ui-toolbar" }]
}
```

- `name`: lowercase words joined by hyphens. The first word is the patch's category (`ui`, `branding`).
- `order`: the position in the apply order. Gaps are allowed unless `patchPolicy.allowGaps` is `false`. The file name follows from order and name: `<order padded to three digits>-<name>.patch`.
- `firefox`: the Firefox release the queue was last verified against. A patch whose stamp differs carries its own `firefox` field.
- `tier`: `branding` holds the patch to the larger branding size bands of the size rules.
- `lintIgnore`: waivers for this patch ([quality.md](quality.md#waivers)).
- `stagedDependencies`: `file`, in this patch, imports or registers `creates`, which a later patch creates. Lint accepts that forward reference because it is declared.
- `retired`: orders that belonged to deleted patches and stay taken.

A command that names a patch takes its order (`10` or `010`), its file name (with or without `.patch`), its name (`ui-sidebar`), or its name without the category (`sidebar`) when that is unique.

FireForge reads a manifest with `"version": 1` (rows carrying `filename`, `category` and `filesAffected`) and writes it as version 2 the next time the queue changes.

## Applying the queue: `import`

```sh
npx fireforge import
```

Every file the queue touches ends up holding what the queue leaves there. Other edits in `engine/` are kept. `import` refuses to overwrite edits in the queue's files that no patch accounts for; `--force` overwrites them after saving a recovery snapshot.

`--until <patch>` applies the queue up to and including that patch.

When a patch does not apply, the import pauses. The engine holds the state before that patch, plus the hunks that fitted, and `.rej` files beside the files whose hunks did not. Then:

1. Finish the change by hand in `engine/`, using the `.rej` files.
2. Either run `fireforge import --continue`, which rewrites the failed patch from what `engine/` holds and applies the rest, or run `fireforge resolve` to rewrite only that patch and `fireforge import --continue` afterwards.

The rewritten patch body is exactly that patch's own work: the change in its files relative to what the patches before it leave there, deletions included. `fireforge status` shows a paused import as `session-paused`.

## Capturing edits: `export`

`export` turns edits no patch holds into a new patch:

```sh
npx fireforge export browser/base/content/browser-sidebar.js browser/modules/Sidebar.sys.mjs --name ui-sidebar -d "The sidebar panel"
npx fireforge export --all --name ui-misc -d "Small fixes"
```

- Paths are engine files or directories. `--all` captures every edit no patch holds.
- `--name` is required. `-d`/`--description` is recorded in the manifest.
- The patch goes after the last one, or where `--order <n>`, `--before <patch>` or `--after <patch>` puts it. With `patchPolicy.ranges` the order must lie in the category's range.
- `--tier branding` sets the size tier.
- A named file that another patch already changes is refused; under a named directory such files are left out. Those edits belong to `re-export`.

## Updating patches: `re-export`

`re-export` rewrites existing patches so the queue ends in what `engine/` holds in their files:

```sh
npx fireforge re-export ui-sidebar
npx fireforge re-export --all
npx fireforge re-export --all --dry-run
```

- A patch whose files hold no edit is left byte for byte.
- A file deleted in `engine/` is recorded as a deletion. A file the patch created that is absent from `engine/` leaves the patch.
- `--scan` also adopts edits no patch owns in the directories the selected patches' files are in. Each adopted file goes to the last selected patch with a file in its directory.
- `--stamp` stamps the rewritten patches with the project's Firefox version.
- `--dry-run` reports what would change and writes nothing.

### Files several patches change

When two or more patches change one file, an edit to that file goes to the last of them that is being re-exported. The others keep their change unchanged, and the patches after the receiving one are adjusted so they still apply. So to put an edit into an earlier patch, re-export only that patch:

```sh
npx fireforge re-export ui-sidebar
```

## Throwing edits away: `discard` and `reset`

```sh
npx fireforge discard browser/base/content/browser.js
npx fireforge reset --yes
```

- `discard <paths>` puts files back: a file the queue touches gets the queue's content (re-created or removed as the queue has it), any other changed file goes back to upstream, and an untracked file is deleted. Paths are relative to `engine/`, or to the current directory when you run the command inside `engine/`. A directory covers every changed file below it.
- `reset` restores every tracked file of `engine/` to pristine Firefox and removes untracked files, keeping the build output. A paused import or rebase is dropped. Without a terminal it needs `--yes`. Run `fireforge import` afterwards to apply the queue again.

Both save a recovery snapshot first.

## Recovery snapshots

Before a command destroys engine edits (`discard`, `reset`, `import --force`, `rebase --force`, `rebase --abort`, `download --force`), it saves the working tree of `engine/` as a commit under `refs/fireforge/recovery/<time>-<label>-<id>` in the engine's git repository and prints the ref. The newest 20 are kept. The repository's index, HEAD and branches do not move.

```sh
git -C engine for-each-ref refs/fireforge/recovery/
git -C engine diff HEAD refs/fireforge/recovery/<ref> -- browser/base/content/browser.js
git -C engine checkout refs/fireforge/recovery/<ref> -- browser/base/content/browser.js
```

## Queue operations: `patch`

Each operation is one transaction on the queue. The ones that move content between patches replay the queue and are refused when the result would differ from what the queue produced before.

```sh
npx fireforge patch rename ui-sidebar ui-side-panel
npx fireforge patch reorder ui-toolbar --before ui-sidebar
npx fireforge patch split ui-sidebar browser/modules/Sidebar.sys.mjs --name ui-sidebar-module
npx fireforge patch move-files ui-toolbar ui-sidebar browser/base/content/toolbar.css
npx fireforge patch delete ui-misc
npx fireforge patch retire ui-old-toolbar --reason "Folded into ui-toolbar"
npx fireforge patch compact
npx fireforge patch set ui-sidebar --description "The sidebar panel" --tier none
```

- `rename`: order, body and metadata stay; the file follows the name.
- `reorder`: `--order`, `--before` or `--after`. An occupied order is freed by moving the run of patches above it up by one. Patches that change the same lines keep their relative order.
- `split`: moves some files of a patch into a new patch, right after it unless placed elsewhere. Staged dependencies declared on the moved files go with them.
- `move-files`: moves files from one patch into another. Where the target already changes a file, the two changes are combined. A source patch left with no files is removed.
- `delete`: removes a patch. `engine/` is not touched: its files keep their content and belong to no patch (`fireforge discard` puts them back). Refused when another patch does not apply without it.
- `retire`: like `delete`, but the order stays recorded in `retired`, so no other patch gets it and the gap check sees no gap.
- `compact`: closes gaps in the numbering, keeping the apply order. With `patchPolicy.ranges`, each category range is numbered from its first patch.
- `set`: edits metadata without touching the body: `--description`, `--tier branding|none`, `--lint-ignore <rule>` (with `--max <n>` and `--reason` for a size ceiling), `--remove-lint-ignore <rule>`, `--staged-dependency <file>:<creates>`, `--remove-staged-dependency <file>:<creates>`.

```sh
npx fireforge patch set ui-sidebar --lint-ignore large-patch-lines --max 1800 --reason "Reviewed: one feature"
npx fireforge patch set ui-sidebar --staged-dependency browser/base/content/browser-sidebar.js:browser/modules/Sidebar.sys.mjs --reason "Module lands in ui-sidebar-module"
```

With `patchPolicy` set, an operation that would create a policy problem (an order outside the category's range, a missing description under `requireDescription`, a name the `filenamePattern` refuses) is refused, or only reported under `mutationMode: "warn"`.

## Checking the queue

```sh
npx fireforge verify
npx fireforge lint --per-patch
```

- `verify` checks the manifest, every patch body, and that the queue replays onto the engine's `HEAD`. It reports patch files the manifest does not list (`stray-patch-file`), empty patches (`empty-patch`), unsafe paths and binary sections without content, ordering-policy problems (`patch-policy`), a patch that creates a file upstream already has (`replaces-upstream-file`, fixed by re-exporting it), and a patch that does not apply (`does-not-apply`).
- `lint` judges what `engine/` holds. `--per-patch` judges the stored queue patch by patch instead, which is what CI should run: it sees exactly what is committed.

`status` lists every owned path with its patch, and these states:

| Code             | Meaning                                                              | Fix                                                  |
| ---------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `unexported`     | Edited since its patch was written                                   | `fireforge re-export` or `discard`                   |
| `unmanaged`      | Changed, and no patch holds it                                       | `fireforge export <path>` or `discard`               |
| `unapplied`      | The queue changes it, and the engine holds the upstream state        | `fireforge import`                                   |
| `outdated`       | The engine holds what an earlier import wrote; the queue moved since | `fireforge import`                                   |
| `missing`        | Absent from the engine where the queue leaves a file                 | `fireforge discard <path>`                           |
| `session-paused` | An import or rebase is unfinished                                    | `fireforge import --continue` or `rebase --continue` |
| `does-not-apply` | A patch does not apply                                               | `fireforge import`                                   |

## Moving to another Firefox version: `rebase`

```sh
npx fireforge rebase --to 140.10.0esr
```

`rebase` downloads the version (`--product`, `--sha256` and `--candidate` pin it further), writes it to `fireforge.json`, replaces `engine/` with a checkout of the new source, and applies the queue again with reduced context, rewriting every patch against the new source and stamping it with the new version. Edits no patch holds are refused; capture them first, or pass `--force` to save them in a recovery snapshot and go ahead.

`--dry-run` reports whether the queue applies to the target version and changes nothing.

When a patch does not apply, the rebase pauses exactly as `import` does: fitting hunks applied, `.rej` files for the rest. Fix the files in `engine/`, then:

```sh
npx fireforge rebase --continue
```

Repeat until the rebase completes. The queue itself is written once, at the end. To give up:

```sh
npx fireforge rebase --abort
```

`--abort` puts back the previous version in `fireforge.json`, a checkout of it in `engine/`, and the queue applied, after a recovery snapshot of the engine.

## Moving to source mode

```sh
git add -A && git commit -m "Before migration"
npx fireforge migrate --to-source
```

`migrate --to-source` replays the queue onto the pinned Firefox and writes the result as owned files under `src/` with an override record per changed upstream file. Each patch becomes a component. `fireforge.json` takes `"mode": "source"`, a `source` block, each patch's tier and lint waivers, and `exportQueue.groups` that keep each patch's created files together in an export (named `<patch>-created` when the patch also changed upstream files, since two groups may not share an ID). The result is proven to reproduce the tree the queue replays to before anything is kept. `patches/` is removed; git is the undo. [source-workflow.md](source-workflow.md) continues from there.
