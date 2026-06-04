# Changelog

## 0.28.0

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
