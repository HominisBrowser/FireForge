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

`re-export --dry-run` takes no engine-session lock: it writes nothing, so it
does not queue behind a peer's build or test run, and its git plumbing runs on
a private index. Its purity guard covers what the dry run could touch (the
selected patches, their `patches.json` rows, the engine files they own, and
the engine HEAD and index). A peer writing any of those during the preview is
named from the history log or the engine-session lock, and the preview is
simply rerun.

To adopt files into several patches in one call, name each file's owner
with `--scan-file <patch>:<path>`. A call with more than one target patch
requires the prefix on every `--scan-file`. Selected patches that get no
file refresh scan-less, without a broad directory scan:

```sh
fireforge re-export 201 200 --scan --scan-file 201:browser/components/hominis/tiles/scroll.mjs --refuse-foreign-drift --expect browser/base/content/hominis.js --expect browser/base/jar.mn
```

### Foreign drift

Every `re-export` previews drift. For each file a patch already owns, it
compares the refreshed body with the old one and lists the lines the engine
file gained or lost since the last export (`+2 added / -1 removed`). Both
directions count, so an edit that only deletes lines is drift too.
`--refuse-foreign-drift` turns the preview into a refusal. `--expect <path>`
admits drift in the files you meant to change. Drift in any other owned
file, added or removed, still refuses.

The belt works beside `--scan`, `--scan-file` and `--scan-files`. It guards
each patch's existing files, and the files a scan adopts count as expected,
so the call that adopts a new file can still refuse a peer's edit in the
patch's other files. It cannot combine with `--files`, which replaces the
file list outright.

The adoption gate and the plain re-export refuse a forward import of a
module a later patch creates. They also refuse a forward registration
(`patchLint.forwardRegistration`, for example a `jar.mn` line packaging that
module), in the same refusal and with the `patch staged-dependency` command
that declares it, so one declaration pass covers both.

### Exporting by hunk

Re-export captures whole files, so on a shared engine a peer's unexported
line in a shared manifest or chrome document lands in the exporting patch.
Two flags export a file by hunk instead. Each takes one explicit patch and
cannot combine with `--scan`, `--files` or `--all`:

- `--hunks-from <diff>` exports each file the diff names as the patch's
  current body for it plus only the diff's hunks. Files the diff does not
  name keep their old section.
- `--exclude-hunks <diff>` exports each named file as the working tree minus
  the diff's hunks. The other files export as usual.

Hunks are placed by their context, so a diff taken before a peer's edit
above it still applies, and a hunk whose context is gone refuses. The
section is diffed by git against HEAD on a throwaway index, and the engine
is not touched. A spine patch can then export one change's lines at a time:

```sh
git -C engine diff -- browser/base/content/hominis.js > my-change.diff   # trim to your hunks
fireforge re-export 200 --hunks-from my-change.diff
```

### Re-export belts and arguments

`--refuse-adjacent-unmanaged` refuses a patch when an unmanaged file is
adjacent to it, meaning the re-export would plausibly have to capture it:

- a changed file in the same directory as a file the patch owns, or
- a changed file named by a registration line the patch adds (a jar.mn,
  moz.build or test-manifest line, `*` globs included).

A file in a sibling or nested directory is not adjacent, so a peer
session's unexported test in `test/hominis-tiles/` does not refuse a
patch that owns `test/hominis/browser.toml`. The refusal names every file
with its anchor (`beside engine/<dir>` or `registered by engine/<carrier>`).

Beside `--scan` and `--scan-file` the belt judges the adjacent files the
scan did not adopt, so one call can adopt a new widget and its test and
still refuse a peer's neighbour. It cannot combine with `--files`.

Three carve-outs keep the belt armed for everything they do not name. Each
requires `--refuse-adjacent-unmanaged`, and each admitted file is still
listed:

- `--expect-new <path>` names a file this session created and will adopt
  with its next export. The owners of a new module's registration can
  re-export first while a peer's neighbour still refuses. The path must be
  changed in engine/ and owned by no patch. The run ends by naming the
  export still owed, and an unmet path is a warning.
- `--expect-unmanaged <path>` records a reviewed exception that stays
  unmanaged. An unmet path is a warning.
- `--adjacent-ignore <path|glob>` is a reviewed ignore list. A `*` stays
  within one path segment and `**` is refused. Unmatched entries are only
  noted, because the same list is reused across runs.

```sh
fireforge re-export 102 200 --refuse-adjacent-unmanaged --refuse-foreign-drift \
  --expect browser/modules/hominis/moz.build --expect-new browser/modules/hominis/HominisBangs.sys.mjs
```

`--expect-from <file>` reads `--expect` paths from a file, one per line,
with blank lines and `#` comments ignored. Under zsh a list held in one
variable reaches FireForge as a single argument, and a file avoids splitting
it by hand.

Arguments are checked before the run queues for the engine lock: an empty
or unknown patch name, a positional that is an engine file (the refusal
points at `--expect` and `--expect-from`), a path flag whose value starts
with `-` (a flag swallowed by a value-less `--expect-unmanaged`), and an
`--expect`, `--expect-unmanaged`, `--expect-new` or `--scan-file` value that
names no changed file in engine/. The banner reads `DRY RUN` or `WRITING`.
A multi-patch run ends with one line naming the patches it wrote and those
it did not, each with its reason (`failed`, `refused: adjacent unmanaged`,
`refused: foreign drift`, `skipped`).

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

A file can be retired from a selected patch with repeatable
`--expect-removed <path>`. This works for an absent
file the patch created, and for an upstream file the patch modified or
deleted whose engine copy is back at HEAD:

```sh
fireforge re-export 202 --refuse-adjacent-unmanaged --refuse-foreign-drift --expect browser/themes/shared/hominis/widgets.css --expect-removed browser/themes/shared/hominis/stop.svg
```

Each removal must have exactly one selected owner, and one call may retire
paths from several selected patches (`re-export 102 202 --expect-removed a
--expect-removed b`). A path whose owner was left out of the selection is
refused with that owner named. A patch-created file must
be absent from disk and engine HEAD, and have a `new file mode` section in
that owner's patch. An upstream file must be tracked in HEAD, match it on
disk, and have a section in that owner's patch. Without the retirement, a
scan-less re-export keeps the path in `filesAffected`, and with the belt
armed it refuses because the file's lines left the body. Every removal is
validated before writes, in dry-run too. Other paths keep
both refusal checks; retirement grants no unmanaged or foreign-drift
exception. Removing every file would empty the patch and requires `patch
delete` (or `patch retire`, which keeps the order number) instead.
`--expect-removed` cannot combine with `--files` or `--all`. It combines
with `--scan`, so one call can retire a widget's files from one patch while
`--scan-file` adopts a new module into another: the retired path leaves the
owner's file list before its scan, which cannot adopt it back.

The same run drops every staged declaration, registration or forward
import, in any patch of the queue, whose `creates` path it retired and no
other patch still owns. It prints each one (`would drop` in a dry run) and
records the drop in the history log (`re-export-staged-prune`).

### Forward imports and new modules

A re-export (plain or `--scan`) refused because a file imports a module a
later patch creates names the earliest legal order for exporting those
files as their own patch (free, inside the category range, and not opening
a gap under `allowGaps: false`), and prints the exact `patch
staged-dependency --add` command for each edge, with a `--reason`
placeholder. A refused `--scan` adoption, `patch move-files` or `patch split`
also writes every declaration it proposes into one lint-report-shaped JSON
(`--declarations-out <path>`, by default under `.fireforge/declarations/`)
and names the single `patch staged-dependency <holder> --add --from <file>`
call per holding patch that discharges them all, so moving tests out of a
patch that owns a shared manifest needs no declaration typed per manifest
line.

For `patch move-files`, `patch split` and a placed `export`:

- The projection of `patch move-files`, `patch split` and a placed `export`
  lints with the queue's whole lint configuration, as the committed `lint
--per-patch` gate does. With `patchLint.forwardRegistration: "extended"`,
  a shared test manifest's suite entries (`["browser_*.js"]`) are projected
  with the move and written to the `--declarations-out` report, not only its
  `support-files` lines. A dry run that reads clean stays clean after the
  move.
- A refused `move-files --create` or `split` report names the patch the
  rerun creates as the `owner` (its planned `<order>-<category>-<name>.patch`).
- The declarations `move-files` and `split` write, and every entry of their
  report, carry a `reason` naming the move, such as
  `"201-ui-tests.patch → 236-ui-suites.patch by patch move-files"`. The
  `--add --from` call the refusal prints then needs no `--reason`; an
  entry's own reason wins over the flag.

A re-export also drops a staged registration whose `creates` path no patch
in the queue owns any more, for example after a merge deleted the file it
registered. The dry run names the drop, and the write records it in the
history log (`re-export-staged-prune`). A registration whose
`creates` file exists in engine/, or is an `--expect-new` path of the run,
is kept and named ("kept: file exists but no patch owns it yet"): the
manifest owner can re-export after the declaration and before the scan
that adopts the file, in either order.

An `export --order` (or `--before`/`--after`) refused on a new system
module that no patch registers in moz.build says "register first". When the
module's moz.build line is already in the working tree but the patch that
owns that moz.build has not exported it, the refusal prints three steps:
declare the line as a staged registration on that patch, re-run the export,
then re-export that patch. With the declaration in place and the line in the
working tree, the export is accepted, with a note to re-export the
registering patch next.

The refusal offers the adopt-then-split sequence (`re-export --scan
--scan-file`, then `patch move-files --create`) only when the new file
shares a block of at least three consecutive substantive lines with an
existing patch, quotes the matched lines, and only when adopting the files
into that patch would itself pass: it names the forward import or the hard
size limit that would refuse the adopt instead. When the only error is the
missing registration, adopt-then-split is not offered at all.

This is the route for pruning a path from a reserved-range allowlist
(`patchPolicy.reservedRanges[].allowed[].files`). Remove the path from the
allowlist, restore its engine copy, and retire it with `--expect-removed`.
The re-export policy gate checks the `filesAffected` the export will write,
and only for the patch being written, so one patch's stale row cannot fail
the other patches in the same call.

### Registering files

`fireforge register <path>` adds a new file's line to the build manifest
that packages or runs it: a jar.mn, a moz.build list, a test manifest. Most
manifests are kept in sorted order, and the entry is inserted
alphabetically. `--after <entry>` places it after the line containing that
substring instead, where the manifest's rule supports it. Elsewhere the
flag is ignored with a warning, and an `--after` that matches nothing falls
back to sorted order with a warning.

An xpcshell test (`test_*.js` outside `browser/base/content/test/`) goes
into its directory's `xpcshell.toml` as a `["test_*.js"]` section, placed
as follows:

- The new section is inserted ahead of the `#` comment lines directly above
  the entry it precedes, never between a comment and the entry it describes.
- `--after <entry>` places the new section after the named entry's whole
  block, with its keys and before the next entry's comment. An exact
  section name matches first, then a substring.

```sh
fireforge register browser/components/hominis/test/unit/test_HominisStoreQuota.js \
  --after test_HominisStore.js
```

`--create-manifest` scaffolds a missing manifest and wires it into the
nearest moz.build instead of refusing with "Manifest not found".

## Queue maintenance

Under `fireforge patch`:

- `patch compact` closes ordinal gaps, and is range-aware when
  `patchPolicy.ranges` is configured.
- `patch reorder` moves a patch. `patch reorder --shift <n>
--from <order> [--through <order>]` (no patch name) renumbers a run of
  patches up by `n` in one transaction, to open room for inserts.
  `--through` defaults to the end of the run of consecutive occupied orders
  of `--from`'s category. Retired and reserved slots inside the run move
  with it (a moved reservation is named, so its holder can be told). A shift
  that would land on an order a patch or slot holds past the run is refused.
  Under `patchPolicy.allowGaps: false` the opened orders are recorded as
  reservations (owner `patch reorder --shift`), so the queue stays valid,
  and the `export --order` or `split --order` that takes each one fills it.
  The shift checks the patch policy, projects the cross-patch lint
  (refusing only on errors the shift adds), and commits under the patch
  lock, refusing if the plan changed while it waited for confirmation.
  `--map-out <file>` on `reorder` (every mode) and on `split` writes the
  committed old-to-new filename map as a JSON object, so references to the
  renumbered patches can be rewritten from the file:

  ```sh
  fireforge patch reorder --shift 4 --from 104 --through 128 --map-out shift-map.json --yes
  ```

- `patch split <source> --files <paths...> --name <name>` carves files out of
  a patch into a new one as a single transaction, including staged-dependency
  owner rewrites, and supports `--dry-run`. `patch move-files <from> <to>
--create --order <n>` does the same with the files named by `--file`.
  Both keep the staged declarations in step with the move and list every
  change: owners (of forward imports and registrations alike) that named
  the source for a moved `creates` path are re-pointed at the new patch, a
  declaration whose declaring file moved goes with it, and a declaration the
  move makes unused is dropped. The patch policy, including the gap rule, is
  checked before any lint runs.
- `patch move-files` covers a whole split in one call:
  - `--scan-file <path>` (repeatable) adopts a new engine file that no patch
    owns into the destination (`<to>`, or the patch `--create` makes) in
    the same transaction. Both bodies are linted as the transaction leaves
    them, so the source is never judged on a body grown by an adoption the
    move would shrink again. An owned or missing path is refused.
  - `--retire-empty` lets a move into an existing patch take every file of
    the source: the declarations whose `owner` is the source re-point to the
    destination, the source's own declarations go with its files (one that
    becomes self-owned is dropped), and the source is retired as by `patch
retire`, its order kept as a retired slot. Without the flag, a move that
    would empty the source is refused and names the flag.
  - A per-patch size refusal on either side names a tier change behind it,
    for example `Tier change: the source becomes test tier (it was general
tier): 9634 lines against 6000.` A source that keeps only test files is
    held to the test tier's ceiling for every line, so move its test files
    out before its last product file.
- `patch rename` also supports `--category` and `--order`.
- `patch retire <name>` removes a patch like `patch delete` (same dependency
  refusal, `--dry-run` and confirmation) but keeps its order number as a
  retired slot in `patches.json#retired`, so `patchPolicy.allowGaps: false`
  sees no gap and no later patch is renumbered. Use it for a patch emptied by
  a rename. The slot has no `.patch` file and no row in `patches`: apply,
  export, lint and rebase never see it, and only the gap check counts it as
  occupied. A patch that later takes the order (`export --order <n>`, a
  rename or a renumber) fills the slot, which then disappears. `patch
compact` renumbers through retired slots like any other gap.
- `patch delete` and `patch retire` name each file the patch creates that is
  still on disk, in the dry run and at the prompt: once the patch is gone
  nothing owns it, so `status` would report it unmanaged. Delete those files
  first, or pass `--delete-created` to remove them as part of the confirmed
  operation (under the engine lock as well). Files the patch only modifies
  keep their edits and become unmanaged.
- `patch reserve <order> --category <c> --owner <label> [--reason <text>]`
  holds an order for a patch a session has agreed to export but has not
  exported yet. The reservation lives in `patches.json#reserved`. Like a
  retired slot, the gap check counts it as occupied, so `export --order 571`
  is legal while a peer holds 569 and 570. Unlike a retired slot, the
  earliest-legal-order search and a default `export` skip it, because it is
  held for its owner. The export that lands on the order fills it, with a
  notice naming the owner. `patch reserve <order> --release` drops a
  reservation whose patch will not come. An order a patch, a retired slot or
  another reservation holds, or one outside the category's range, is
  refused.
- `patch stage <name>...` stages the named patches' `.patch` files and only
  their rows of `patches/patches.json` in the project repository's git index.
  Every other row stays as at HEAD. The staged manifest is built from HEAD's
  rows plus the named working rows (with their retired slots; a reservation
  a staged row fills is dropped), validated, and written with `git
hash-object` and `git update-index`. A collision (two rows at one order) or
  an invalid result is refused before the index is touched. The working copy
  is never changed and nothing is committed. Name a patch the working copy
  no longer has by its HEAD filename to stage its removal, and name both
  filenames of a renamed patch. Every manifest write, a
  re-export's row update included, puts every row, changed or not, in the one
  canonical key order that `patch stage` writes, so after a write the working
  copy and the index do not differ on key order alone.
- `patch staged-dependency <name> --remove` names the entries to remove by
  any of `--file`, `--specifier`/`--line`, `--creates` and `--owner`. It needs
  `--creates`, or `--file` with the matcher. Without `--kind`, `--specifier`
  selects imports, `--line` selects registrations, and a selection with
  neither searches both kinds, so `--creates` alone removes every
  declaration for that created path, imports and registrations alike, which
  is the cleanup after a merge deletes it. Registration lines compare
  whitespace-insensitively, as the lint does. A selection that matches
  nothing is refused with exit 8, on a dry run too, and the refusal lists
  the patch's declarations of every kind it searched.
- `patch staged-dependency <name> --add --from <json-file>` adds many
  declarations in one call under one lock hold. The file is a `lint
--per-patch --report` document (its findings' `stagedDeclarations` for
  that patch) or a JSON array of `{ file, specifier | line, creates, owner?,
reason?, patch? }` entries; entries naming another patch are skipped, and
  `--reason` fills entries without one. Every `staged-dependency` call logs
  only its delta (`added` / `removed`) in the history. A history record may
  carry the whole `before` / `after` lists instead.
- `--add` (single or `--from`) on a declaration already present
  (same file, specifier or line, creates and owner) with a different
  `reason` replaces the reason in place, keeping the entry's position in its
  list. The summary counts these apart from additions, as in
  `updated the reason of 87`, and the history logs each as the old entry
  removed and the new one added. An `--add` without a reason never clears
  one.

### Parking a session's edits

Several sessions edit the same files, and a peer's `re-export
--refuse-foreign-drift` refuses while another session's hunks sit in its
patch's files. `fireforge park <patch>` sets them aside: every drifted file of
the patch goes back to its queue-applied baseline (or, with `--hunks <diff>`,
only the named hunks come out of the working tree), and both sides of each
file are kept under `.fireforge/park/<label>/`. After the owner commits,
`fireforge park --restore <label>` three-way merges the parked edits back on
top of the commit. A conflict leaves markers, keeps the park and exits
non-zero. `park --list` and `park --drop <label>` manage parks, `--dry-run`
previews, and park takes the engine lock.

Before parking it warns when a hunk it takes out removes a Fluent message id,
or a whole file, that files outside the patch still reference. A parked
string still used by markup another patch owns makes `document.l10n.ready`
reject in every new window, so move it somewhere you own first.

Every queue-mutating patch command accepts `--wait-lock [seconds]`. See
[`configuration.md`](configuration.md#lock-waits) for how the budget
resolves.

## Linting the queue

`lint --per-patch --patches` accepts repeated flags, comma lists, full
filenames or stems, bare order numbers, manifest names, category-prefixed
slugs, and bare slugs. A list is also split on whitespace, so
a list held in one shell variable (`--patches "$P"` under zsh) selects every
patch it names. A name that matches no patch is refused with that name, its
nearest matches and the queue size, not with every patch in the queue.

`lint --per-patch --max-warnings 0` is the warning-clean form for a release
gate.

`lint --per-patch --notices summary` prints one line per check in place of
every NOTICE row, for example `NOTICE [large-patch-lines]: 180 across 172
patch(es), 150 of them suppressed by lintIgnore (see --report)`. On a green
queue those rows are reviewed waivers and under-threshold measurements, and
there can be hundreds of them. The default, `--notices full`, prints every
row. Errors and warnings always print in full, and the `--report`
JSON is the same in both modes.

`lint --per-patch --report <path>` writes a machine-readable JSON report with
each patch's line count, the `metric` it was counted in
(`patchLint.patchSizeMetric`: `diff` or `addedCode`), tier, active size
thresholds, issues, and issues suppressed by `lintIgnore`, plus the
cross-patch findings in `queueIssues`. A `forward-import` or
`forward-registration` finding carries the declarations that discharge it as
`stagedDeclarations`, which `patch staged-dependency --from` reads. Size-rule
issues carry the value they measured as `measurement`. The size metrics
(`countNonBinaryDiffLines`, `resolvePatchSizeTier`,
`getPatchSizeThresholds(tier, config)`) are also exported on the
programmatic API, with the file-size helpers `isTestFile`,
`resolveFileSizeThresholds` and `countCodeLines`. So is
`filesMeasuredByFileTooLarge(patchText)`, which returns the files
`file-too-large` measures in a patch: the JS files it creates, and never a
modified file or a new file of another kind. The rule selects its files
through that same function, so an audit that uses it cannot drift from the
rule. The API also exports the measurement the size rules
themselves take, `measurePatchSize(engineDir, diff, filesAffected, config)`
(lines, test-file lines, files and registration files under the configured
metric), `isPatchSizeRegistrationFile(file, globs)`, the per-line
`codeLineMask(file, content)` behind `countCodeLines`, and
`evaluatePatchPolicyContentForQueue(config, projectRoot, patchesDir,
manifest)`, the body-dependent `patchPolicy` rules `verify` runs. A waiver
audit or a policy probe can then measure a patch exactly as the lint does,
without importing `dist/` files by path.

`lint --per-patch` measures sizes on the working tree, the way export and
re-export do: each patch's diff is taken against the engine baseline from
the files in `engine/`, and `file-too-large` reads the file on disk. A test
file grown past its tier fails the lint gate while the edit is in progress,
without a re-export first. See
[`configuration.md`](configuration.md#patchlint) for the size metrics and
thresholds.

Per-patch lint type-checks plain Firefox JS against a built-in
Firefox-globals shim that tracks upstream WebIDL additions per release. A
`resource://` or `chrome://` import resolves to the module the queue
creates under that name; a test script's own program sees the modules
created up to the test's patch. An import the program cannot resolve (a
module a later patch creates, an upstream module, or a basename two
patches create) is typed `any`; an implicit-`any` finding in a file with
such an import names it, since the whole-tree `fireforge typecheck` sees
the real type. See
[`configuration.md`](configuration.md#patchlint) for the project hooks
(`checkJsExtraShim`, `checkJsTestFiles`, `checkJsTestShim`).

For release whitespace checks, use `npm run whitespace:check`. It checks
source diffs while excluding the diff syntax of generated
`patches/*.patch` files.

### Linting single files

`./mach eslint <files>` needs mach's `lint` virtualenv. When that cannot be
built on the host (a pinned requirement missing from PyPI, or a host Python
the requirements do not support), no Mozilla-configured ESLint runs, and a
bare `engine/node_modules/.bin/eslint` lacks the chrome-script globals and
reports mostly noise. FireForge's own checks cover part of the gap:

- `fireforge lint <path>...` lints only the named modified engine files
  (paths relative to `engine/`; a leading `engine/` is accepted, and a
  directory takes its modified and untracked files). It runs the
  patch-quality rules on those files' diff against HEAD, plus the checkJs
  pass when `patchLint.checkJs` is on. It needs no build.
- `fireforge lint --per-patch --patches <patch>` lints one patch's queued
  diff, the gate an export is held to.
- `fireforge typecheck` type-checks the configured jsconfig projects.

None of these applies Mozilla's ESLint rule set, so a file they pass can
still fail `./mach eslint` once the virtualenv builds again.

### Size waivers with a ceiling

A bare `lintIgnore` entry (`"file-too-large"`) suppresses its rule at any
size, so a waived file can keep growing. For the measured size rules
(`file-too-large`, `large-patch-lines`, `large-patch-files`) an entry can
instead carry a ceiling:

```json
"lintIgnore": [
  "modified-file-missing-header",
  { "rule": "file-too-large", "max": 1200, "reason": "Controller split tracked in #412" }
]
```

```sh
fireforge patch lint-ignore 310-ui-sidebar --add file-too-large --max 1200 --reason "Controller split tracked in #412"
```

The finding stays suppressed while its measurement (lines for the line
rules, files for `large-patch-files`) is at or below `max`, and fires at its
own severity past it, with a message naming the ceiling. Once the rule no
longer reaches its own warning band, `lint --per-patch` prints a
`lint-ignore-removable` notice naming the `patch lint-ignore --remove`
command, and the `--report` JSON carries each ceiling under
`lintIgnoreCeilings` with its current `measurement` and a `state` of
`within`, `exceeded` or `removable`. A notice never exceeds a ceiling: it
gates nothing, so a notice-band measurement past `max` surfaces as the plain
notice it is. The report's `lintIgnoreWaivers` lists every entry, bare IDs
included (`kind: "bare"`, `max: null`), with the same `measurement` and
`state`, so an audit does not have to re-measure bare waivers from
`suppressedIssues`. For a bare waiver the state is informational:
`removable` also covers a rule this lint does not run. An `--add` for a rule
that already has an entry replaces it, so the same command moves a ceiling
or widens it back to a bare waiver. `export` and `re-export --lint-ignore
<id>` only append bare IDs, and never widen an existing ceiling. The manifest
refuses a ceiling on any other rule, and a second entry for the same rule.

Under `patchSizeMetric: "addedCode"` a general-tier patch's
`large-patch-lines` findings carry `share: "product"` (non-test files) or
`share: "test"` (test files, held to the test tier). A ceiling can name the
share it bounds, and `large-patch-lines` may then carry one ceiling per
share instead of a single one:

```json
"lintIgnore": [
  { "rule": "large-patch-lines", "share": "product", "max": 900, "reason": "…" },
  { "rule": "large-patch-lines", "share": "test", "max": 4000, "reason": "…",
    "meta": { "kind": "structural", "owner": "tiles" } }
]
```

A ceiling's optional `meta` is a free-form JSON object FireForge keeps
verbatim and never reads, for a project's own waiver bookkeeping (kind,
owner, exit condition). The report echoes it.

Several ceilings go in one call, under one lock hold and one manifest write:
`--add <rule>=<max>` gives each entry its own ceiling (`--reason` applies to
all of them, `--share` scopes a `large-patch-lines` one), and `--from
<json-file>` adds every entry of a JSON array (check IDs, or `{ rule, max,
reason?, share?, meta?, patch? }` objects; entries naming another patch are
skipped, and `--reason` fills objects without one). Given a `lint --per-patch
--report` document instead, `--from` rebaselines each of the patch's
ceilings to its current `measurement`.

```sh
fireforge patch lint-ignore 310-ui-sidebar --add file-too-large=1200 --add large-patch-files=40 --reason "Rebaseline 2026-10"
fireforge patch lint-ignore 310-ui-sidebar --from lint-report.json
```

## CI enforcement

`fireforge status --check` exits non-zero when any unmanaged, drifted, or
conflicted file exists. `--fail-on <class,...>` tunes the policy set, and
`--json` composes with it: the JSON stays parseable and its `files[]` entries
name the owning `patch`. `--include-ownership` adds ownership rows to JSON
status output.

`ownership-conflict` is a `--fail-on` class beside the file classifications:
a path claimed by more than one patch, judged from the same rows as
`--include-ownership` (so it fails on a clean tree too). It is not in the
default set. `--allow <class,...>` names classes that never fail and removes
them from the fail set. `--fail-on-unknown` (which needs `--allow`) fails
every class present that neither list names, so a gate written today keeps
failing closed when a later FireForge adds a classification:

```bash
npx fireforge status --json --summary \
  --fail-on unmanaged,patch-owned-drift,conflict,ownership-conflict \
  --allow patch-backed,branding,furnace,binary-unsupported --fail-on-unknown
```

The JSON `check` block echoes `allow` and `failOnUnknown` when they are set,
and marks an offender that failed only through `--fail-on-unknown` with
`"unnamed": true`. Under `--check` the full `--json` payload carries the
`check` block too, not only `--summary`.

On a shared engine, `--patches <list>` judges only the named patches:
`status` keeps the files each one owns or claims (and, with `--ownership` or
the ownership checks, the rows naming it), and `verify` keeps the findings
that name it. Patches are named the way `lint --per-patch --patches` names
them (filename, stem, order number, manifest name or slug; repeated, or
separated by commas or whitespace). A peer's drifted
patch then does not turn this session's gate red. The limit is the
point: an unmanaged file belongs to no patch, so a scoped run never judges
unexported files, this session's included. Run the unscoped gate before a
commit that should cover them. `lint --per-patch --patches` keeps every
queue finding that names a scoped patch, even on a file the patch no longer
touches (a stale `staged-dependency-unused` declaration). `verify --patches` keeps findings about the
queue as a whole (a `patches.json` that does not parse) whatever the scope.

`verify` resolves every `resource:///modules/…` and `resource://gre/modules/…`
`.sys.mjs` specifier the queue's files import, and fails on a fork module that
is missing or that no `moz.build` at or above its directory registers. Such
an import otherwise crashes every browser start of the objdir, or kills
xpcshell with no output. An unscoped run also scans the engine worktree:
changed files are read for imports, and untracked files count as fork
modules. That covers a chrome script's lazy getter for a module that neither
file has exported yet.

`fireforge check` composes the static gates into one command: `status`
(as `--json --summary --check`), `verify`, `lint --per-patch`,
`typecheck`, `furnace validate` and `token coverage`, plus the project's
`check.extraSteps[]` (see [`configuration.md`](configuration.md#check)). The
steps run in parallel as child `fireforge` processes, so each behaves exactly
as it does standalone and takes only its own locks; `check` takes none
itself. None of the built-in steps takes the engine session lock. The one
built-in step that writes, `typecheck` (it regenerates a stale Furnace
jsconfig), runs before `furnace validate`, which reads that file. `--patches`
is forwarded to status, verify and lint. `--only` and `--skip` narrow the
step list, and `--jobs <n>` caps how many run at once. The run ends with a
per-step table and one verdict line:

```
FIREFORGE-VERDICT: PASS steps=<n> skipped=<n>
FIREFORGE-VERDICT: FAIL reason=step-failures|lock-timeout failed=<step,...> steps=<n> skipped=<n>
```

`--json` replaces both with one document. A failed step's last 40 output
lines are printed under the table.

The JSON shapes are specified in [`machine-output.md`](machine-output.md),
and the codes a script should branch on in
[`exit-codes.md`](exit-codes.md).

## Rebasing onto a new Firefox source release

```bash
npx fireforge source set --version 145.0.0esr --product firefox-esr --sha256 <archive-sha256>
npx fireforge download --force
npx fireforge rebase
```

`download --force` is the destructive step of the three, not `rebase`. It
replaces `engine/` wholesale, so applied patches, unexported edits and
commits made in `engine/` are gone once the new tree is active. When the
engine it is about to replace has changed paths against HEAD, or HEAD has
moved off the recorded base commit, it names the loss (how many changed
paths match the patch queue and how many do not) and asks first. A
non-interactive run refuses unless `--yes` is given. A clean engine is
replaced without a prompt.

`npx fireforge rebase --dry-run` replays the queue onto the engine's HEAD
without touching `engine/`. It seeds a private index from HEAD and applies
each patch there with `git apply --cached`, in queue order, walking the same
context-reduction ladder as the real run (exact, then `-C2`, `-C1`, `-C0`,
bounded by `--max-fuzz`). Each patch is reported as `clean`, `reduced
context` (with the step it needed) or `reject` (with the files git named).
It exits 6 when anything rejects. A reject after an earlier one is marked
as possibly cascading from it, since the replay continues without the
rejected patch. Run it after the download, when HEAD is the new source. The
header names the previous pin as "from": `firefox.version` in the
`fireforge.json` committed at the project's HEAD, the tree the queue was
last applied to. The patch stamps follow on their own line
(`Patch stamps: 317 at 153.0esr, 5 at 153.3.0esr`), oldest first and
compared as versions rather than strings, because patches untouched since an
older hop keep their older stamp. When no committed pin precedes the target
(the project is not a repository, or the pin move is already committed), the
header falls back to the oldest stamp and says so. The header also warns
when `engine/` is not yet on the pinned version.

A source refresh replaces `engine/node_modules`, which an engine-ESLint
ratchet runs from. `fireforge doctor` warns ("Engine ESLint installed") until
it is back. Reinstall it with `cd engine && ./mach npm ci --no-audit
--no-fund`, which installs only the node dependencies. `./mach eslint
--setup` also builds mach's Python `lint` virtualenv, and that step fails
whenever a requirement it pins is no longer served by PyPI.

If a patch fails, fix the reject inside `engine/`, then run
`npx fireforge rebase --continue`. A rebase leaves the engine mutated on
purpose, so its apply-and-persist pairs are held across a signal rather than
rolled back. See invariant 4 in
[`lifecycle-invariants.md`](lifecycle-invariants.md).
