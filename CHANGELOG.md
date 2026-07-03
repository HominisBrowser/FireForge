# Changelog

## 0.34.0

- Reworked the macOS resource-monitor (psutil) crash mitigation to an **in-process guard FireForge owns on its mach dispatches**: a `fireforge_mach_guard.pth` + module pair is installed directly into every discovered mach virtualenv site-packages (objdir `_virtualenvs` and the `~/.mozbuild` state dir) before each dispatch, because mach's venv re-exec drops `PYTHONPATH` and the 0.33.0 `sitecustomize.py` route never loaded (the env-var shim is retained only for the pre-venv bootstrap phase). The guard now covers the whole crash family: `psutil.virtual_memory`/`swap_memory`/`cpu_percent`/`cpu_times`/`disk_io_counters` are wrapped module-wide (which also covers the direct `psutil.virtual_memory()` call in `mozbuild.base._run_make`), and `SystemResourceMonitor` **construction** is guarded via an import hook that pre-populates `poll_interval` and degrades a partially-constructed monitor to a no-op — so the `AttributeError: ... poll_interval` variant can no longer escape a polling-only patch.
- Routed every mach build dispatch — plain `fireforge build`, `build --ui` (`mach build faster`), and the pre-test build step of `fireforge test --build` — through one protected path (`runProtectedMachBuild`) with a **uniform recognized-crash retry budget** (default 2 retries, matching `--harness-retries`; the pre-test step forwards the operator's `--harness-retries` value). Each retry spawns a fresh mach process AND re-installs the guard (re-discovering venvs), so a venv materialized by a crashed first attempt is guarded on the next one instead of every retry dying on the same wedged state. Non-crash build failures are never retried; exhausted budgets surface the crash shape and evidence line above the regular diagnostics. The suite-specific test dispatches (`mach test` / `xpcshell-test` / `mochitest`) install the same guard.
- Investigated the field incident where a failed pre-test build was followed by a ~64-minute full rebuild: FireForge's protected path performs **no configure/clobber beyond what `mach build faster` itself does** (retries never re-run `prepareBuildEnvironment`/`mach configure`; there is no fallback-to-full-build in FireForge). The pre-test build now also passes the previous build baseline into `prepareBuildEnvironment` exactly like `fireforge build` does, so auto-configure runs under identical conditions on both paths instead of diverging.
- Fixed the sharded/retry crash classifier marking fully green runs as `CRASH (N attempts)`: a completed green embedded summary (a `TEST_START`/`TEST-START` execution signal, `Unexpected results: 0`, and `SUITE_END`) now **vetoes** signature-based crash classification for that attempt, and resource-monitor degradation lines (`UserWarning: psutil failed to run: ...`, `_collect failed: ...`, FireForge's own degradation notice) plus mach's caught telemetry tracebacks are stripped from crash evidence entirely. Exit codes follow the corrected verdict: a run whose every shard is green exits 0, and a non-sharded (`--no-shard`) run whose embedded summary completed green exits 0 even when mach's own exit code went non-zero on harness noise (a note explains the override) — parsing embedded summaries by hand is no longer necessary. Runs with a non-zero unexpected count or real `TEST-UNEXPECTED-*` lines still fail, and the post-green shutdown re-entry shape still classifies as a crash.
- Fixed `fireforge test <directory>` dispatching xpcshell-only directories to the mochitest runner ("could not find any mochitests under the following test path(s)"): the manifest walk now starts at the directory itself, so a directory whose own manifest is an `xpcshell.toml` dispatches to `mach xpcshell-test` just like an explicit `test_*.js` path.
- Added `fireforge register --create-manifest`: registering a module under a directory with no `moz.build` now scaffolds the directory manifest (MPL-header + `EXTRA_JS_MODULES.<namespace>` list) and wires the parent `DIRS` chain up to the nearest existing moz.build (creating intermediates); without the flag the "Manifest not found" error names it. Also added an **xpcshell test-file pattern** (`**/test_*.js` outside `browser/base/content/test/`) that inserts the `["test_*.js"]` section into the directory's `xpcshell.toml` in mozbuild sort order — or creates the manifest and wires `XPCSHELL_TESTS_MANIFESTS` with `--create-manifest` — and extended the browser-chrome manifest rule to fork-owned `browser.toml` manifests at **arbitrary depth** under `browser/base/content/test/` (previously one level only).
- Improved export ergonomics three ways: (1) `re-export <patch> --files` now accepts the `export`-style space-separated path shape — path-shaped extra positionals are folded into the file list with a notice, and the "operates on exactly one target patch" error explains both accepted forms (the dry-run "removed files (N; become unmanaged)" preview is unchanged); (2) directory exports auto-exclude files already owned by other patches, printing a per-file `Excluding <file> ... (owned by <patch>)` notice and a `re-export --files` pointer instead of hitting the duplicate-new-file-creation refusal at placement lint (whose message now recommends an explicit file list rather than `--force-unsafe`; explicitly named files are never auto-excluded); (3) `export --name 203-ui-foo --category ui` no longer produces `203-ui-203-ui-foo.patch` — a leading `NNN-<category>-` prefix matching the selected category is stripped from the name before the filename builders prepend order and category.
- Fixed `furnace deploy` leaving a stale toolkit `jar.mn` line after a component helper file rename (every build then failed at packaging with "File ... not found"): entry removal now keys on the `(widgets/<tag>/...)` source-mapping segment so ALL of a component's lines are removed regardless of basename, and the remove-then-re-add reconciliation therefore prunes renamed/removed helpers. `furnace validate` gained a `stale-jar-registration` error for registration lines pointing at files that no longer exist (`--fix` prunes them), and `doctor` gained a "Furnace jar.mn registrations" check (`--repair-furnace` prunes) — both previously reported success while the stale line survived.
- Added `furnace scan --track`, which persists every discovered untracked component into the `stock` section of furnace.json non-interactively (same locked, rollback-journaled write path as the interactive confirm flow). Scan's help and its non-interactive output now state that scan is report-only by default and where the inventory is consumed, ending the report-persist-nothing-explain-nothing behavior.
- Added `furnace chrome-doc create --browser-window`, a browser.xhtml-like scaffold for the document that ships as the fork's main browser window: `<html id="main-window">` root with the `windowtype="navigator:browser"`/`chromehidden`/geometry-`persist` attributes platform C++ reads before scripts run, while keeping the generic scaffold's bootstrap wiring, sentinel, and (already-correct) jar.mn registrations. When the target document matches a configured `tokenHostDocuments` entry and the flag was not passed, create warns that the browser-window variant is probably intended.
- Added `furnace create --test-dir <dir>` to redirect the `--with-tests` scaffold (browser-chrome and xpcshell styles) to any engine-relative directory under `browser/base/content/test/` — nested manifests register correctly — and made all test scaffolds collision-safe: existing `browser.toml`/`xpcshell.toml`/`chrome.toml` manifests are appended to (with a shared-manifest notice) instead of scaffolded over, and existing `head.js`/test implementation files are never overwritten.

## 0.33.0

- Fixed `furnace deploy`/`apply` to prune a dangling per-widget locale `jar.mn` entry for a `localized: true` widget that uses the `sharedFtl` browser-bundle convention. A stale `locale/@AB_CD@/toolkit/global/<name>.ftl` line (written by an older FireForge) pointed at a `.ftl` that never exists, so `mach build` failed hard (`Cannot find toolkit/global/<name>.ftl`) and blocked every build; apply now drops that per-widget line idempotently while leaving the shared bundle's own line untouched.
- Added `fireforge token add --variant '[data-skin=precision]'` (also `[data-private]`) to author a declaration inside an attribute-keyed `:root[<attr>]` block, creating the block if absent or appending to it if present — so skin/state token overrides no longer have to be hand-edited. The selector is validated and quoted-normalized, variant overrides are CSS-only (the base token owns its docs row), and `token coverage` still accepts the result.
- Fixed `fireforge register` to sort `EXTRA_JS_MODULES` (and the sibling sorted moz.build / jar.mn list helpers) **case-insensitively**, matching mozbuild's `UnsortedError` rule — so e.g. `AppearanceController.sys.mjs` lands before `AppMenuIntegration.sys.mjs` (`appe` < `appm`) instead of in raw byte order, which made `mach configure` abort. The build wrapper now runs `mach configure` with output capture and surfaces the underlying mozbuild error text (e.g. `UnsortedError`) instead of a bare "configure failed with exit code N".
- Changed `fireforge typecheck` to staleness-check and regenerate the Furnace-managed jsconfig (`furnace.json` → `typecheckJsconfig`) before running, using the same reconciler `furnace deploy`/`sync` use — so a stale generated `compilerOptions.paths` shim no longer reports phantom type errors in files the session never touched.
- Fixed `fireforge patch split --dry-run` projected lint to model the forward edge a split introduces into the freshly-created patch: it auto-declares the staged forward-import (the new patch's owner is known) so the dry-run diagnostics match the real `lint --per-patch --max-warnings 0` gate, and persists the declaration on commit so a sound split reads as sound instead of as a cross-patch "has no exported member" error.
- Fixed `fireforge test <one xpcshell .js>` to recognize the suite-specific xpcshell result-summary block (`TEST_END`, `Ran N checks`, `Unexpected results: 0`) as a valid execution signal. The post-run guard keyed only on `TEST-START` lines — which the xpcshell dispatch never prints — so a passing single-file xpcshell run was reported as "finished without starting any of the requested tests" and exited 1; it now exits 0 while a failing summary still flows to the failure diagnosis.
- Changed `fireforge build` / `build --ui` to inject a resource-monitor degrade shim (a `sitecustomize.py` on the mach subprocess `PYTHONPATH`) so a host `psutil.virtual_memory()` failure (`host_statistics64(HOST_VM_INFO64) syscall failed`) degrades to a non-fatal warning instead of aborting `mach build` / `mach build faster` in `start_resource_recording`. The build path no longer depends on which mach entry was used.
- Added per-project `typecheck.projectOverrides` so a project can override or opt out of the shared `extraShim` (`null` opts out, a path overrides). The composed shim is now built per project rather than injected identically everywhere, so a project that narrows `lib`/`types` (e.g. `lib: ["ES2024","DOM"]`) is not forced to absorb another project's Gecko declaration libraries (Element/Node identity splits, nsIPrincipal mismatch).

## 0.32.0

- Fixed `fireforge lint <files>` to evaluate the `large-patch-files` rule against each file's resolved owning patch instead of the ad-hoc file-list cardinality, so a cross-patch selection no longer synthesizes a phantom oversized patch (e.g. eight files across four patches no longer report `Patch affects 8 files` when no single owner exceeds the threshold). The size rules now run per owning patch — using its real `filesAffected` count, diff, and `tier` — and unowned files are evaluated together as one prospective new patch.
- Taught the ad-hoc `lint <files>` path to honour each file's owning-patch `lintIgnore`, so a check waived via `fireforge patch lint-ignore` is suppressed consistently across `lint <files>`, `lint --per-patch`, and `re-export --dry-run` — the three invocation modes now agree on the same warning set for the same files.
- Added `fireforge lint --per-patch --patches <name…>` to lint a named subset of the queue (matched by filename or manifest `name`) instead of forcing a full queue run to verify a few touched patches; queue-level policy and cross-patch findings are scoped to files the subset touches. The "`--per-patch` cannot be combined with explicit file paths" error now points at the flag.
- Rebuilt the per-patch `checkJs` pass to construct the queue-wide TypeScript program **once per `lint --per-patch` run** (lazily, on first cache miss) and attribute each finding to its owning patch, instead of rebuilding the whole-queue program for every patch — a single queue-wide type regression now surfaces once against its owner rather than duplicated once per patch, and full runs no longer pay to recompile the same program ~N times.
- Resolved cross-patch `resource:///` / `chrome://` imports during `export`/`re-export` lint by threading the whole-queue ownership context into the isolated patch's `checkJs` pass (the export/re-export half of the cross-patch resolution that 0.31.0 landed for the full-queue path), while scoping reported diagnostics to the patch under export. Re-exporting a widget-runtime patch whose module imports another patch's `resource:///` module now type-checks against the real owning sources **without** a hand-generated ambient `declare module` stub shim. `patchLint.checkJsCompilerOptions` additionally accepts a reviewed `paths` mapping (host-resolved against the engine directory, so no `baseUrl` is needed — TS5090-safe), and `extraShim` / `typecheck.extraShim` now inline triple-slash `/// <reference>` directives instead of silently dropping them at the synthetic shim path.
- Fixed `furnace sync` to emit `./`-prefixed relative `compilerOptions.paths` values (e.g. `./components/custom/moz-widget/moz-widget.mjs`) so a synced jsconfig type-checks under TypeScript without `baseUrl` (no TS5090) and without `ignoreDeprecations` on TS6 (no TS5101); the sync reconciler now treats a leading `./` as insignificant, so neither a freshly-synced value nor a hand-written prefix churns as "stale" on the next run. Removes the downstream `baseUrl: "."` + `ignoreDeprecations: "6.0"` workaround.
- Made `fireforge test` auto-dispatch a single-suite run to the suite-specific mach command (`mach xpcshell-test` / `mach mochitest`), which degrade a broken macOS mozlog resource monitor to a warning instead of crashing generic `mach test` at startup — so a sharded single-suite run reaches its tests instead of burning the whole `--harness-retries` budget on a startup traceback. Mixed runs are still rejected and a path-less "run all" stays on `mach test`; `--generic-mach-test` forces the generic command.
- Extended the harness-crash classifier and `--harness-retries` budget to cover the pre-test `--build` step, so `fireforge test --build` retries a `mach build faster` that dies with the same resource-monitor startup crash instead of hard-failing with a bare "Pre-test build failed". Non-crash build failures are not retried.

## 0.31.0

- Made `patch compact` range-aware: with `patchPolicy.ranges` configured, each category range compacts independently (anchored at its first occupied ordinal, treating reserved orders as non-gaps), so a mid-range gap under `allowGaps: false` can finally be closed without projecting patches across category boundaries. Reserved-range patches and out-of-range strays are left in place with a warning. Without ranges the historical whole-queue renumber from 1 is unchanged.
- Rewrote `stagedDependencies.forwardImports[].owner` references during every patch renumber (compact, reorder, placement export, rename) and in reorder's dry-run projection, so staged-dependency declarations survive renumbering instead of dangling and surfacing pre-existing forward imports as new errors. `patch delete` now warns when other patches still name the deleted patch as an owner.
- Added `fireforge patch split <source> --files <paths...> --name <name>` to move files out of a patch into a brand-new patch as one transaction: worktree-derived shrink of the source, new-patch creation with `--order`/`--before`/`--after` placement (default: after the source), and staged-dependency owner rewrites in dependent patches — validated against the final projection only, with dry-run support and reverse-order rollback. `patch move-files` now points at it for the move-to-new-patch case.
- Scoped plain `re-export --scan` to the patch's exact directory footprint: git pathspecs recurse, so a claimed file in a shallow directory used to sweep every unmanaged file in the subtree into the scan candidates of whichever patch was exported first. Deeper paths now require an explicit `--scan-file` / `--scan-files` assignment; the broad-scan confirmation guard is unchanged.
- Resolved imports of patch-owned modules to their real sources in the per-patch `checkJs` pass (unique-basename matching for `chrome://`/`resource://` specifiers, with a `.mjs` → `.sys.mjs` fallback), so JSDoc `value is …` type-guard predicates and `@template` generics survive module boundaries instead of degrading to `any`. Unknown or ambiguous specifiers keep the loose ambient-wildcard typing. Note: previously invisible cross-module type errors in patch-owned modules may now surface.
- Added `ChromeUtils.getClassName`, `ChromeUtils.defineLazyGetter`, and the `Localization` constructor to the shipped Firefox-globals typecheck shim, so per-patch lint accepts these stable chrome globals without local casts. Projects can still extend the ambient set via `patchLint.checkJsExtraShim` / `typecheck.extraShim`.
- Fixed the exported-method JSDoc `@param` extractor to scan balanced braces, so inline object types containing nested generics (e.g. `@param {{ id: string, args?: Record<string, string | number | boolean> }} message`) no longer fail `jsdoc-class-method-param-mismatch`; optional `[name]` and defaulted `[name=x]` forms now parse too.
- Rewrote the `observer-topic-naming` check to parse balanced multi-line call sites and inspect the actual topic argument (the second) instead of the first string literal on the line, and added a known-Firefox-topics allowlist (`idle-daily`, the `quit-application` family, lifecycle and `http-on-*` topics) so simulating upstream notifications in tests is never flagged. Constant-named topics remain exempt.
- Taught `fireforge test` to classify harness runs from their output instead of trusting exit codes or summary lines: recognized harness-crash shapes (macOS mozlog resource-monitor/psutil startup tracebacks, pre-test no-output hangs that still print `Passed: 0`, and post-green "Application shut down (without crashing) in the middle of a test!" re-entries after a focus stall) are retried with a bounded budget (`--harness-retries <n>`, default 2), and a zero-exit run with no `TEST-START` now fails instead of passing silently.
- Sharded multi-path `fireforge test` invocations into sequential single-file harness runs with per-shard retries, per-shard diagnosis, and an aggregate PASS/FAIL/CRASH summary, avoiding the cross-file profile/pref bleed that destabilized later files in combined runs. `--no-shard` restores the single combined invocation.
- Added `fireforge test --perf-samples <path>`, which publishes the resolved artifact path to the harness process as `<BINARYNAME>_PERF_SAMPLE_JSON` so downstream perf-budget checkers no longer maintain their own env contract.
- Fixed named `furnace deploy <component>` to run the same pipeline as deploy-all, so renaming or deleting a component file now prunes the stale engine copy, its `jar.mn` line, and (for a removed main module) the `customElements.js` registration, instead of leaving orphans a later re-export would capture. Unchanged components now skip instead of force-reapplying, and `furnace validate` flags engine-side orphans (`orphaned-engine-file`) left by pre-0.31.0 deploys.
- Added shared CSS fragments for Furnace widgets: a `/* @fireforge-include <fragment>.css */` directive in a widget stylesheet expands the named `components/shared/` fragment into the deployed copy (fenced, idempotent), keeping the workspace single-sourced across shadow-DOM-isolated widgets. Fragment edits surface as ordinary component drift and redeploy refreshes every consumer; `furnace validate` reports `missing-fragment` and `stale-fragment-expansion`.
- Added automatic jsconfig `paths` maintenance for multi-file components: with `furnace.json#typecheckJsconfig` set, deploy and sync keep `compilerOptions.paths` entries mapping each registered module's `chrome://global/content/elements/<file>.mjs` URL to its workspace source (no `baseUrl` needed), pruning entries for removed helpers and preserving all hand-written configuration; `furnace validate` reports drift as `jsconfig-paths-drift`.
- Fixed `token add` double-prefixing bare names that already start with the configured `tokenPrefix` text; such names are now treated as fully qualified with an informational note.
- Added `token add --create-category`, which declares the missing category banner inside the `:root` block and inserts the token in the same single write; the "Category not found" error now advertises the flag.
- Added two static release gates: `npm run deadcode:check` (knip, with a `knip.json` tuned to the project's entry points) fails on unused exports/files/dependencies, and `npm run cycles:check` (dpdm) fails on circular imports. Both run in `release:check` and the pre-push hook.
- Internalized 45 exports that had no consumers outside their defining module, and untangled the seven type-only import cycles (`BuildBaseline`, `RegisterResult`, `ResolvedTestStyle`, and `LintCommandOptions` moved to leaf/type modules) so the cycle gate starts from zero.
- Refactored the twelve functions with cyclomatic complexity above 30 (worst: `exportCommand` at 48) into focused helpers — behavior-preserving statement moves, verified by the existing suites — and now enforce `complexity: ["error", 30]` via ESLint. The long-standing `max-lines-per-function` suppression on `exportCommand` is gone with the split.
- Deduplicated four copied sequences: the patch-subcommand preamble (seven commands now share `requirePatchQueue`/`requirePatchTarget`), the changed-since-baseline collector (`build-audit`/`build-prepare`/`test-stale-check` share `collectChangedEnginePaths`), the export supersede+overlap gate (`export`/`export-all` share `runSupersedeAndOverlapGates`), and two same-file clones in `token-dark-mode.ts` and `config-validate-patch-policy.ts`.
- Restricted `process.exit()` to `bin/fireforge.ts` via lint (`no-restricted-properties`), turning the previously comment-enforced invariant into a build failure.
- Bumped the TypeScript `target`/`lib` from ES2022 to ES2023 (Node ≥ 22.22.1 fully implements it) and dropped the redundant `@typescript-eslint/eslint-plugin` / `@typescript-eslint/parser` devDependencies already provided by the `typescript-eslint` meta-package.

## 0.30.0

- Added safe repo-local per-patch lint result caching for `lint --per-patch`, plus `--no-cache` and `lint cache clear` escape hatches while preserving release-gate severity accounting and queue-wide checks. Warm cache hits now skip per-patch diff generation as well as lint rule execution, guarded by patch, config, engine content, queue ownership, and engine HEAD inputs.

## 0.29.0

- Improved `fireforge test --build` failure reporting so post-rebuild focused test failures name the rebuild command, requested paths, and first failure line separately from stale-artifact rebuild advice.

## 0.28.0

- Restored mach lint compatibility for FireForge-managed Git-backed Firefox checkouts by materializing a `.hgignore` copy of `.gitignore` when Firefox's ignorefile linter config is present.
- Added the product-resolved Firefox source archive URL to `source set` output so pinned checksums can be verified against the exact archive target before download.
- Added dry-run locking for `re-export` so parallel previews serialize engine git inspection instead of racing on `.git/index.lock`.
- Added `re-export --scan --scan-files <manifest>` for dry-runnable bulk generated-file assignment across owner patches, with ambiguity and ownership refusals.
- Improved `fireforge test` diagnostics for harness startup failures and zero selected tests run, including the actionable harness line before generic failure output.
- Improved build failure summaries so real make/mach failures and target context outrank trailing warning-only output.
- Normalized whitespace-only blank hunk payloads in generated patch artifacts while documenting `npm run whitespace:check` as the release-safe source whitespace gate.
- Fixed re-export serialization so blank context lines keep their unified-diff context marker, preventing FireForge-generated patches from producing false patch-owned drift warnings during `verify`.
- Fixed partial `re-export` manifest writes so legacy source metadata is preserved on unselected patch rows unless `--stamp` or another source metadata update explicitly targets them.
- Added regression coverage for targeted and full stamped re-export round-trips with blank context lines.

## 0.27.3

- Fixed `firefox-devedition` source downloads so archive resolution uses `/pub/devedition/releases`.
- Kept existing `engine/` trees intact during `download --force` until the replacement archive downloads, validates, and extracts successfully.
- Improved checksum mismatch diagnostics with resolved URL and product context.

## 0.27.0

- Added first-class `firefox-devedition` source support and atomic `fireforge source set`.
- Fixed `source set --version` so the subcommand accepts both space and equals forms without colliding with the root CLI version flag.
- Added `sourceProduct` and `sourceVersion` patch metadata while preserving `sourceEsrVersion` as a deprecated compatibility alias.
- Renamed source-rebase reporting away from ESR-only wording and clarified summaries with total patch counts.
- Unified status, ownership, doctor, and verify worktree classification, including an explained patch-owned drift state for manually resolved or re-exported files.
- Hardened build diagnostics so backend regeneration success/failure and failed make/mach commands include exit codes, tails, log hints, and verbose rerun suggestions.
- Improved `download --force` git indexing progress with phase, count, and heartbeat output.
- Added cache metadata progress for archive validation, SHA-256 calculation, and sidecar JSON writes.
- Added elapsed progress for extraction, initial source commits, and rebase/re-export patch refreshes.
- Added `re-export --files --allow-shrink` so patch ownership shrinkage is refused unless explicitly acknowledged, with clearer dry-run previews.
- Surfaced likely new sibling files during plain re-export and aligned verify/status ownership reporting for unowned worktree changes.
- Preserved patch-owned branding `configure.sh` settings during build preflight.
- Added custom element registration support for Furnace validate/apply and Firefox 152-style array-backed ESM registrations.
- Normalized generated patch artifacts so blank context lines do not trip raw whitespace checks.
- Improved rebase conflict summaries and added `doctor --post-rebase-audit` for common registration surfaces.

## 0.26.0

- Added targeted `re-export --scan --scan-file <path>` for reviewed single-patch new-file assignment without broad sibling collection.
- Added a FireForge-owned worktree whitespace gate that excludes generated `patches/*.patch` diff syntax from repository whitespace checks.
- Kept generated patch context lines unchanged while making release checks use the FireForge whitespace gate.

## 0.25.0

- Kept `MOZ_APP_VENDOR` in `browser/moz.configure` for Firefox ESR 140 project-flag trees instead of generated branding `configure.sh`.
- Added a regression for stale xpcshell install symlink repair under shared `_tests/testing/mochitest/` harness paths.

## 0.24.0

- Moved branding vendor identity into generated branding configure scripts and made `browser/moz.configure` vendor patching optional.
- Added metadata-backed staged forward-import declarations plus `patch staged-dependency` editing.
- Added stale xpcshell `_tests` symlink repair with a single safe retry.
- Added `patch move-files` for previewable ownership-transfer repair plans.
- Improved queue self-containment guidance for staged dependencies and patch repairs.

## 0.23.0

- Improved xpcshell test argument filtering and mixed-harness diagnostics.
- Locked pre-test build phases and improved stale harness diagnostics.
- Fixed binary-safe re-export for new untracked files.
- Improved additive `re-export --files` and lint warning guidance.

## 0.22.0

- Added `doctor --clear-resolution` with verify-backed safety checks.
- Shared patch queue health checks between `verify` and doctor recovery.
- Improved Furnace repair for empty custom orphan directories.
- Enforced patch policy during `patch compact`.
- Shortened README and changelog into maintainer-facing docs.

## 0.21.0

- Added chrome-doc dry-runs and cleanup.
- Added versioned `status --json` output.
- Added configurable patch queue policy.
- Hardened export, Furnace deploy, and UI build preflights.
- Improved Furnace rename, override removal, and interrupt diagnostics.

## 0.20.0

- Added pinned Firefox archive checksums.
- Added `fireforge patch compact`.
- Added Furnace xpcshell scaffolding.
- Locked download and archive-cache mutation paths.
- Hardened atomic writes, stale locks, and Furnace refresh.

## 0.19.0

- Added stricter patch `checkJs` options.
- Added ambient `resource:*` and `chrome:*` module shims.
- Fixed Mozilla licence-header detection.
- Fixed Marionette port forwarding for mixed test suites.
- Restored browser-chrome as the default Furnace test harness.

## 0.18.0

- Kept existing 0.17 patch queues compatible.
- Fixed aggregate lint and `export-all` directory crashes.
- Improved doctor ownership classification.
- Fixed localized Furnace remove and rename registration.
- Hardened Furnace concurrency, rollback, and validation paths.

## 0.17.0

- Improved fresh-project setup and branding output.
- Added `patch tier` and per-patch lint-ignore editing.
- Fixed `export-all` ownership and Furnace exclusion cases.
- Improved build, test, and status diagnostics.
- Cleaned up fork-specific examples.

## 0.16.0

- Hardened release and config security paths.
- Fixed `config --force` read/write behaviour.
- Improved download, status, and setup feedback.
- Added safer Furnace init, create, preview, and chrome-doc behaviour.
- Improved lint, build audit, and rebase reliability.

## 0.15.0

- Added `re-export --stamp` and per-patch lint ignores.
- Added `lint --per-patch`, `--since`, and introduced-only checks.
- Added xpcshell appdir handling and test diagnostics.
- Added `run --smoke-exit` for unattended chrome smoke checks.
- Expanded Furnace localisation, chrome-doc, build, and validation support.

## 0.14.0

- Made patch and state writes transactional.
- Hardened rebase, import, and download recovery.
- Improved Furnace apply, rename, deploy, diff, and validation.
- Added broader input validation across setup, config, wire, register, and test.
- Improved status output and watch/run preflights.

## 0.13.0

- Improved bootstrap checks after `mach bootstrap`.
- Added tiered lint severity for large files and patches.
- Added raw-colour allowlists and inline suppression.
- Added `fireforge patch compact`.
- Improved register support for XHTML, CSS, and clearer advice.

## 0.12.0

- Made JSDoc linting AST-based and stricter.
- Added optional patch-owned `checkJs`.
- Hardened path validation and symlink handling.
- Improved stale-lock recovery.
- Expanded forward-import detection and Furnace repair diagnostics.

## 0.11.0

- Added `verify`, `patch delete`, and `patch reorder`.
- Added export, import, status, and Furnace workflow flags.
- Expanded Furnace refresh, apply, remove, scan, diff, and status.
- Added cross-patch lint rules.
- Improved doctor, rollback, build preparation, and packaging reliability.

## 0.10.0

- Tightened patch export and re-export validation.
- Added raw-colour linting for patch diffs.
- Improved Furnace accessibility checks.
- Improved build-artifact and git failure handling.
- Updated package metadata and install guidance.

## 0.9.0

- Published the npm package.
