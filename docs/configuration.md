<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Configuration

`fireforge.json` at the project root holds the project's configuration, and
`furnace.json` holds component configuration. This file covers the settings
whose behavior needs more than a schema line, plus the environment variables
FireForge reads.

## `firefox`, the source pin

`firefox.version`, together with `firefox.product` and optionally
`firefox.sha256` and `firefox.candidate`, is the source pin that
`fireforge download` resolves an archive from. `fireforge source set` writes
it.

The pin lives in `fireforge.json` next to hand-maintained policy sections,
which is worth knowing when you revert that file. Running
`git checkout -- fireforge.json` after an accidental reformat also reverts an
uncommitted pin, and the tree is then building a different version than the
config claims.

`fireforge source set`, `fireforge config <key> <value>` and `furnace init`
edit `fireforge.json` in place (since 0.50.0). Only the values that change
are rewritten. Indentation, key order, and objects or arrays kept on one
line stay as they are, so a pin move is a diff of the `firefox` block alone.
New keys follow the layout of the object they land in. Before 0.50.0 every
write re-serialized the whole file and expanded every compact section.

`fireforge doctor`'s "Source pin matches engine" check compares the pin with
the engine's committed `browser/config/version.txt`. That file never carries
the `esr` suffix, so a trailing `esr` is dropped from the pin for this
comparison (a `153.4.0esr` pin matches `153.4.0`). The comparison with the
version the last download recorded keeps the full pin.

### Archive integrity: `firefox.sha256` and `firefox.allowUnverifiedDownload`

Every fresh download is checked against Mozilla's published `SHA256SUMS` for
the release. A mismatch fails the download and discards the archive. The
check also fails closed when the published digest cannot be obtained at all:
a 404, a captive portal answering with an HTML page, a dropped connection, or
a timeout. TLS alone is thin trust for the artifact that becomes the git
baseline every patch is built on, and "the checksum host was unreachable" is
exactly the condition someone positioned on the network can arrange.

- `firefox.sha256` pins the digest. It takes precedence over the published
  file and is the right answer for reproducible builds and offline mirrors:
  obtain it out of band, and the download verifies with no network beyond the
  archive itself.
- `firefox.allowUnverifiedDownload: true` accepts a download when the
  published digest is unavailable, with a loud warning. This disables the
  integrity check for that case, so the archive is trusted on TLS alone. Use
  it only for a mirror you already trust, and prefer pinning `sha256`
  instead. A digest that is fetched and does not match is rejected either
  way. The setting is ignored when `sha256` is set.

`fireforge doctor` reports the pin beside what the checkout actually is (the
engine's own `browser/config/version.txt` and the version the last download
recorded) and warns when they disagree. It is a report, not a lock, since a
tree may legitimately be mid-migration. `product`, `sha256` and `candidate`
have no recorded counterpart on disk, so the check does not claim to have
verified them.

## External toolchains

Projects with generated asset prerequisites can declare opt-in
`externalToolchains`. `fireforge doctor` reports missing required tools as
errors and missing optional tools as warnings.

Seasonal branding on macOS, for example, can declare Apple's Icon Composer
tool at
`/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool`,
plus `actool` via `xcrun`, `sips`, and `iconutil`.

On macOS, `fireforge doctor` also checks that the bootstrapped clang
(`~/.mozbuild/clang`, or under `MOZBUILD_STATE_PATH`) can link against the
SDK the build will use. That is the SDK `engine/mozconfig` selects with
`--with-macos-sdk`, resolved by sourcing the mozconfig the way mach does,
or `xcrun --show-sdk-path` when it names none. The check links a trivial C
program through the toolchain's lld in a temp directory. When that fails, it
reports a warning with clang's first error and lists the SDKs installed
under the mozbuild state directory, the Command Line Tools and the active
Xcode. An Xcode update can ship an SDK the pinned toolchain cannot read, and
`mach configure` then dies at its linker probe with nothing but `config.log`
saying why. The check does nothing on other platforms and when no clang has
been bootstrapped.

## `patchLint`

Per-patch lint type-checks plain Firefox JS against a built-in
Firefox-globals shim that tracks upstream WebIDL additions per release.
Most globals in it are `any`. `Cu` is typed as `CuShim`, the members of
`nsIXPCComponents_Utils` (`js/xpconnect/idl/xpccomponents.idl`) with loose
parameter and result types, so a call to a member `Cu` does not have (such
as `Cu.now()`, which is `ChromeUtils.now()`) fails `typecheck` and per-patch
lint instead of throwing at runtime (since 0.50.0). The same shim backs
`fireforge typecheck`.

- `patchLint.checkJsExtraShim` adds members to the structured shim globals
  via TypeScript interface merging, for example
  `interface ChromeUtilsShim { newApi(): any }`.
- `patchLint.checkJsTestFiles: true` extends the pass to patch-owned test
  `.js` files (`browser_*`, `test_*`, `xpcshell_*`, and `/test/` paths). Each
  one is checked as its own small script-scope program against a loose
  built-in harness shim.
- `patchLint.checkJsTestShim` points at a project `.d.ts` whose typed
  declarations (a real `TestUtils` interface, say) override the loose
  baseline, so calls to harness members that do not exist fail at export
  time.
- `patchLint.prettier` (`'off'`, `'warning'` or `'error'`, default `'off'`)
  runs the project's configured Prettier over patch-owned `.sys.mjs`
  modules. It runs from inside `engine/`, so `engine/.prettierrc*` and
  `engine/.prettierignore` decide the outcome. The same command run from the
  repo root can report a false pass when the root `.prettierignore` excludes
  `engine/`. Prettier is resolved from `engine/node_modules`, then the
  project's, then `npx --no-install`. Left at `'off'`, formatting is out of
  scope for the per-patch tier, and no other tier checks `.sys.mjs`
  formatting either.
- `patchLint.forwardRegistration` (`'support-files'` or `'extended'`,
  default `'support-files'`) picks which carriers the `forward-registration`
  queue rule checks for a line naming a file that only a later patch
  creates. The default checks test-manifest `support-files`. `'extended'`
  also checks:
  - jar.mn pair lines (the source in parentheses, relative to the jar.mn);
  - moz.build path tokens (a quoted string with a `.` or `/`, relative to
    the moz.build);
  - test-manifest section headers and `head`;
  - `customElements.js` `chrome://<pkg>/content/…` URLs, resolved through
    the jar.mn lines the same queue adds.

  A line whose target cannot be resolved without the build system is left
  alone: a `%` or `@AB_CD@` substitution, `**`, `!`, a path that leaves the
  tree, or a chrome URL no queue jar.mn line packages. Each finding prints
  the same paste-and-run `patch staged-dependency --add --kind registration`
  command as the `support-files` arm, ending in a `--reason '<why …>'`
  placeholder to fill in. Each finding also carries the declaration as
  structured `stagedDeclarations`, so a `lint --per-patch --report` file
  can be applied with one `patch staged-dependency <patch> --add --from
<report>` per patch instead of one call per edge. The setting is opt-in because a queue
  that predates it can carry many such edges, and a new error would red a
  `--max-warnings 0` gate on install. The same census is on the public API as
  `findForwardRegistrations(patchesDir, { scope })`, which defaults to
  `'extended'`, for a consumer that keeps its own ratchet over these edges.

- `patchLint.fileSizeThresholds` tunes the `file-too-large` line counts per
  file class:

  ```json
  {
    "patchLint": {
      "fileSizeThresholds": {
        "general": { "notice": 500, "warning": 800, "error": 900 },
        "test": { "warning": 1500 }
      }
    }
  }
  ```

  Every field is optional and merges over the defaults (general
  `500/750/900`, test `1200/1400/1600`). The merged triple has to satisfy
  `notice <= warning <= error`, which is validated at config load. Under
  the recommended gate posture `--max-warnings 0`, the `warning` band
  is a hard failure rather than a soft limit, which is what these thresholds
  exist to let you move. A notice is the design target: advisory, and it
  never fails `--max-warnings 0`. Only the error band suggests splitting.

- `patchLint.fileSizeMetric` (`'raw'` or `'code'`, default `'raw'`) picks
  what `file-too-large` counts. `'raw'` counts every line, the way `wc -l`
  does. `'code'` blanks comments with acorn's tokenizer (module first, then
  script, since chrome subscripts are scripts) and counts the lines left
  non-blank, so JSDoc and blank lines stop counting. A file acorn cannot
  tokenize is counted in raw lines, the upper bound, and a
  `file-size-unparsed` notice names it. Every message says which unit it
  counted ("lines" or "code lines"). The counter is on the public API as
  `countCodeLines(content)`, next to `resolveFileSizeThresholds` and
  `isTestFile`.

- `patchLint.patchSizeThresholds` tunes `large-patch-lines` and
  `large-patch-files` per tier (`general`, `test`, `branding`), each with a
  `lines` and a `files` triple:

  ```json
  {
    "patchLint": {
      "patchSizeThresholds": {
        "general": {
          "lines": { "notice": 1000, "warning": 2000, "error": 4000 },
          "files": { "notice": 8, "warning": 12, "error": 24 }
        },
        "branding": { "files": { "error": 90 } }
      }
    }
  }
  ```

  Every field is optional and merges over the defaults, and each merged
  triple has to satisfy `notice <= warning <= error`. The line defaults are
  general `800/1500/3000`, test `1500/3000/6000` and branding
  `8000/18000/30000`. Files warn above 5 (general, test) or 60 (branding).
  The files triple has no notice or error band unless you set one: an unset
  `files.notice` follows `files.warning`, and an unset `files.error` never
  fires. The `branding` tier applies to a patch whose files all sit under
  `browser/branding/` (plus `browser/moz.configure` and
  `browser/confvars.sh`), or one marked `"tier": "branding"` in
  `patches.json` (`re-export --tier branding`). A patch whose files are all
  tests takes the `test` tier, and wins over branding.
  `getPatchSizeThresholds(tier, config)` returns the configured values.

- `patchLint.patchSizeMetric` (`'diff'` or `'addedCode'`, default `'diff'`)
  picks what `large-patch-lines` counts. `'diff'` counts every non-binary
  line of the unified diff, headers and context included. `'addedCode'`
  counts only added lines that are neither blank nor comment, judged on
  each file's post-image in `engine/` (a hunk can start inside a block
  comment). Comments are recognised per file kind: JS through acorn, CSS
  block comments, `<!-- -->` in markup, and whole-line `#` comments in
  manifests, `moz.build`, Fluent and similar. In CSS it also skips lines
  inside a Furnace `@fireforge-include` … `@fireforge-end-include`
  expansion: they are a copy of a shared fragment. Under `'addedCode'`, a
  general-tier patch that carries tests counts per class: lines in test
  files against the test tier's `lines`, everything else against the
  general tier's, each with its own finding.

- `patchLint.patchSizeRegistrationFiles` lists globs whose files count
  toward neither `large-patch-lines` nor `large-patch-files`, for example
  `["jar.mn", "moz.build", "components.conf", "*.toml", "jsconfig*.json"]`.
  A glob without a `/` matches the basename, one with a `/` the
  engine-relative path; `*` stays within a path segment and `**` crosses
  segments. Default: none.

- `patchLint.tokenScales` (default unset) puts property families on a token
  scale. In every CSS file a patch creates, a declaration of a governed
  property must resolve to the scale (`token-scale`, an error):

  ```json
  {
    "patchLint": {
      "tokenScales": [
        {
          "properties": ["gap", "row-gap", "column-gap", "padding*", "margin*"],
          "prefix": "--mybrowser-space-",
          "allowLiterals": ["0", "auto", "*%", "1px"],
          "allow": ["--mybrowser-page-padding"]
        },
        { "properties": ["z-index"], "prefix": "--mybrowser-z-" }
      ]
    }
  }
  ```

  `properties` takes exact names or a `*`-suffixed prefix. Each value atom
  must be a `var()` of a `prefix` token or of an `allow` name (exact, or
  `*`-suffixed such as `--moz-*`), a literal matching `allowLiterals` (`*`
  is a wildcard), or a CSS-wide keyword (`inherit`, `initial`, `unset`,
  `revert`, `revert-layer`). A `var()` fallback is held to the same scale,
  so `var(--mybrowser-gap, 7px)` fails on `7px`. `calc()`, `min()`, `max()`
  and `clamp()` are transparent, so a unitless multiplier inside one needs
  an `allowLiterals` entry. Files the patch modifies rather than creates are
  not checked, and a line carrying `fireforge-ignore: token-scale` is
  skipped.

## `typecheck`

`typecheck.projects` lists the jsconfig files `fireforge typecheck` checks
as whole projects. `typecheck.extraShim` and `typecheck.projectOverrides`
add declarations to the Firefox-globals shim, for every project or for one.
When `patchLint.checkJs` is on, the same command also runs the per-patch
checkJs pass that `export` enforces, so a green `typecheck` means
export-clean types.

Project build info is written in `.fireforge/typecheck/`, outside `engine/`,
with a key covering the shim, TypeScript version, compiler options and
FireForge version. Diagnostics always use a fresh project
program: prior incremental diagnostic state is never restored. Cached and
`--no-cache` runs therefore check the same complete file set. `--no-cache`
also disables build-info writes. A jsconfig's own `incremental` and
`tsBuildInfoFile` remain ignored.

Both project and per-patch checkJs provide Gecko DOM constructor
`isInstance(value)` predicates with instance narrowing, plus
`MouseEvent.MOZ_SOURCE_PEN`. These declarations retain normal DOM member
checking; they do not turn constructors or instances into `any`.

## `patchPolicy`

`patchPolicy.ranges` makes `patch compact` range-aware, so closing ordinal
gaps does not move a patch out of the band its category owns.

With `patchPolicy.allowGaps: false`, orders are contiguous within a range:
a new patch must fill an existing gap or take the number right after the
range's last patch. A patch that has to leave the queue without opening a
gap is removed with `patch retire`, which keeps its order as a retired slot
(see [`patch-workflow.md`](patch-workflow.md#queue-maintenance)).

### Registration-only rules

Four opt-in rules read the patch bodies rather than `patches.json` alone.
`verify` and `lint --per-patch` report them (as `patch-policy/<code>` in
lint), at the severity `mutationMode` implies. Mutating commands do not
evaluate them, because those commands check a projected manifest before
any body exists.

```json
{
  "patchPolicy": {
    "ranges": [{ "from": 100, "to": 899, "category": "ui" }],
    "addOnlyMarker": "hominis",
    "upstreamAllowlist": [
      "browser/moz.configure",
      { "path": "**/jar.mn", "addOnly": true },
      { "path": "**/moz.build", "addOnly": true }
    ],
    "scopeRules": [
      { "filenamePattern": "-tests\\.patch$", "files": ["**/test/**", "**/tests/**", "**/*.toml"] }
    ],
    "verifyDocumentPaths": true
  }
}
```

- `upstreamAllowlist` names, as path globs, the upstream files a
  non-reserved patch may modify (`upstream-allowlist`). A file is upstream
  when no patch in the queue creates it, so fork-owned files never need an
  entry. A patch in a `reservedRanges` band is exempt: its allowlist entry's
  `files` already governs it. Globs are anchored engine-relative paths: `*`
  stays within a segment, `**` spans segments, so `*.toml` matches only a
  top-level file and `**/*.toml` matches one anywhere.
- An object entry with `addOnly: true` puts matching files in
  registration-only mode (`add-only`): the patch may only add lines, every
  non-blank added line must contain the marker (the entry's `marker`, else
  `addOnlyMarker`, matched case-insensitively), and deleting the file or
  changing it as binary is refused. When several entries match a file, any
  add-only one makes it add-only.
- `scopeRules` limits a class of patch to the files its globs name
  (`scope`). A rule selects patches by `category`, `filenamePattern` (a
  regular expression over the patch filename), or both. The example keeps a
  `-tests` patch to test directories and test manifests.
- `verifyDocumentPaths: true` requires each reserved allowlist entry's `adr`
  and `documentation` path to exist under the project root
  (`reserved-document-missing`).

## `test`

`test.canaryPath` and `test.canaryTimeoutSeconds` supply the defaults for
`fireforge test --canary`.

`test.reapOrphans` is `"report"` (default) or `"reap"`: what the preflight
census does with a harness helper that survived an earlier run in this
objdir. `"reap"` terminates it and stamps `orphans-reaped=<n>` on the verdict
line; `--reap-orphans` does the same for one invocation. The objdir anchor
rule is the same under both. See [`testing.md`](testing.md).

`test.mochitestPorts` is `"fixed"` (default) or `"auto"`. `"auto"` lets a
browser run proceed while the mochitest server or Marionette port is held by
something that is not this checkout's own, relying on the engine
harness's own busy-port fallback, so sibling checkouts can run browser suites
at once. `--auto-ports` does the same for one invocation. See
[`testing.md`](testing.md#shared-browsers-ports-and-host-state).

## `history`

`history.path` is where FireForge appends its patch history log, relative to
the project root (default `.fireforge/history.jsonl`). The log records
structural patch operations (staged dependencies, splits, renames, export
orders, re-exports that change a patch's file list) as one JSON object per
line. FireForge never reads it back; it is an audit trail only. Each record
carries `invocationId` (shared by every record one command writes), `pid`,
`ppid`, and `sessionId` when the environment sets `FIREFORGE_SESSION_ID`, so
a session sharing the checkout can select its own lines.

Before 0.50.0 the log was `patches/.fireforge-history.jsonl`, inside the
tracked queue. The first append after upgrading moves it to `history.path`;
when both files exist, the old records are appended to the new file rather
than either being overwritten. Setting `history.path` to
`patches/.fireforge-history.jsonl` keeps the old location.

## `buildAudit`

The post-build packaging audit is warn-only. Most of what it would otherwise
report as "missing packaged artifact" is classified away from the structure
of the tree itself: an unselected `--with-branding` tree read from the
generated `engine/mozconfig`, a directory reached only through a
platform-gated `DIRS +=` in an ancestor `moz.build`, a Storybook
`*.stories.mjs`. One case cannot be derived from the tree: a source that is
deliberately never packaged, such as a type-only mirror whose header says it
is never loaded. Declare those:

```json
{
  "buildAudit": {
    "unpackaged": [
      {
        "path": "browser/base/content/hominis-tile-host-types.js",
        "reason": "Type-only mirror of the tile host, never loaded, and no jar.mn entry by design."
      }
    ]
  }
}
```

- `path` is engine-relative. A `*` may glob within one path segment. `**` is
  refused, because a subtree carve-out is how a reviewed exception quietly
  becomes a blanket one.
- `reason` is required and must be non-empty. This is the one audit class
  FireForge cannot verify against the tree, so the declaration is the
  evidence. By the time someone reads it, an unexplained carve-out is
  indistinguishable from a mistake.
- Admitted paths are listed in the audit output, never silenced. The notice
  reads `admitted as unpackaged by buildAudit.unpackaged "<path>"` followed
  by the declared reason.
- A declared path that does resolve to a packaged artifact is reported as a
  stale carve-out rather than suppressed, because the declaration asserts a
  fact about the tree that is no longer true.
- A declaration matching nothing that changed in a given run says nothing.
  Unlike `--expect-unmanaged`, whose unmet entries are reported because it is
  a per-invocation flag list, this is a standing list checked only against
  the files that happened to change, so "not met" is the normal case.

The `Packaged:` summary line names each non-zero skip class with its count,
so a run that dismissed four unselected-branding files reads differently from
one that dismissed four unregistered sources.

## `check`

`fireforge check` is the composed static gate. It runs six built-in steps,
`status`, `verify`, `lint`, `typecheck`, `furnace-validate` and
`token-coverage`, and then the project's own commands. Every field of the
`check` block is optional:

```json
{
  "check": {
    "skip": ["token-coverage"],
    "status": {
      "failOn": ["unmanaged", "patch-owned-drift", "conflict", "ownership-conflict"],
      "allow": ["patch-backed", "branding", "furnace", "binary-unsupported"],
      "failOnUnknown": true
    },
    "maxWarnings": { "lint": 0, "furnace": 0 },
    "extraSteps": [
      { "name": "policy-audit", "command": "npm run audit:policy", "timeout": 600 },
      { "name": "invariants", "command": "node check-invariants.mjs", "cwd": "tools" }
    ]
  }
}
```

- `skip` lists the built-in steps this project never runs. `typecheck` is
  also skipped when there is no `typecheck` block, and `furnace-validate`
  when there is no `furnace.json`.
- `status` is the status step's `--check` policy: `--fail-on`, `--allow` and
  `--fail-on-unknown` (see [`patch-workflow.md`](patch-workflow.md#ci-enforcement)).
  An invalid policy is refused as a config error before any step runs.
- `maxWarnings` passes `--max-warnings` to `lint --per-patch` and
  `furnace validate`.
- `extraSteps[]` adds project commands. `name` is lowercase letters, digits
  and dashes and must not repeat a built-in name. `command` runs with
  `/bin/sh -c` (`cmd.exe /c` on Windows) from the project root, or from the
  project-relative `cwd`. `timeout` is in seconds: past it the step's whole
  process tree is killed and the step fails. A step passes when it exits 0.

## Design tokens

Tokens are managed with `fireforge token add`. `fireforge token list` and
`fireforge token show` report what is already there.

- `--create-category` declares a new category banner and inserts the token in
  one step. It cannot be combined with `--variant`: author the category with
  the base token first, then add each variant.
- `--category` is required for a base declaration and optional under
  `--variant`, where the declaration is routed into a `:root<selector>` block
  and never into a category section. It is still validated when supplied.
- `--variant` takes the same selector grammar the block matcher understands:
  one attribute fragment (`[data-private]`, `[data-skin=precision]`), a run
  of them (`[data-skin=precision][data-theme=dark]`), and an optional
  pseudo-class tail (`[data-skin=precision]:not([data-private])`). Names and
  values must be identifier-safe, and `=value` is normalized to `="value"`. A
  variant naming a qualifier matches only a block carrying that qualifier.
  One without a qualifier still matches a qualified block, and the write says
  so.
- `--mode override` mirrors into both `:root[data-theme="dark"]` and
  `:root[data-theme="light"]`. A qualified block such as
  `:root[data-theme="light"]:not([data-private])` is matched and written
  through, with a warning naming the selector. The qualifier carries meaning,
  but silently skipping half the mirror is the worse failure.
- A token already present in the target block is reported with its location
  (`already exists in :root[…] (line N), unchanged`) rather than as a bare
  no-op.

### Reading the token file

`token add --category` refuses a category that the tokens CSS does not
declare, so `token list` exists to name the categories without you
hand-parsing a `= Category =` banner out of the file.

- `fireforge token list [--category <name>] [--json]` reports each category
  banner with the tokens declared under it, in file order. Declarations above
  the first banner are reported under `(no category)` rather than dropped,
  and a banner with no tokens is still listed, since `token add` accepts it.
  An unknown `--category` is refused by naming the ones that exist, because a
  filter that printed nothing would read as "this category is empty".
- `fireforge token show <token-name> [--json]` reports the owning category
  and the value the token takes in every block that declares it: the base
  `:root`, the dark `@media` mirror, and each `:root[variant]`, with the line
  of each. The leading `--` is optional, and if you include it, pass the `--`
  separator first (`fireforge token show -- --my-token`).

Only the base `:root` block owns a token, so `token list` reports it once.
The dark and variant blocks mirror it and appear in `token show`.

### Checking the token file

`fireforge token lint [--json]` exits non-zero on either of two findings:

- `token-lockstep`: a themed override block (the dark `@media` mirror, a
  `:root[variant]` block) declares a token with the project's token prefix
  that the base `:root` does not declare. Every other theme would resolve
  it to nothing. Overrides of non-prefixed properties (a `--moz-*` platform
  variable) are left alone.
- `token-undeclared`: a `var(--<prefix>…)` in the tokens CSS, or in any CSS
  file a patch in the queue touches, names a token no block of the tokens
  CSS declares. A property declared in the same file, and the `furnace.json`
  `tokenAllowlist` and `runtimeVariables` names, are exempt.

The prefix is `furnace.json` `tokenPrefix`, else `--<binaryName>-`.

## Smoke runs

For unattended smoke checks, `fireforge run --smoke-exit <s> --headless`
launches the browser headless. A headed smoke window on a shared desktop
absorbs live input, which contaminates the console capture, so headed
non-CI launches print a warning saying so. Exit codes 12 and 13 separate a
console regression from a launch failure. See
[`exit-codes.md`](exit-codes.md).

A smoke run starts on a fresh temporary profile by default (since 0.48.0).
The step exists to prove what the build does on a clean start. The
developer's `obj-*/tmp/profile-default` carries whatever the last session
left (a pre-reset database, a restored hand-made applet), and those reds
say nothing about the tree. FireForge creates the directory under the OS
temp dir, seeds the two prefs `mach run` writes into profiles it makes
itself (`browser.shell.checkDefaultBrowser` and
`browser.aboutConfig.showWarning`), and passes it to Firefox as
`-profile`. The directory is removed when the run ends. That includes a
failed run and a SIGINT/SIGTERM, which the signal handler removes after
the browser tree has shut down. A FireForge that was SIGKILLed cannot clean
up after itself, so the next `run` removes any temporary profile whose
owning process is gone.

- `--profile <path>` launches with a named profile directory and leaves it
  in place. Under `--smoke-exit` it replaces the fresh default. Firefox also
  gets `-purgecaches` (since 0.50.0), which discards the profile's startup
  cache of compiled chrome scripts. That cache is keyed on the build id, and
  a `build --ui` does not change it, so without the purge a kept profile runs
  the chrome scripts an earlier build cached. `--no-purge-caches` keeps the
  cache. mach's `profile-default` has its `startupCache/` removed before
  every run, and a temporary profile starts without one.
- `--temp-profile` gives a plain `run` the same fresh, removed-afterwards
  profile.

A smoke run whose browser exits with a clean status before the window
elapses, without printing any console output, fails with exit 13 (since
0.50.0). Lines from mach's own log (the timestamped command echo) do not
count as output. A launch that exits silently never reached a window: a
stale `.parentlock`, or a profile whose run of SIGTERM-ended smoke runs
counts as a startup-crash streak (`toolkit.startup.recent_crashes`). Before
0.50.0 such a run passed as a clean exit.

A plain `run` without either flag keeps mach's `profile-default`. `mach run`'s
desktop parser has no `--profile` option (its `--profile/-P` belongs to the
Android parser), so the profile is always passed as a program parameter.
With an explicit profile, mach neither writes its `runprefs` from
`~/.mozbuild/machrc` nor accepts `--setpref`.

The allowlist (`--console-allow-file`) is count-blind by default: a line that
matches an entry never counts, however often it fires. A `# max-hits: N`
comment directly above an entry (other comments may sit between) caps how
many lines that entry may match in one run. The attribution block prints
capped entries as `hits×/N`, and an entry that fires past its ceiling is
reported and fails the run with exit 12, the same as an unallowed error. A
directive with no entry after it is refused rather than silently ignored.

## Lock waits

Every FireForge command that mutates the engine takes the engine-session
lock, and some take a second subsystem lock as well. Contention fails fast
after about a second by default.

`--wait-lock [seconds]` (bare flag means 60, valid range 1 to 3600) replaces
that with a bounded wait, and the budget covers every lock the command takes.
For `furnace apply`, `deploy` and `sync` that means the furnace lock as well
as the engine-session lock. The furnace leaves that take only the furnace lock
(`create`, `remove`, `rename`, `refresh`, `scan`, `override`, `preview`, and
`chrome-doc create`/`remove`) apply the flag to that lock. While waiting, a
progress line roughly every 5 seconds identifies the holder by PID, command
and start time.

Commands that take no lock accept `--wait-lock` and ignore it, so a scripted
sequence can append the flag everywhere without a usage error killing the
run.

`FIREFORGE_WAIT_LOCK=<seconds>` applies the same budget to every command in a
session, using the same bounds as the flag. It is the fallback whenever the
flag is absent, including for the furnace lock a build's pre-build apply and
`doctor --repair-furnace` take. An explicit `--wait-lock` always wins.

Waiters are granted a lock in arrival order: the progress line's "You are
next" or "N ahead of you" is the order the lock will actually be handed out.
A waiter that crashed, was killed, or is stopped drops out of the queue
instead of blocking it.

`fireforge status --lock` reports the current holder and queue depth.

## Environment variables

| Variable                             | Effect                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `FIREFORGE_WAIT_LOCK`                | Session-wide lock wait budget in seconds (1 to 3600). See above.                                                                        |
| `FIREFORGE_SESSION_ID`               | Recorded as `sessionId` on every patch history log record this process writes. See `history` above.                                     |
| `FIREFORGE_LOG_KEEP`                 | Also write every `test`/`build` run log here, outside retention (a directory collects one file per run). See `run-logs.md`.             |
| `FIREFORGE_MAX_UNTRACKED_FILES`      | Per-directory cap when expanding collapsed untracked directories in `status` (default 5000). A non-positive value warns and is ignored. |
| `FIREFORGE_GIT_ADD_TIMEOUT_MS`       | Timeout for the monolithic `git add -A` baseline pass (default 10 min). For slow or loaded filesystems.                                 |
| `FIREFORGE_GIT_ADD_CHUNK_TIMEOUT_MS` | Timeout for the chunked `git add -- <dir>` fallback (default 30 min). Paired with the above.                                            |

`CLAUDECODE` is read by mozbuild, not by FireForge. `fireforge test
--full-output` unsets it for test dispatches only. See
[`testing.md`](testing.md#output-verbosity).
