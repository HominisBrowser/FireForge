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

### Re-export belts and arguments

`--refuse-adjacent-unmanaged` refuses a patch when an unmanaged file is
adjacent to it, meaning the re-export would plausibly have to capture it:

- a changed file in the same directory as a file the patch owns, or
- a changed file named by a registration line the patch adds (a jar.mn,
  moz.build or test-manifest line, `*` globs included).

A file in a sibling or nested directory is not adjacent, so a peer
session's unexported test in `test/hominis-tiles/` no longer refuses a
patch that owns `test/hominis/browser.toml`. The refusal names every file
with its anchor (`beside engine/<dir>` or `registered by engine/<carrier>`).

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
variable reaches FireForge as a single argument, and splitting it by hand
left every path after the first as a positional patch name.

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
`--expect-removed <path>` on scan-less re-export. This works for an absent
file the patch created, and for an upstream file the patch modified or
deleted whose engine copy is back at HEAD:

```sh
fireforge re-export 202 --refuse-adjacent-unmanaged --refuse-foreign-drift --expect browser/themes/shared/hominis/widgets.css --expect-removed browser/themes/shared/hominis/stop.svg
```

The removal must have exactly one selected owner. A patch-created file must
be absent from disk and engine HEAD, and have a `new file mode` section in
that owner's patch. An upstream file must be tracked in HEAD, match it on
disk, and have a section in that owner's patch. Without the retirement, a
scan-less re-export keeps the path in `filesAffected`, and with the belt
armed it refuses because the file's lines left the body. Every removal is
validated before writes, in dry-run too. Other paths keep
both refusal checks; retirement grants no unmanaged or foreign-drift
exception. Removing every file would empty the patch and requires `patch
delete` (or `patch retire`, which keeps the order number) instead.
`--expect-removed` cannot combine with `--scan`, `--files` or `--all`.

### Forward imports and new modules

A re-export (plain or `--scan`) refused because a file imports a module a
later patch creates names the earliest legal order for exporting those
files as their own patch (free, inside the category range, and not opening
a gap under `allowGaps: false`), and prints the exact `patch
staged-dependency --add` command for each edge, with a `--reason`
placeholder.

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

## Queue maintenance

Under `fireforge patch`:

- `patch compact` closes ordinal gaps, and is range-aware when
  `patchPolicy.ranges` is configured.
- `patch reorder` moves a patch.
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
- `patch staged-dependency <name> --add --from <json-file>` adds many
  declarations in one call under one lock hold. The file is a `lint
--per-patch --report` document (its findings' `stagedDeclarations` for
  that patch) or a JSON array of `{ file, specifier | line, creates, owner?,
reason?, patch? }` entries; entries naming another patch are skipped, and
  `--reason` fills entries without one. Every `staged-dependency` call logs
  only its delta (`added` / `removed`) in the history; records written
  before 0.50.0 carry the whole `before` / `after` lists instead.

Every queue-mutating patch command accepts `--wait-lock [seconds]`. See
[`configuration.md`](configuration.md#lock-waits) for how the budget
resolves.

## Linting the queue

`lint --per-patch --patches` accepts repeated flags, comma lists, full
filenames or stems, bare order numbers, manifest names, category-prefixed
slugs, and bare slugs.

`lint --per-patch --max-warnings 0` is the warning-clean form for a release
gate.

`lint --per-patch --notices summary` prints one line per check in place of
every NOTICE row, for example `NOTICE [large-patch-lines]: 180 across 172
patch(es), 150 of them suppressed by lintIgnore (see --report)`. On a green
queue those rows are reviewed waivers and under-threshold measurements, and
there can be hundreds of them. The default, `--notices full`, prints them
as before. Errors and warnings always print in full, and the `--report`
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
rule.

`lint --per-patch` measures sizes on the working tree, the way export and
re-export do: each patch's diff is taken against the engine baseline from
the files in `engine/`, and `file-too-large` reads the file on disk. A test
file grown past its tier fails the lint gate while the edit is in progress,
without a re-export first. See
[`configuration.md`](configuration.md#patchlint) for the size metrics and
thresholds.

Per-patch lint type-checks plain Firefox JS against a built-in
Firefox-globals shim that tracks upstream WebIDL additions per release. A
`resource://` or `chrome://` import the per-patch program cannot resolve (a
module another patch creates, outside the file's program) is typed `any`;
an implicit-`any` finding in a file with such an import names it, since the
whole-tree `fireforge typecheck` sees the real type. See
[`configuration.md`](configuration.md#patchlint) for the project hooks
(`checkJsExtraShim`, `checkJsTestFiles`, `checkJsTestShim`).

For release whitespace checks, use `npm run whitespace:check`. It still
checks source diffs while excluding the diff syntax of generated
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
`within`, `exceeded` or `removable`. An `--add` for a rule that already has
an entry replaces it, so the same command moves a ceiling or widens it back
to a bare waiver. `export` and `re-export --lint-ignore <id>` only append
bare IDs, and never widen an existing ceiling. The manifest refuses a
ceiling on any other rule, and a second entry for the same rule.

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
them (filename, stem, order number, manifest name or slug). A peer's drifted
patch then no longer turns this session's gate red. The limit is the
point: an unmanaged file belongs to no patch, so a scoped run never judges
unexported files, this session's included. Run the unscoped gate before a
commit that should cover them. `verify --patches` keeps findings about the
queue as a whole (a `patches.json` that does not parse) whatever the scope.

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
last applied to (since 0.50.0). The patch stamps follow on their own line
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
