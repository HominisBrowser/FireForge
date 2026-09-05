<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Patch workflow

The day-to-day loop: change code inside `engine/`, export it, and keep the
queue applying cleanly. `fireforge --help` is the authority on flags. This
file covers the behavior a flag list cannot state.

## The loop

```bash
npx fireforge status
npx fireforge export browser/base/content/browser.js --name custom-toolbar --category ui
npx fireforge re-export custom-toolbar
npx fireforge lint --per-patch
npx fireforge verify
```

## Exporting

Patch names are normalized on export and rename, so `window-chrome-tests`,
`ui-window-chrome-tests`, and `235-ui-window-chrome-tests` all resolve to the
same `<order>-ui-window-chrome-tests.patch` shape.

For large batches of generated assets, `re-export --scan --scan-files
<manifest>` assigns files to their owner patches without scanning whole
directories. The manifest is JSON:

```json
{
  "assignments": [
    { "patch": "002-branding-runtime-icons.patch", "files": ["browser/branding/hominis/icon.svg"] }
  ]
}
```

The command can be dry-run, refuses ambiguous ownership, and reports each
file-to-patch assignment before refreshing the patch.

`re-export` without a scan previews drift. `--refuse-foreign-drift --expect
<path>` restricts it to the files you intended.

### Deletions

A deleted upstream file is captured like any other change: a path tracked in
HEAD but absent from disk stays in the diff scope, and the emitted patch
carries a `deleted file mode` section. A captured deletion keeps its
`filesAffected` entry, because the patch is what performs the deletion, and
pruning the entry would leave the body deleting a file the manifest says the
patch has nothing to do with. It also still requires the confirmation,
because the patch will remove those files wherever it is applied.

An untracked absent path is refused rather than warned about, because a patch
cannot express it either way. The `--files` path also refuses when any
requested path produces no hunk. That is checked against the full requested
list rather than the subset left after filtering, so nothing dropped upstream
can pass as a silent success.

## Queue maintenance

Under `fireforge patch`:

- `patch compact` closes ordinal gaps, and is range-aware when
  `patchPolicy.ranges` is configured.
- `patch reorder` moves a patch.
- `patch split <source> --files <paths...> --name <name>` carves files out of
  a patch into a new one as a single transaction, including staged-dependency
  owner rewrites, and supports `--dry-run`.
- `patch rename` also supports `--category` and `--order`.

Every queue-mutating patch command accepts `--wait-lock [seconds]`. See
[`configuration.md`](configuration.md#lock-waits) for how the budget
resolves.

## Linting the queue

`lint --per-patch --patches` accepts repeated flags, comma lists, full
filenames or stems, bare order numbers, manifest names, category-prefixed
slugs, and bare slugs.

`lint --per-patch --max-warnings 0` is the warning-clean form for a release
gate.

`lint --per-patch --report <path>` writes a machine-readable JSON report with
each patch's line count, tier, active size thresholds, issues, and issues
suppressed by `lintIgnore`. The size metrics (`countNonBinaryDiffLines`,
`resolvePatchSizeTier`, `getPatchSizeThresholds`) are also exported on the
programmatic API.

Per-patch lint type-checks plain Firefox JS against a built-in
Firefox-globals shim that tracks upstream WebIDL additions per release. See
[`configuration.md`](configuration.md#patchlint) for the project hooks
(`checkJsExtraShim`, `checkJsTestFiles`, `checkJsTestShim`).

For release whitespace checks, use `npm run whitespace:check`. It still
checks source diffs while excluding the diff syntax of generated
`patches/*.patch` files.

## CI enforcement

`fireforge status --check` exits non-zero when any unmanaged, drifted, or
conflicted file exists. `--fail-on <class,...>` tunes the policy set, and
`--json` composes with it: the JSON stays parseable and its `files[]` entries
name the owning `patch`. `--include-ownership` adds ownership rows to JSON
status output.

The JSON shapes are specified in [`machine-output.md`](machine-output.md),
and the codes a script should branch on in
[`exit-codes.md`](exit-codes.md).

## Rebasing onto a new Firefox source release

```bash
npx fireforge source set --version 145.0.0esr --product firefox-esr --sha256 <archive-sha256>
npx fireforge download --force
npx fireforge rebase
```

If a patch fails, fix the reject inside `engine/`, then run
`npx fireforge rebase --continue`. A rebase leaves the engine mutated on
purpose, so its apply-and-persist pairs are held across a signal rather than
rolled back. See invariant 4 in
[`lifecycle-invariants.md`](lifecycle-invariants.md).
