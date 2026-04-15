# Changelog

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
- Some test generators were derived from early Hominis Browser fork additions, the references to Hominis have been replaced with generic naming.

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
