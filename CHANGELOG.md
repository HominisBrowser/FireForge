# Changelog

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
