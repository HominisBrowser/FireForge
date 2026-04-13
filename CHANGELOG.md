# Changelog

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
- `build` and `test --build` now share the same preparation pipeline including Furnace apply, so incremental test builds no longer run against stale component state.
- `furnace remove` on an override now restores every overridden engine file to its Firefox baseline instead of leaving deployed files behind.
- Scanner results are cached by content hash within a process, avoiding redundant parsing during scan-status-apply sequences.
- `download` and `build` now check available disk space before starting and warn when free space is low (Firefox source ~5 GB, full build ~20 GB).
- `getProjectRoot()` now throws instead of silent fallback.
- `getPackageRoot()` caches its result after the first call, avoiding repeated filesystem walks.
- Process spawn timeout is now enforced via `AbortSignal.timeout()` instead of the unreliable `timeout` option on `child_process.spawn()`.

### Bug fixes

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
