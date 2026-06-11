# Changelog

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
