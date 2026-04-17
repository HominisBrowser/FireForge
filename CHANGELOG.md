# Changelog

## 0.15.0

### Furnace registration

- `furnace apply` idempotency check is marker-comment-tolerant. Previously the single-line substring match (`content.includes('["tag",')`) missed multi-line entries, and the standalone-line regex anchored on `\s*$`, which did not allow trailing `// <marker>:` comments an operator may have appended to a previously-written entry. A duplicate tag was then inserted on every re-apply, and the second `setElementCreationCallback` invocation threw `NotSupportedError: Operation is not supported` at every window-load. The idempotency check now matches on tag-name column 0 (both single- and multi-line array shapes) and tolerates trailing `//` comments on the line.
- New optional fireforge.json field `markerComment` (e.g. `"MYBROWSER"`) is appended as a `  // MYBROWSER:` suffix to every line FireForge writes into `customElements.js`. Keeps fork modifications discoverable and re-applies idempotent without hand-tagging after each apply. The field is threaded through `applyCustomComponent` and `furnace deploy`, not just `furnace create`.
- `addCustomElementRegistration` and its regex fallback both accept the new marker as an optional parameter; the AST idempotency check and the regex-fallback idempotency check share a single helper (`isTagAlreadyRegistered`).

### Furnace `--localized`

- `furnace create --localized` now emits the Mozilla-idiomatic `MozLitElement` l10n pattern: a module-level `window.MozXULElement?.insertFTLIfNeeded("<chrome-uri>")` call and `this.ownerDocument.l10n?.connectRoot(this.shadowRoot)` / `disconnectRoot` in `connectedCallback` / `disconnectedCallback`. Previously the template called `this.insertFTLIfNeeded(...)` directly on a `MozLitElement` instance, which throws `TypeError: this.insertFTLIfNeeded is not a function` at every connect because that method lives on `MozXULElement`, not `MozLitElement`. The `--localized` path was silently non-functional.
- `furnace apply` now registers the scaffolded `.ftl` in the locale jar.mn (default `toolkit/locales/jar.mn`) so the chrome URI `insertFTLIfNeeded` expects actually resolves at runtime. Previously only the `.ftl` file itself was copied into the FTL tree, with no chrome registration. `furnace remove` and the workspace-delete codepath (`undeployCustomFiles`) drop the jar.mn entry symmetrically.
- The locale jar.mn write degrades gracefully — a missing target (non-standard fork tree) surfaces a structured step error rather than aborting apply, so a well-formed `.mjs`/`.css` is never blocked by a broken locale path.
- FTL chrome URIs are now derived from `furnace.json.ftlBasePath` via a pair of helpers (`resolveFtlChromeSubPath`, `resolveFtlLocaleJarMnPath`) so forks that customise the FTL tree get matching `insertFTLIfNeeded` and jar.mn output.

### Furnace validate

- `missing-token-link` now reads `tokenHostDocuments` from furnace.json and scans every configured chrome document for the tokens CSS link. Warning fires only when NONE of them link the tokens CSS; the warning enumerates the documents it actually checked. Previously the check was hardcoded to `browser/base/content/browser.xhtml`, which false-positived on forks that mount components in a different chrome document (e.g. `mybrowser.xhtml`). Defaults to `["browser/base/content/browser.xhtml"]` when omitted — behaviour is unchanged for projects that never set the field.
- `no-keyboard-handler` no longer warns when `@click` sits on a native interactive element (`<button>`, `<a href>`, `<input>`, `<select>`, `<textarea>`, `<summary>`, `<details>`, or the Firefox `moz-button`/`moz-toggle`/`moz-checkbox`/`moz-radio`/`moz-menulist` widgets). Those elements dispatch `click` on Enter and Space via the platform, so a duplicate `@keydown`/`@keypress` handler would double-fire. The rule still fires for synthetic interactive markup (e.g. `<div @click>`) and for bare `<a>` without an `href` attribute, which are the real keyboard-a11y hazards.
- `token-prefix-violation` stops flagging component-owned runtime CSS custom properties. Previously every `var(--foo)` that did not match `tokenPrefix` was rejected as a design-token escape, even when the property was a per-frame state channel (`--cam-x`, `--tile-z`) both written and read by the component. Two relaxations ship together: (a) a new optional `runtimeVariables: string[]` field in `furnace.json` explicitly allowlists cross-component runtime channels (e.g. set in JS, read in the child's CSS); (b) variables that are both declared (`--foo: value;`) and consumed (`var(--foo)`) inside the same CSS file are auto-exempted — no config entry required. The same relaxations apply to the patch-stack lint. The violation message now calls out `runtimeVariables` as the third escape hatch alongside `tokenPrefix` and `tokenAllowlist`.
- `hardcoded-text` narrowed from a bare `>…<` scan to three context-aware probes: text inside Lit `` html`…` `` template literals, string literals assigned via `.textContent = "…"` / `.innerHTML = "…"`, and XUL-attribute values set via `setAttribute("label"|"title"|"tooltiptext", "…")`. Previously the rule also matched JS comparisons (`if (x > 0 && y < 100)`), long diagnostic strings (`console.error("…")`), and identifier literals passed to `querySelector`, producing noise that trained authors to ignore validator warnings. The file-wide `// furnace-ignore: hardcoded-text` escape hatch is preserved.

### Run / test

- `fireforge run`, `fireforge watch`, `fireforge build`, and every other `mach` invocation launched with inherited stdio now forward parent `SIGINT`/`SIGTERM` to the child as `SIGTERM` and wait ~1.5 s before escalating to `SIGKILL`. A second Ctrl-C during the grace window escalates immediately (matches the usual "hit Ctrl-C twice to force-quit" UX). Previously the parent could exit before Gecko's `AsyncShutdown` / `profileBeforeChange` blockers finished flushing in-memory state, losing the last few seconds of edits. The grace window is configurable via a new `shutdownGraceMs` option on `execInherit` / `execInheritCapture`.
- New `fireforge test --doctor` runs a short marionette handshake preflight before (optionally) invoking `mach test`. Spawns the built browser headless, opens a TCP socket to `127.0.0.1:2828`, waits for the handshake bytes, and reports PASS/FAIL with the tail of stderr on FAIL. When `--doctor` is supplied with no test paths, it exits after the preflight — a sub-minute way to tell "marionette wedged" apart from "test failed to discover" when `mach test` hangs for the full 360 s marionette timeout. When supplied with test paths, a FAIL preflight short-circuits before `mach test` runs.
- `fireforge test --doctor` is now a cascade of six layered probes (engine-present → mach-available → python-available → profile-creatable → browser-spawns → marionette-handshake) with tight per-layer budgets. Previously the single 30 s socket poll gave the same generic "socket did not respond" diagnostic whether mach was missing, Python was unavailable, `/tmp` was not writable, or the browser binary crashed at startup — so operators had no lead on where to start debugging. Each layer now short-circuits with a `[layer N/6: <name>]`-prefixed detail message so the first broken layer is surfaced immediately, and a crashing browser is caught by a short settle window at layer 5 instead of wasting the full budget waiting for bytes that never come.

### Furnace build

- `fireforge build` already auto-applies Furnace components (via `prepareBuildEnvironment`) before the mach build step, but the behaviour was undocumented and silent — operators who edited `components/custom/` and then ran `fireforge build` could not distinguish "auto-apply wrote files" from "nothing changed". A loud `Furnace: source → engine sync wrote N component(s) before build (...)` banner now fires whenever apply wrote files, naming every component that was synced. The `fireforge build --help` description and help footer now call out that apply runs before the build step.

### Furnace create

- New `furnace create --xpcshell` flag scaffolds an xpcshell test harness alongside (or instead of) the browser-chrome mochitest that `--with-tests` already produces. xpcshell runs headless without a `tabbrowser`, so storage-layer / observer-driven / module-loading code on forks that do not mount the upstream browser chrome (no `openLinkIn` → `URILoadingHelper`) can be covered without the harness complaining about a missing tab strip. Writes `test_<name>_module_loads.js` and an `xpcshell.toml` manifest into `engine/browser/base/content/test/<binary-name>-xpcshell/<component-name>/`. Registration in `XPCSHELL_TESTS_MANIFESTS` is left to the operator — the moz.build that should own the entry depends on where the component lives.

### Internal

- Extracted `furnace-apply-ftl.ts`, `furnace-config-tokens.ts`, and `create-templates.ts` to keep apply / config / scaffolding files under the per-file LOC budget after the new features landed. `parseStringArray` is now exported from `furnace-config.ts` for cross-module reuse.
- New `src/core/marionette-preflight.ts` owns the `--doctor` probe and its teardown semantics.
- Test mocks for `furnace-registration.js` now cover the new `addLocaleFtlJarMnEntry` / `removeLocaleFtlJarMnEntry` exports; `config.js` mocks in apply-batch tests now cover `loadConfig` because the apply path reads `markerComment` from fireforge.json.
- Repo-wide scrub of fork-example mentions (`hominis.xhtml`, `HOMINIS` marker-comment examples, fixture tag names) in favour of a generic `mybrowser` / `MYBROWSER` placeholder. FireForge reads as fork-agnostic in docs and fixtures; the npm identity (`@hominis/fireforge`) is unchanged.

## 0.14.0

### Concurrency and atomicity

- Patch body and manifest writes in `re-export`, `rebase --continue`, and the post-apply re-export loop in `rebase` are now atomic via `updatePatchAndMetadata`, so a concurrent `resolve` / `re-export` / `patch compact` / `patch reorder` cannot leave body and metadata disagreeing.
- State writes in `import`, `resolve`, and `rebase` (abort, continue, patch loop) use transactional `updateState` so a concurrent command's unrelated keys are no longer clobbered.
- `rebase` apply + session persist is guarded by a new `runInSignalCriticalSection` primitive in `src/core/signal-critical.ts`; SIGINT / SIGTERM between apply and persist (5 s ceiling) no longer leaves an applied patch marked pending, so `--continue` does not re-apply it.

### Rebase

- Per-patch re-export failures after apply are collected instead of silently dropped. The session stays on disk and `sourceEsrVersion` is not stamped until every re-export succeeds, so `--continue` can retry after the root cause is fixed.
- `rebase --continue` retries the post-apply pipeline when the apply loop has already finished; the prior "session may be corrupt" rejection no longer blocks resumption.
- `rebase --abort` splits into four sequenced steps (git reset, furnace state clear, `pendingResolution` clear, session clear) so failures get correctly-labelled errors and the session stays on disk for retry.

### Download

- `download` restores patch-touched files to baseline after the initial commit (or a resumed partial init), so extraction artefacts and line-ending normalisation no longer force `fireforge import --force` on a clean install. Pre-existing uncommitted edits are preserved and warned about.
- `cleanPatchTouchedFiles` runs before stamping `state.downloadedVersion`, preserving the invariant that the stamped version matches a clean engine.
- Resume preserves the original error cause (timeout, permission denied, corrupted git object, disk full) instead of discarding it behind a generic `PartialEngineExistsError`. Unexpected errors during the partial-engine probe are also wrapped rather than re-thrown bare.

### Import

- Classification no longer swallows structural errors as "unmanaged dirty file". Only pure-IO errors (`ENOENT`, `EACCES`, `EPERM`, `EISDIR`, `EBUSY`) fall through; `PatchError`, manifest corruption, and patch-parse failures re-throw with the original diagnostic.
- Patch integrity issues prompt in interactive mode and error in non-interactive mode instead of warn-and-continue; `--force` still bypasses with an explicit warning.

### Furnace

- `furnace apply --watch` picks up newly-created component directories dynamically, remembers edits that arrive during an in-flight apply (a second cycle runs automatically), and classifies errors errno-aware (`EACCES`, `ENOSPC`, `EBUSY`, `ENOENT`, `ETIMEDOUT`) instead of collapsing into a generic "Apply failed".
- `furnace override` rejects collisions with `config.stock` and `config.custom` in both single and batch paths, and wraps snapshot + copy pairs in per-file error context so a mid-copy failure names the failing file.
- `furnace remove` requires a git engine for custom components (not just overrides) and hoists the precondition outside the lock and journal registration. A summary line surfaces when test-file cleanup fails partway.
- `furnace rename` does prefix-only filename replacement; the prior substring replacement mangled names when `oldName` appeared more than once. Content regexes now escape every metacharacter.
- `furnace deploy` asserts `applied[0].name` matches the requested component before persisting state; state-mismatch errors recommend `fireforge doctor --repair-furnace`.
- `furnace validate --fix` reports the actual delta from re-validation instead of inflating the count on no-op fixes.
- `furnace list -v` tolerates missing or unreadable component directories, rendering `unavailable` instead of terminating the listing.
- `furnace diff` surfaces `--reset-base` recovery in the primary error rather than a secondary catch block.
- `furnace init --ftl-base-path` traversal check uses path normalisation instead of substring match, rejecting absolute paths, null bytes, and `..` segments. Interactive detection checks both `stdin.isTTY` and `stdout.isTTY` to match every other interactive command.

### Other commands

- `setup` rejects project names whose sanitised slug is empty (emoji-only, pure punctuation, `---`). `validateConfig` similarly rejects empty `name`, `vendor`, `appId`, `binaryName`.
- `config --force` no longer bypasses structural validation for known keys in `SUPPORTED_CONFIG_PATHS`; the flag is only an escape hatch for unknown keys.
- `watch` probes `watchman --version` with a 5 s timeout before starting, and runs the furnace staleness check previously only in `run`. Both commands share a new `warnIfFurnaceStale` helper in `src/core/furnace-staleness.ts`.
- `test` path normalisation is case-insensitive, accepts `\` as well as `/`, and trims whitespace, so `Engine/foo/bar` on macOS / Windows no longer reaches `mach` with the prefix intact.
- `status` caps untracked-directory expansion at 5 000 files per directory (configurable via `FIREFORGE_MAX_UNTRACKED_FILES`) and renders a top-of-output banner when directories were truncated, so large outputs don't hide the warning in scrollback.
- `export` empty-diff error distinguishes the `--skip-lint` case; `export-shared` always announces when `--skip-lint` is active.
- `wire <name>` and `register --after <entry>` validate their inputs against strict regexes, rejecting path separators, parent-dir segments, control characters, and line terminators before any filesystem operation.
- `token add --mode` uses Commander's `.choices()` so invalid modes fail with the built-in message and `--help` lists the valid options.
- `run` whitelisted exit codes (0, 130 SIGINT, 143 SIGTERM) are documented inline; SIGKILL (137) and other abnormal signal codes surface as build errors.
- `discard` wraps error causes via `toError` so thrown strings or numbers propagate as real Errors with stack traces.

### Internal

- New unit tests for `validateCheckDependencies` in `src/commands/doctor.ts` assert the forward-only dependency invariant so a regression cannot slip in when reordering checks.

## 0.13.0

### Setup

- **`fireforge bootstrap` now runs targeted post-bootstrap checks** instead of pattern-matching output text. When `mach bootstrap` exits successfully but sub-downloads fail (e.g. HTTP 403 from Apple's CDN), FireForge validates actual system state — checking whether a macOS SDK is available via Xcode — and reports actionable results using the same `✓`/`!`/`✗` severity rendering as `fireforge doctor`. Non-critical issues (SDK download failed but Xcode provides one) are reported as warnings rather than alarming "did not complete successfully" errors.

### Lint fixes

- **`file-too-large` now uses tiered severity thresholds.** The old single 650-line warning is replaced with a three-tier system (notice / warning / error) that distinguishes general files from test files. General files: 500–749 lines notice, 750–899 warning, 900+ error. Test files (paths containing `/test/`, or filenames matching `browser_*.js`, `test_*.js`, `xpcshell_*.js`): 1200–1399 notice, 1400–1599 warning, 1600+ error. Messages include the applicable thresholds so users know where they stand. The new `notice` severity is displayed but does not count toward warning or error totals and does not block export.
- **`observer-topic-naming` no longer matches across newlines.** The regex that extracts topic strings from `notifyObservers`/`addObserver`/`removeObserver` calls now anchors to a single line, preventing false positives when the call spans multiple lines and an unrelated string literal appears later.
- **`raw-color-value` now supports a file allowlist and inline suppression.** New `patchLint.rawColorAllowlist` config array in `fireforge.json` exempts file paths (exact or basename match) from the raw-color check — intended for design token files that must contain raw color values. Individual declarations can also be suppressed with an inline `/* fireforge-ignore: raw-color-value */` comment.
- **`large-patch-lines` now uses tiered severity thresholds.** The old single >300-line warning is replaced with a three-tier system matching the `file-too-large` pattern. General patches: 800+ lines notice, 1500+ warning, 3000+ error. Test-only patches (all files match test patterns): 1500+ notice, 3000+ warning, 6000+ error. The previous threshold was too restrictive relative to file LOC limits — creating a single new file at the `file-too-large` notice tier (500 LOC) already exceeded it. Messages now include the applicable soft and hard limits.
- **`large-patch-lines` now ignores binary content.** Patches whose diff contains GIT binary patch hunks (PNG, ICO, ICNS, BMP, etc.) no longer count base85-encoded data toward the line limit. This removes the need for `--skip-lint` on branding asset patches that are predominantly binary.
- **`modified-file-missing-header` no longer false-positives on upstream files.** Modified upstream files (e.g. `BrowserGlue.sys.mjs`) that carry an MPL-2.0 header in `/* */` block-comment style were incorrectly flagged because the check only tried the comment style inferred from the file extension. The check now cascades through all comment styles and falls back to scanning leading lines for raw license identifier strings (MPL, Apache, MIT, GPL, SPDX).

### New commands

- **`fireforge patch compact`** — closes ordinal gaps in the patch queue in a single atomic operation. After deletes or splits, patch ordinals may have gaps (e.g. 1, 3, 7); `compact` renumbers them sequentially (1, 2, 3). Previously this required N sequential `patch reorder` calls. Supports `--dry-run` and `--yes`.

### Register improvements

- **`register` now supports `.xhtml` and `.css` files in `browser/base/content/`.** Previously only `.js` and `.mjs` files were accepted; XHTML and CSS files required manual `jar.mn` edits.
- **`register` now gives actionable advice for unregistrable file types.** Attempting to register a `.ftl` locale file explains that FTL files are auto-discovered via `jar.mn` glob patterns. Attempting to register an individual test file explains that it should be added to the corresponding `browser.toml` and suggests the correct `register` invocation for the test directory manifest.

### General Improvements

- **Minor Refactor**

## 0.12.0

### JSDoc validation (breaking)

- **JSDoc enforcement is now AST-based and severity `error`.** The previous heuristic (walk backwards from `export` to find `*/`) has been replaced with Acorn-based AST analysis. Exported functions must have a JSDoc block with `@param` for each parameter (names must match) and `@returns` when returning a value. Exported classes require a JSDoc block. Exported constants require `@type`. This is a breaking change: projects that previously passed with incomplete JSDoc will now see lint errors.
- **Patch-owned scope.** JSDoc enforcement now applies to all patch-owned `.sys.mjs` files, not just files new in the current diff. A file is patch-owned if it was created by the current diff or by any existing patch in the queue.
- New check: **`jsdoc-param-mismatch`** (error) — flags `@param` tags that are missing or have the wrong name.
- New check: **`jsdoc-missing-returns`** (error) — flags functions that return a value but lack `@returns`.
- Exported constants and classes require a JSDoc block but do not require specific tags like `@type`.

### Optional checkJs pass

- **`patchLint.checkJs`** — new opt-in config field in `fireforge.json`. When enabled, runs TypeScript's `checkJs` pass (`allowJs + checkJs + noEmit`) on patch-owned `.sys.mjs` files only. Firefox globals are shimmed automatically. Diagnostics are filtered to patch-owned files so upstream noise is suppressed.
- New check: **`checkjs-type-error`** (error/warning) — surfaces type errors from the TypeScript compiler.

### Hardening

- **Path validation.** `binaryName` in `fireforge.json` now rejects null bytes and absolute paths (including Windows drive letters). `isContainedRelativePath` and `isPathInsideRoot` reject null bytes. Furnace custom component `targetPath` rejects null bytes and absolute paths.
- **Symlink traversal protection.** Patch target validation now checks whether existing paths are symlinks resolving outside the engine tree before applying.
- **PID-aware stale lock recovery.** The file lock writes the owning PID into the lock directory. Stale lock recovery checks whether the PID is still alive before removing, preventing premature removal when a slow operation legitimately holds the lock.
- **Forward-import detection** now catches `ChromeUtils.importESModule()` calls in addition to static/dynamic ES imports and `defineESModuleGetters`.
- **Furnace rollback failure markers** now include the component name and operation context, improving diagnostics in `fireforge doctor`.
- New lint check in README: **`modified-file-missing-header`** (warning) was implemented but not documented; now listed in the lint checks table.

## 0.11.0

### New commands

- **`fireforge verify`** — read-only integrity check for the patch queue. Reports duplicate file creations across patches, forward imports, orphaned patch files, and manifest inconsistencies. Exits non-zero on any error, making it usable as a CI pre-flight gate.
- **`fireforge patch delete <name>`** — removes a patch file and its manifest entry atomically. Refuses when a later patch imports from a file the deleted patch owns (bypassable with `--force-unsafe`).
- **`fireforge patch reorder <name> --to <N> | --before <anchor> | --after <anchor>`** — moves a patch to a new position, renumbers surrounding patches, and runs cross-patch lint against the projected order before writing.

### New flags and options

- `fireforge export --dry-run` previews the full export plan (filename, metadata, affected files) without writing. With `--supersede`, shows which existing patches would be absorbed and why.
- `fireforge export --order <N> | --before <anchor> | --after <anchor>` places a new patch at a specific position and shifts subsequent patches up.
- `fireforge re-export --files <paths> <patch>` restricts a re-export to an explicit file subset, useful for splitting or shrinking a patch's scope.
- `fireforge import --until <patch>` (alias `--stop-at`) applies patches only up to the named patch, useful for bisection.
- `fireforge status --ownership` prints a flat table mapping every managed path to its owning patch and flags ownership conflicts.
- `fireforge furnace apply --force` and `furnace deploy --force` proceed despite `baseVersion` drift between `furnace.json` and the Firefox version.
- `fireforge furnace deploy --skip-validate` skips the validation suite during deploy.
- `fireforge furnace override` now accepts multiple tag names in a single invocation for batch creation.
- `fireforge import --dry-run` previews which patches would be applied, in order, without modifying the engine.
- `fireforge status --json` outputs classified file status as machine-readable JSON for CI scripting.

### Furnace improvements

- **`furnace refresh <name>`** merges upstream Firefox changes into an override workspace via three-way merge. Clean merges update `baseVersion` automatically; conflicts leave standard markers for manual resolution. Supports `--dry-run` and `--reset-base` (skip merge, just update the baseline).
- **Full overrides now include shared Fluent files.** Localized widgets (those with a `.ftl` file) are now copied, applied, removed, and diffed end-to-end instead of silently dropping the locale payload.
- **`furnace diff` rewritten with proper multi-hunk output.** Scattered edits across a file now render as separate hunks with context lines instead of one giant block.
- **`furnace apply` detects and undeploys deleted workspace files.** If you remove a file from a component's workspace directory and re-run apply, the corresponding engine copy is cleaned up and registrations are adjusted.
- **`furnace status` now distinguishes workspace edits from engine drift.** These have different remediation paths and are reported separately instead of collapsed into one message.
- **`furnace scan` offers to override just-added stock components** in the same interactive session.
- **Preview stages workspace files into the engine** before launching Storybook so fresh edits actually appear, then rolls them back on teardown.
- **FTL base path is now configurable** via `ftlBasePath` in `furnace.json` for projects with non-standard locale paths.
- **`scanPaths` in `furnace.json`** lets `furnace scan` discover components outside the default `toolkit/content/widgets`.
- File copies during apply are now parallelized within each component.

### New lint rules

- **`duplicate-new-file-creation`** (error) — flags any path that appears as a new-file creation in more than one patch.
- **`forward-import`** (error) — flags imports that reference a file owned by a later-ordered patch. Supports an inline suppression marker (`// fireforge-ignore: forward-import`) for false positives from basename collisions.

### Doctor and diagnostics

- `fireforge doctor` now runs the full Furnace component validation suite (structure, accessibility, compatibility, registration) and reports issues without needing a separate `furnace validate` run.
- New `--repair-furnace` flag reconciles the engine when a furnace operation was interrupted or left inconsistent state.
- `fireforge doctor` checks that Firefox-internal paths Furnace depends on still exist and reports targeted warnings when they are missing.
- `furnace validate` now enforces `.ftl` presence for `localized: true` custom components and no longer false-warns about missing CSS jar entries when the component has no CSS file.

### Reliability

- All furnace mutations now serialize on a project-wide lock, preventing concurrent operations from racing on engine state.
- Ctrl+C and SIGTERM trigger clean rollback across all furnace commands. A `pendingRepair` marker is only written when rollback was actually incomplete, so normal interrupts do not leave false-positive repair flags.
- Override `baseVersion` drift now blocks `apply` and `deploy` by default instead of warning and continuing. Pass `--force` to override, or use `furnace refresh` to update the baseline.
- Post-apply consistency check verifies that `customElements.js` and `jar.mn` entries match what was deployed.
- Engine-side content hashes are cached in the furnace state file, making drift detection faster for the common no-change case.
- Branding file writes are now content-aware: re-running setup with the same configuration no longer bumps file timestamps, avoiding unnecessary `config.status` reconfiguration during incremental builds.
- `build` and `test --build` now share the same preparation pipeline including Furnace apply, so incremental test builds no longer run against stale component state.
- `furnace remove` on an override now restores every overridden engine file to its Firefox baseline instead of leaving deployed files behind.
- Scanner results are cached by content hash within a process, avoiding redundant parsing during scan-status-apply sequences.
- `download` and `build` now check available disk space before starting and warn when free space is low (Firefox source ~5 GB, full build ~20 GB).
- `getProjectRoot()` now throws instead of silent fallback.
- `getPackageRoot()` caches its result after the first call, avoiding repeated filesystem walks.
- Process spawn timeout is now enforced via `AbortSignal.timeout()` instead of the unreliable `timeout` option on `child_process.spawn()`.

### Bug fixes

- `fireforge setup` now writes an initial `patches/patches.json` (with `version: 1`) when creating a new project. Previously, setup created the `patches/` directory but not the manifest, causing `fireforge doctor` to fail the "Patch manifest consistency" check on a fresh project. Re-running `setup --force` on an existing project preserves the current manifest.
- The full Firefox integration test script (`scripts/run-full-firefox-integration.mjs`) now uses `--yes` instead of `--force` when invoking `fireforge discard`, matching the actual CLI flag. This was the sole cause of integration test failures in the discard and recovery workflow steps.
- The integration test's cleanup loop now uses direct git operations (`git checkout` for tracked files, `git clean` for untracked) instead of routing through `fireforge discard`, which could not handle untracked branding files introduced by the build.
- `furnace refresh` now correctly advances the per-override `baseCommit` to the engine HEAD after a successful merge, preventing phantom conflicts on subsequent refreshes.
- `furnace rename` uses the correct file-removal function for FTL files.
- `furnace remove` now parses browser.toml sections properly, cleaning up metadata keys below the section header instead of leaving stale fragments.
- Registration duplicate detection now uses exact path matching so `moz-card` no longer collides with `moz-card-group`.
- The `customElements.js` parser now accepts `const` and `var` loop declarations alongside `let`.
- `re-export --files` refuses to write when a requested path would produce no hunks, preventing manifest/patch-body desynchronisation.
- `patch delete` now respects the `fireforge-ignore: forward-import` suppression marker, matching the behavior of `verify` and `lint`.
- Furnace apply no longer reports "up to date" after `reset --yes` or `download --force` wiped the engine. Both commands now clear the furnace state, and the skip logic checks engine-side drift before trusting cached checksums.
- `status` now classifies Furnace-managed engine paths as `furnace` instead of `unmanaged`, and `export-all` refuses to capture them.
- AST parser fallback in the scanner now emits a warning instead of failing silently.
- `stock` entries in `furnace.json` are validated against a safe character set, rejecting path-traversal strings.

### Internal

- The full Firefox integration script now accepts `FIREFORGE_FULL_FIREFOX_VERSION` to override the Firefox version used during the test run, decoupling the test from the version baked into `fireforge.json`.
- The integration test now verifies that `obj-*/dist/bin/` exists after a build reports success, detecting cases where mach masks a build failure with exit code 0.
- The integration test cleanup loop now uses direct git operations (`checkout` / `clean`) instead of routing through `fireforge discard`, correctly handling untracked branding files introduced by the build.
- New unit tests from a full local Firefox integration run: Python version resolution skips candidates above mach's `MAX_PYTHON_VERSION_TO_CONSIDER` and falls through to a compatible version; fresh-project manifest consistency returns zero issues for the empty manifest that `setup` now writes; bootstrap soft-failure detection catches the `urllib.error.HTTPError: HTTP Error 403` pattern observed in real `mach bootstrap` output.
- CLI command registration is now driven by a declarative manifest instead of hand-listed calls.
- Doctor checks are a declarative registry with per-check `run`, `skipIf`, and `fix` fields.
- New shared destructive-op framework handles confirmation, `--dry-run`, `--yes`/`--force-unsafe`, and audit logging for the patch mutation commands.
- Export internals factored into `planExport` / `executeExportPlan` so dry-run and real writes share one code path.
- Ownership table builder extracted from `status.ts` into `src/core/ownership-table.ts`.
- Cross-patch lint regression calculator extracted from `re-export.ts` into `src/core/lint-projection.ts`.
- The `re-export --files` path extracted into `src/commands/re-export-files.ts` to keep `re-export.ts` under the line limit.
- `max-lines` and `max-lines-per-function` ESLint rules promoted from `warn` to `error`.
- Doctor check ordering dependencies documented in the registry comment.
- Default Firefox version bumped to ESR 140.9.0.

### Packaging

- Package metadata and lockfile updated to 0.11.0.

## 0.10.0

### Patch workflow validation

- Re-export now runs the same patch lint gate as export and export-all before writing patch files or manifest metadata.
- `re-export --skip-lint` now downgrades lint errors to warnings consistently, while default re-export blocks on lint errors and keeps artifacts unchanged.
- Raw CSS colors introduced by a patch are now patch lint errors, matching Furnace validation, without blocking on unrelated pre-existing upstream raw colors.
- Furnace accessibility validation now warns about missing ARIA roles only for generic interactive markup, so native semantic elements are not pushed toward redundant ARIA.

### General improvements

- getPackageRoot up to this point expected hardcoded `@hominis/fireforge`, was changed to just the package name for potential forks and more flexibility when changing project name.
- Some test generators were derived from an early downstream fork; the fork-specific names have been replaced with generic naming so the templates apply to any Firefox fork.

### Build and Git reliability

- Build preflight now fails clearly when multiple build artifact directories make the target ambiguous.
- Git diff and status helpers now surface command failures instead of silently treating failed commands as empty output.
- Stale lock cleanup now distinguishes disappearance races from real cleanup failures.

### Packaging

- Package metadata and smoke tests now use version 0.10.0.
- npm install instructions use the scoped `@hominis/fireforge` package name.
- Packaging and full Firefox integration helpers now handle platform-specific npm and mozconfig names more consistently.

## 0.9.0

### npm release

- Package is now installable via `npm install @hominis/fireforge` or `npm install -g @hominis/fireforge`.
