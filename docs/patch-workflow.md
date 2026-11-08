<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Patch workflow

The day-to-day loop: change code inside `engine/`, export it, and keep the
queue applying cleanly. `fireforge <command> --help` is the authority on
flags; this file covers behavior a flag list cannot state.

## The loop

```bash
npx fireforge status
npx fireforge export browser/base/content/browser.js --name custom-toolbar --category ui
npx fireforge re-export custom-toolbar
npx fireforge lint --per-patch
npx fireforge verify
```

Patch names are normalized on export and rename: `window-chrome-tests`,
`ui-window-chrome-tests` and `235-ui-window-chrome-tests` all resolve to the
same `<order>-ui-window-chrome-tests.patch` shape.

### Sharing an engine

Every command that rewrites `engine/` (`import`, `resolve`, `reset`,
`discard`, `export`, `export-all`, `re-export`, `park`, `rebase`) holds the
engine lock for its run. A peer's build or test holds it too, and without a
budget a writing command gives up after about a second. Pass
`--wait-lock <seconds>` (`re-export custom-toolbar --wait-lock 600`) or set
`FIREFORGE_WAIT_LOCK` for the session. A `--dry-run` of a command that
writes nothing holds the lock shared, so previews overlap each other but not
a build. See [Lock waits](configuration.md#lock-waits).

## Re-exporting

`re-export` refreshes a patch from the working tree. Each argument is checked
before the run queues for the lock: an unknown patch name, a positional that
is an engine file, a path flag whose value starts with `-`, and any
`--expect`, `--expect-unmanaged`, `--expect-new` or `--scan-file` value that
names no changed file in `engine/`. A multi-patch run ends with one line
naming the patches it wrote and those it did not, each with its reason
(`failed`, `refused: adjacent unmanaged`, `refused: foreign drift`,
`skipped`).

### Adopting new files

`--scan` finds new and removed files under the directories a patch owns.
To adopt files into specific patches, name each owner with
`--scan-file <patch>:<path>` (the prefix is required when more than one patch
is selected). Selected patches that get no file refresh without a scan.

```sh
fireforge re-export 201 200 --scan --scan-file 201:browser/components/tiles/scroll.mjs \
  --refuse-foreign-drift --expect browser/base/content/browser.js --wait-lock 600
```

For large batches of generated assets, `--scan-files <manifest>` assigns files
to owners without scanning directories:

```json
{
  "assignments": [
    { "patch": "002-branding-icons.patch", "files": ["browser/branding/app/icon.svg"] }
  ]
}
```

It refuses ambiguous ownership and reports each assignment first. Positional
patches may accompany the manifest (only `--all` is refused); each patch is
refreshed once, in queue order.

### Foreign drift

Every `re-export` previews drift: for each file a patch already owns, the
lines the engine file gained or lost since the last export (`+2 added / -1
removed`). `--refuse-foreign-drift` turns the preview into a refusal;
`--expect <path>` (or `--expect-from <file>`, one path per line, `#`
comments allowed) admits drift in the files you meant to change. Drift in any
other owned file still refuses. Files a scan adopts count as expected. The
flag cannot combine with `--files`.

With the flag, every selected patch is judged before any is written: if one
is refused, none is written, and the summary names the patches held back.

### Adjacent files

`--refuse-adjacent-unmanaged` refuses a patch when an unmanaged changed file
is adjacent to it, meaning the re-export would plausibly have to capture it:
a changed file in the same directory as a file the patch owns, or one named
by a registration line the patch adds (a `jar.mn`, `moz.build` or test
manifest line, globs included). Sibling and nested directories are not
adjacent. The refusal names each file and why. A backup-shaped file (`*-E`,
`*.bak`, `*.orig`, `*.rej`, `*~`) is named as a stray to delete. The flag
cannot combine with `--files`.

Three carve-outs keep the belt armed for everything they do not name; each
requires the flag, and each admitted file is still listed:

- `--expect-new <path>`: a file this session created and will adopt with its
  next export. The path must be changed and owned by no patch; the run ends
  by naming the export still owed.
- `--expect-unmanaged <path>`: a reviewed exception that stays unmanaged.
- `--adjacent-ignore <path|glob>` (or `--adjacent-ignore-from <file>`): a
  reviewed ignore list. `*` stays within one path segment; `**` is refused.

```sh
fireforge re-export 102 200 --refuse-adjacent-unmanaged --refuse-foreign-drift \
  --expect browser/modules/app/moz.build --expect-new browser/modules/app/Widget.sys.mjs \
  --wait-lock 600
```

### Exporting by hunk

Re-export captures whole files, so on a shared engine a peer's unexported
line in a shared manifest lands in your patch. Two flags export by hunk
instead. Each takes one explicit patch and cannot combine with `--scan`,
`--files` or `--all`:

- `--hunks-from <diff>`: each file the diff names is exported as the patch's
  current body for it plus only the diff's hunks; other files keep their old
  section.
- `--exclude-hunks <diff>`: each named file is exported as the working tree
  minus the diff's hunks.

Hunks are placed by their context, so a diff taken before a peer's edit above
it still applies; a hunk whose context is gone refuses. The diff may be `git
diff` output or plain `diff -u`. The engine is not touched, and the selected
text is linted in a private view, with cache keys bound to the proposed diff.

```sh
git -C engine diff -- browser/base/content/browser.js > my-change.diff   # trim to your hunks
fireforge re-export 200 --hunks-from my-change.diff --wait-lock 600
```

A file the patch creates is untracked, so `git diff` prints nothing for it.
`fireforge patch body <patch> <file>` prints the file as the patch leaves it,
which is the base hunks are placed against:

```sh
diff -u <(fireforge patch body 200 browser/components/tiles/tiles.mjs) \
  engine/browser/components/tiles/tiles.mjs > my-change.diff
```

A section from `/dev/null` for a file the patch already creates is refused:
its one hunk is the whole file, not what changed since the patch body.

### Deletions

A deleted upstream file is captured like any other change: the patch carries
a `deleted file mode` section, keeps the file in `filesAffected`, and the
export asks for confirmation. An untracked absent path is refused, since a
patch cannot express it. `--files` refuses when any requested path produces
no hunk.

`--expect-removed <path>` (repeatable) retires a file from a selected patch.
It works for an absent file the patch created and for an upstream file the
patch modified whose engine copy is back at HEAD:

```sh
fireforge re-export 202 --refuse-adjacent-unmanaged --refuse-foreign-drift \
  --expect browser/themes/shared/widgets.css --expect-removed browser/themes/shared/stop.svg
```

Each removal must have exactly one selected owner; one call may retire paths
from several selected patches. A path whose owner is not selected is refused
with that owner named. Everything is validated before any write, in dry-run
too. Retirement grants no drift or adjacency exception. Removing every file
would empty the patch: use `patch delete` or `patch retire`. It cannot
combine with `--files` or `--all`, and combines with `--scan`. The run also
drops every staged declaration in the queue whose `creates` path it retired
and no patch still owns, printing each (`would drop` in a dry run).

The same route prunes a path from a reserved-range allowlist
(`patchPolicy.reservedRanges[].allowed[].files`): remove the path from the
allowlist, restore its engine copy, and retire it.

### Forward imports and registrations

A re-export (plain or `--scan`) refuses when a file imports a module that a
later patch creates, or registers one (`patchLint.forwardRegistration`, for
example a `jar.mn` line packaging it). The refusal names the earliest legal
order for exporting those files as their own patch and prints the `patch
staged-dependency --add` command for each edge, so one declaration pass
covers both. A refused `--scan` adoption, `patch move-files` or `patch
split` also writes every declaration it proposes to one JSON report
(`--declarations-out <path>`, default under `.fireforge/declarations/`) and
names the single `patch staged-dependency <holder> --add --from <file>` call
per holding patch that discharges them all. Declarations written by
`move-files` and `split` carry a `reason` naming the move.

`patch move-files`, `patch split` and a placed `export` lint their projection
with the queue's whole lint configuration, so a dry run that reads clean
stays clean after the move.

An `export --order` (or `--before`/`--after`) of a new system module that no
patch registers in `moz.build` says "register first". When the line is in the
working tree but the owning patch has not exported it, the refusal prints
three steps: declare the line as a staged registration on that patch,
re-run the export, then re-export that patch.

A re-export also drops a staged registration whose `creates` path no patch
owns any more, recording it in the history log (`re-export-staged-prune`). A
registration whose `creates` file still exists in `engine/`, or is an
`--expect-new` path, is kept.

## Registering files

`fireforge register <path>` adds a new file's line to the manifest that
packages or runs it: a `jar.mn`, a `moz.build` list or a test manifest.
Entries are inserted alphabetically; `--after <entry>` places the entry after
the line containing that substring where the manifest's rule supports it
(elsewhere it warns and is ignored, and a match-less `--after` falls back to
sorted order with a warning).

An xpcshell test (`test_*.js` outside `browser/base/content/test/`) goes into
its directory's `xpcshell.toml` as a `["test_*.js"]` section, ahead of the
`#` comments directly above the entry it precedes. `--after` places it after
the named entry's whole block; an exact section name matches before a
substring.

```sh
fireforge register browser/components/app/test/unit/test_StoreQuota.js --after test_Store.js
```

`--create-manifest` scaffolds a missing manifest and wires it into the
nearest `moz.build` instead of refusing.

## Queue maintenance

Under `fireforge patch`:

- `compact` closes ordinal gaps, range-aware when `patchPolicy.ranges` is
  configured.
- `reorder <name>` moves a patch. `reorder --shift <n> --from <order>
[--through <order>]` renumbers a run of patches up by `n` in one
  transaction, to open room for inserts. `--through` defaults to the end of
  the run of consecutive occupied orders in `--from`'s category. Retired and
  reserved slots in the run move with it. A shift that lands on an occupied
  order past the run is refused. Under `patchPolicy.allowGaps: false` the
  opened orders are recorded as reservations, which the `export --order` or
  `split --order` that takes each one fills. `--map-out <file>` (on `reorder`
  and `split`) writes the committed old-to-new filename map as JSON.
- `split <source> --files <paths...> --name <name>` carves files out of a
  patch into a new one in a single transaction. `move-files <from> <to>`
  moves files into an existing patch, or with `--create --order <n>` into a
  new one (files named with `--file`). All three support `--dry-run` and
  list every change: staged-dependency owners that named the source for a
  moved path are re-pointed, a declaration whose declaring file moved goes
  with it, and one the move makes unused is dropped. The patch policy
  (including the gap rule) is checked before any lint runs.
- `move-files` also takes `--scan-file <path>` (adopt a new unowned engine
  file into the destination in the same transaction; both bodies are linted
  as the transaction leaves them) and `--retire-empty` (let a move into an
  existing patch take every file of the source, re-point its declarations,
  and retire the source). Without the flag a move that would empty the source
  is refused. A per-patch size refusal names a tier change behind it: a
  patch that keeps only test files is held to the test tier, so move its test
  files out before its last product file.
- `rename` also supports `--category` and `--order`.
- `retire <name>` removes a patch like `delete` (same dependency refusal,
  `--dry-run` and confirmation) but keeps its order as a retired slot in
  `patches.json#retired`, so `allowGaps: false` sees no gap and no later
  patch is renumbered. The slot has no `.patch` file; apply, export, lint and
  rebase ignore it. A patch later taking that order fills it. `compact`
  renumbers through retired slots.
- `delete` and `retire` name each created file still on disk, since nothing
  will own it afterwards. Delete those files first, or pass
  `--delete-created` to remove them under the engine lock. Files the patch
  only modified keep their edits and become unmanaged.
- `reserve <order> --category <c> --owner <label> [--reason <text>]` holds an
  order for a patch a session has agreed to export. Gap checks count it as
  occupied, so `export --order 571` is legal while a peer holds 569 and 570;
  the earliest-order search and a default `export` skip it. The export that
  lands on it fills it. `reserve <order> --release` drops it.
- `stage <name>...` stages the named patches' `.patch` files and only their
  rows of `patches/patches.json` in the project repository's index; other
  rows stay as at HEAD. A collision or invalid result is refused before the
  index is touched, and the working copy is never changed. Name a removed or
  renamed patch by its HEAD filename to stage the removal. Every manifest
  write uses one canonical key order, so working copy and index never differ
  on order alone.
- `staged-dependency <name>` edits declarations. `--add --kind
registration` warns when `--line` matches no line the patch adds to
  `--file` (whitespace runs compare collapsed); the declaration is still
  written, and lint reports `staged-dependency-unused` until the line
  exists. `--add --from <json-file>` adds many in one call: a `lint
--per-patch --report` document or a JSON array of `{ file, specifier |
line, creates, owner?, reason?, patch? }`; entries naming another patch are
  skipped. Re-adding a present declaration with a different `reason`
  replaces the reason in place; an `--add` without a reason never clears one.
  `--remove` selects by `--file`, `--specifier`/`--line`, `--creates` and
  `--owner` and needs `--creates`, or `--file` with a matcher; `--creates`
  alone removes every declaration for that path (the cleanup after a merge
  deletes it). A selection that matches nothing is refused with exit 8, on a
  dry run too, listing the patch's declarations.

### Discarding and resetting

`fireforge discard <paths...>` restores files, or every changed file beneath
a directory, from one status scan: patch-claimed paths go back to their
patch-applied baseline, unmanaged untracked files are deleted, and
`--to-upstream` restores pristine upstream instead. A path that selects
nothing refuses the whole call before anything is touched.

`discard`, `reset`, `rebase` and `rebase --abort` first save a recovery
snapshot of the work tree (tracked edits and untracked files, not ignored
ones) under `refs/fireforge/recovery/<timestamp>-<command>`, using a private
index so your index and branches are untouched. The newest 20 are kept. Get a
file back with `git -C engine checkout refs/fireforge/recovery/<name> --
<path>`. A snapshot that cannot be taken is a warning, and the command still
runs.

### Parking a session's edits

When several sessions edit the same files, a peer's `re-export
--refuse-foreign-drift` refuses while your hunks sit in its patch's files.
`fireforge park <patch>` sets them aside: each drifted file goes back to its
queue-applied baseline (with `--hunks <diff>`, only the named hunks come
out), and both sides are kept under `.fireforge/park/<label>/`. After the
owner commits, `park --restore <label>` three-way merges the parked edits
back; a conflict leaves markers, keeps the park and exits non-zero. `--list`,
`--drop <label>` and `--dry-run` manage and preview; park takes the engine
lock.

Park warns when a hunk it takes out removes a Fluent message id, or a whole
file, that files outside the patch still reference: a parked string still
used by another patch's markup makes `document.l10n.ready` reject in every
new window.

## Linting the queue

`lint --per-patch --patches` accepts repeated flags, comma or whitespace
lists, full filenames or stems, order numbers, manifest names and slugs. A
name matching no patch is refused with that name and its nearest matches.
`--max-warnings 0` is the warning-clean form for a release gate.

A per-patch run that lints no patch (none of the queue's files are in
`engine/`) fails and names the skipped patches; run `fireforge import`
first. In an authored-source project, `lint` refuses `--per-patch`,
`--report` and `--notices`.

`--notices summary` prints one line per check in place of every NOTICE row;
the default `--notices full` prints them all. Errors and warnings always
print in full, and the report is identical in both modes.

`--report <path>` writes JSON with each patch's line count, its `metric`
(`patchLint.patchSizeMetric`: `diff` or `addedCode`), tier, active
thresholds, issues, issues suppressed by `lintIgnore`, and cross-patch
findings in `queueIssues`. A forward-import or forward-registration finding
carries the declarations that discharge it as `stagedDeclarations`, which
`patch staged-dependency --from` reads. Size findings carry `measurement`.

Sizes are measured on the working tree, the way export does: a test file
grown past its tier fails lint while the edit is in progress. Size metrics
and thresholds are in [`configuration.md`](configuration.md#patchlint). The
size and measurement helpers (`countNonBinaryDiffLines`,
`resolvePatchSizeTier`, `getPatchSizeThresholds`, `measurePatchSize`,
`filesMeasuredByFileTooLarge`, `evaluatePatchPolicyContentForQueue` and
others) are part of the programmatic API.

Per-patch lint type-checks Firefox JS against a built-in globals shim. A
`resource://` or `chrome://` import resolves to the module the queue creates
under that name; a test script's program sees modules created up to the
test's patch. An import it cannot resolve (a later patch's module, an
upstream module, or a basename two patches create) is typed `any`, and an
implicit-`any` finding in such a file names it, since whole-tree `fireforge
typecheck` sees the real type. `fireforge typecheck --explain <file>` shows
which project checks a file and how its imports resolve; `typecheck
--project <path>` runs one project. Project hooks (`checkJsExtraShim`,
`checkJsTestFiles`, `checkJsTestShim`) are in
[`configuration.md`](configuration.md#patchlint).

The per-patch lint result cache is keyed by the tools' identity. When that
identity cannot be computed (for example a broken link in `node_modules`),
lint warns once, skips the cache and still runs. `--no-cache` bypasses cache
reads and writes; `lint cache` manages it.

### License headers

A file a patch creates must open with the project's license header
(`missing-license-header`, error); a JS or CSS file may keep upstream's
MPL-2.0 block header instead. A file a patch modifies must carry a
recognized header in its first ten lines (`modified-file-missing-header`,
warning): a known license header, an SPDX tag, a common license name, or the
CC0 dedication on Mozilla's tests. The MPL header matches whatever its wrap.
Some upstream files have no header at all; a patch modifying one takes a
reviewed `lintIgnore` entry:

```sh
fireforge patch lint-ignore 310-ui-sidebar --add modified-file-missing-header --yes
```

`patch lint-ignore` asks for confirmation, so a script needs `--yes`.

### Linting single files

`./mach eslint` needs mach's `lint` virtualenv, which some hosts cannot
build. FireForge's own checks cover part of the gap, none of them applying
Mozilla's ESLint rules:

- `fireforge lint <path>...` lints only the named modified engine files
  (paths relative to `engine/`; a directory takes its modified and untracked
  files): patch-quality rules on their diff against HEAD, plus checkJs when
  `patchLint.checkJs` is on. No build needed.
- `fireforge lint --per-patch --patches <patch>` lints one patch's queued
  diff, the gate an export is held to.
- `fireforge typecheck` checks the configured jsconfig projects.

### Size waivers with a ceiling

A bare `lintIgnore` entry (`"file-too-large"`) suppresses its rule at any
size. For the measured size rules (`file-too-large`, `large-patch-lines`,
`large-patch-files`) an entry can carry a ceiling instead:

```json
"lintIgnore": [
  { "rule": "file-too-large", "max": 1200, "reason": "Controller split tracked in #412" }
]
```

```sh
fireforge patch lint-ignore 310-ui-sidebar --add file-too-large --max 1200 --reason "Controller split tracked in #412" --yes
fireforge patch lint-ignore 310-ui-sidebar --add file-too-large=1200 --add large-patch-files=40 --yes
fireforge patch lint-ignore 310-ui-sidebar --from lint-report.json --yes
```

The finding stays suppressed while its measurement is at or below `max` and
fires at its own severity past it. Once the rule no longer reaches its
warning band, lint prints a `lint-ignore-removable` notice. The report lists
each entry (bare ones too) under `lintIgnoreWaivers`, and ceilings under
`lintIgnoreCeilings`, with `measurement` and a `state` of `within`,
`exceeded` or `removable`. An `--add` for a rule that already has an entry
replaces it. `--from` takes a JSON array (check ids or `{ rule, max, reason?,
share?, meta?, patch? }`) or a lint report, which rebaselines each of the
patch's ceilings to its current measurement. `export` and `re-export
--lint-ignore <id>` only append bare ids. Under `patchSizeMetric:
"addedCode"`, `large-patch-lines` ceilings may name a `share` (`product` or
`test`), and `meta` is a free-form object kept verbatim for your own
bookkeeping.

## CI enforcement

`fireforge status --check` exits non-zero when any unmanaged, drifted or
conflicted file exists. `--fail-on <class,...>` replaces the failing set;
`--allow <class,...>` names classes that never fail; `--fail-on-unknown`
(needs `--allow`) fails every present class neither list names, so a gate
keeps failing closed when a later FireForge adds a classification.
`ownership-conflict` (a path claimed by more than one patch) is a `--fail-on`
class that is not in the default set. `--json` composes with all of these,
its `files[]` entries name the owning `patch`, and `--include-ownership`
adds ownership rows:

```bash
npx fireforge status --json --summary \
  --fail-on unmanaged,patch-owned-drift,conflict,ownership-conflict \
  --allow patch-backed,branding,furnace,binary-unsupported --fail-on-unknown
```

The JSON `check` block echoes `allow` and `failOnUnknown` when set and marks
an offender that failed only through `--fail-on-unknown` with `"unnamed":
true`.

On a shared engine, `--patches <list>` judges only the named patches (named
as in `lint --per-patch --patches`), so a peer's drifted patch does not turn
your gate red. An unmanaged file belongs to no patch, so a scoped run never
judges unexported files, yours included: run the unscoped gate before a
commit that should cover them. `verify --patches` still reports findings
about the queue as a whole.

`verify` resolves every `resource:///modules/…` and
`resource://gre/modules/…` `.sys.mjs` specifier the queue's files import and
fails on a fork module that is missing or that no `moz.build` at or above its
directory registers; otherwise such an import crashes every browser start.
An unscoped run also reads changed and untracked engine files, so a lazy
getter for a module neither file has exported yet is caught.

`fireforge check` composes the static gates into one command: `status`
(as `--json --summary --check`), `verify`, `lint --per-patch`, `typecheck`,
`furnace validate` and `token coverage`, plus the project's
`check.extraSteps[]` (see [`configuration.md`](configuration.md#check)). The
steps run in parallel as child `fireforge` processes, each taking only its
own locks; `check` takes none, and none of the built-in steps takes the
engine session lock. `typecheck`, which may regenerate a stale Furnace
jsconfig, runs before `furnace validate`. `--patches` is forwarded to status,
verify and lint; `--only` and `--skip` narrow the steps; `--jobs <n>` caps
parallelism. The run ends with a per-step table and one verdict line:

```
FIREFORGE-VERDICT: PASS steps=<n> skipped=<n>
FIREFORGE-VERDICT: FAIL reason=step-failures|lock-timeout failed=<step,...> steps=<n> skipped=<n>
```

`--json` replaces both with one document. A failed step's last 40 output
lines print under the table. JSON shapes are in
[`machine-output.md`](machine-output.md) and exit codes in
[`exit-codes.md`](exit-codes.md). When the same checks must run in a
coordinated slot, use `fireforge job run --check`
([`jobs-and-slots.md`](jobs-and-slots.md)).

## Rebasing onto a new Firefox release

```bash
npx fireforge source set --version 145.0.0esr --product firefox-esr --sha256 <archive-sha256>
npx fireforge download --force
npx fireforge rebase
```

`download --force` is the destructive step, not `rebase`: it replaces
`engine/` wholesale, so applied patches, unexported edits and commits made in
`engine/` are gone. When the engine has changed paths against HEAD, or HEAD
has moved off the recorded base commit, it says how many changed paths match
the queue and how many do not, and asks first; a non-interactive run refuses
without `--yes`. A clean engine is replaced without a prompt. The first
build after a `download --force` treats the old build record as absent and
builds in full.

`rebase --dry-run` replays the queue onto the engine's HEAD without touching
`engine/`: each patch is applied on a private index in queue order through
the same context-reduction ladder as the real run (exact, then `-C2`, `-C1`,
`-C0`, bounded by `--max-fuzz`) and reported as `clean`, `reduced context`
(with the step) or `reject` (with the files git named). A reject after an
earlier one is marked as possibly cascading. It exits 6 when anything
rejects. Run it after the download. The header gives the previous pin as
"from" (`firefox.version` in the `fireforge.json` committed at HEAD), the
patch stamps oldest first, and a warning when `engine/` is not yet on the
pinned version.

A source refresh replaces `engine/node_modules`, which an engine-ESLint
ratchet runs from; `fireforge doctor` warns ("Engine ESLint installed") until
it is back. Reinstall it with `cd engine && ./mach npm ci --no-audit
--no-fund`. (`./mach eslint --setup` also builds mach's Python `lint`
virtualenv, which fails whenever a pinned requirement is no longer on PyPI.)

If a patch fails, fix the reject inside `engine/`, then run `fireforge
rebase --continue`. `resolve` and `rebase --continue` rewrite the patch from
the cumulative diff of its files, so a file another patch also lists would
pull that patch's hunks into the body: `resolve` refuses such a patch and
`rebase --continue` marks it resolved without rewriting it. Re-export it with
`fireforge re-export <patch> --hunks-from <diff>` in both cases. A rebase
leaves the engine mutated on purpose; `rebase --abort` restores it from the
pre-rebase snapshot.
