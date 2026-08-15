// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COVERAGE_SUMMARY_PATH = resolve('coverage/coverage-summary.json');

const MODULE_THRESHOLDS = {
  'src/core/mach.ts': { lines: 95, branches: 88 },
  // 0.41.0 K-wave modules (FORGE K1/K2/K8/K9/K10) — pinned just below
  // their landing coverage.
  'src/utils/concurrency.ts': { lines: 100, branches: 90, functions: 100 },
  // Identity must degrade to the plain semver, never throw — the guarded
  // fallbacks are the point of the module.
  'src/utils/build-info.ts': { lines: 90, branches: 80, functions: 100 },
  'src/commands/status-json.ts': { lines: 95, branches: 80 },
  // 0.41.0 L-wave modules (FORGE L1/L3) — pinned just below landing
  // coverage. The extend anchor is the fail-closed guard for a coverage
  // claim, so every refusal branch must stay exercised.
  'src/core/coverage-extend.ts': { lines: 95, branches: 85 },
  'src/commands/status-ownership.ts': { lines: 95, branches: 85 },
  'src/commands/export-placement-conflicts.ts': { lines: 95, branches: 80 },
  'src/commands/patch/staged-dependency-validate.ts': { lines: 95, branches: 85 },
  // 0.31.0 modules — pinned just below their landing coverage so
  // regressions surface without blocking unrelated refactors.
  'src/core/test-harness-crash.ts': { lines: 98, branches: 90 },
  'src/core/furnace-css-fragments.ts': { lines: 96, branches: 78 },
  'src/core/furnace-jsconfig.ts': { lines: 89, branches: 78 },
  'src/core/patch-lint-observer.ts': { lines: 94, branches: 85 },
  'src/commands/test-run.ts': { lines: 94, branches: 75 },
  'src/commands/test-diagnose.ts': { lines: 92, branches: 85 },
  // 0.41.0: the verdict sink is tiny and fully unit-tested; hold it there.
  'src/commands/test-verdict.ts': { lines: 100, branches: 100 },
  // The command body's uncovered ranges are the under-lock rollback warns
  // and the commander registration block; the planning logic carries the
  // higher split-plan.ts thresholds.
  'src/commands/patch/split.ts': { lines: 78, branches: 64 },
  'src/commands/patch/split-plan.ts': { lines: 89, branches: 78 },
  'src/cli.ts': { lines: 98, branches: 88, functions: 98 },
  'src/commands/setup.ts': { lines: 98, branches: 79 },
  'src/commands/setup-support.ts': { lines: 96, branches: 85 },
  'src/commands/token.ts': { lines: 98, branches: 76, functions: 98 },
  'src/commands/furnace/index.ts': { lines: 98, branches: 50, functions: 98 },
  // The remaining branch gap (~5% from 94.36 → 95) is the defensive
  // `else { continue; }` in `reValidateComponents` for componentNames that
  // are neither in `config.overrides` nor `config.custom`. The fixable-issue
  // set (`missing-jar-mn-mjs`, `missing-jar-mn-css`) does not emit issues
  // for stock components, so that branch is functionally unreachable; it is
  // retained for defence-in-depth against a future invariant change.
  'src/commands/furnace/validate.ts': { lines: 93, branches: 94 },
  // Pure re-export barrel: V8 reports no executable lines, so only require a tracked coverage entry.
  'src/core/furnace-validate-checks.ts': {},
  'src/core/furnace-validate-registration.ts': { lines: 94, branches: 75 },
  'src/core/furnace-registration-ast.ts': { lines: 89, branches: 75 },
  'src/core/furnace-rollback.ts': { lines: 95, branches: 80 },
  'src/core/wire-init.ts': { lines: 95, branches: 79 },
  'src/core/wire-subscript.ts': { lines: 98, branches: 80 },
  'src/core/patch-export.ts': { lines: 93, branches: 75 },
  'src/utils/logger.ts': { lines: 95, branches: 76, functions: 95 },
  // 2026-07-05 review remediation: the fuzz path is now exercised against a
  // REAL git binary (the mocked tests had validated impossible behavior),
  // and the two furnace state/step-error modules own the invariants whose
  // divergence caused the named-apply state wipe and the rollback-contract
  // drift. Pins keep those regression nets from silently thinning.
  'src/core/patch-apply-fuzz.ts': { lines: 90, branches: 80, functions: 100 },
  'src/core/furnace-state-persist.ts': { lines: 80, branches: 70, functions: 100 },
  'src/core/furnace-step-errors.ts': { lines: 100, branches: 95, functions: 100 },
  'src/core/patch-artifact-normalize.ts': { lines: 100, branches: 95, functions: 100 },
  'src/utils/platform.ts': { lines: 100, branches: 100, functions: 100 },
  'src/core/register-browser-content.ts': { lines: 98, branches: 94 },
  'src/core/register-shared-css.ts': { lines: 98, branches: 94 },
  'src/core/manifest-rules.ts': { lines: 98, branches: 98 },
  'src/commands/run.ts': { lines: 95, branches: 86 },
  'src/core/wire-dom-fragment.ts': { lines: 93, branches: 82 },
  'src/commands/furnace/override.ts': { lines: 98, branches: 98 },
  // Pure pattern-based error-hint translator — trivially testable.
  'src/core/mach-error-hints.ts': { lines: 100, branches: 95, functions: 100 },
  // Post-build audit (warn-only) — critical because misdetections here
  // cause noisy warnings on every successful build.
  'src/core/build-audit.ts': { lines: 88, branches: 75 },
  // Shared "what changed since the last build" collector behind the
  // audit, auto-configure, and stale-build preflights. Small and fully
  // exercised through all three consumers (measured 100/90/100); a drop
  // below the pin means one of those probe paths lost its coverage.
  'src/core/engine-changes.ts': { lines: 95, branches: 85, functions: 100 },
  // Shared patch-command preamble (queue load + identifier resolve).
  // Direct unit tests pin the error wording every patch subcommand
  // surfaces (measured 100/100/100).
  'src/commands/patch/patch-context.ts': { lines: 95, branches: 95, functions: 100 },
  // Audit helpers — pure path-resolution and Python-style moz.build
  // gate detection. Both are easy to unit-test exhaustively.
  'src/core/build-audit-resolve.ts': { lines: 90, branches: 80 },
  'src/core/build-audit-platform.ts': { lines: 88, branches: 80 },
  // Registration-aware artifact resolver — walks jar.mn ancestors to
  // disambiguate same-basename collisions across unrelated subtrees.
  'src/core/build-audit-registration.ts': { lines: 95, branches: 85 },
  // Known source→chrome packaging transforms used when no jar.mn
  // `(source)` annotation is available. Pure path rewriting + dist probe.
  'src/core/build-audit-transforms.ts': { lines: 95, branches: 85, functions: 100 },
  // Build-artifact preflight + mozinfo rewriter. Coverage for the
  // rewriter lives in `mach-mozinfo-rewrite.test.ts` (real fs) because
  // the `mach.test.ts` suite mocks `utils/fs.js` module-wide.
  'src/core/mach-build-artifacts.ts': { lines: 90, branches: 80 },
  // Build baseline marker — tiny file, easy to hit high coverage.
  'src/core/build-baseline.ts': { lines: 95, branches: 85 },
  // Patch-aware discard planner (FORGE F1, P0 data loss): the restore-target
  // decision must stay exhaustively covered — a misclassified plan reverts a
  // patch-backed file past its owning patch.
  'src/core/discard-baseline.ts': { lines: 90, branches: 80, functions: 90 },
  // Per-patch moz.build sorted-list check (FORGE F2) — pure parser. The
  // uncovered branches are defensive nullish fallbacks on regex captures.
  'src/core/patch-lint-mozbuild.ts': { lines: 95, branches: 78 },
  // Stale-build preflight for `fireforge test`. Pure git + path-filter
  // wrapper; broken probes must never fail-open-as-stale so the defensive
  // branches are exhaustively exercised.
  'src/core/test-stale-check.ts': { lines: 90, branches: 75, functions: 100 },
  // Lint diff-scoping helper — pure filtering + git integration.
  'src/core/patch-lint-diff-tag.ts': { lines: 95, branches: 80 },
  // Chrome-doc scaffolder — transactional, journal-backed.
  'src/commands/furnace/chrome-doc.ts': { lines: 88, branches: 78 },
  // Chrome-doc templates — pure string assembly.
  'src/commands/furnace/chrome-doc-templates.ts': { lines: 100, branches: 95, functions: 100 },
  // Chrome-doc packaging-verification test templates — pure string
  // assembly; every branch is exercised by the unit tests.
  'src/commands/furnace/chrome-doc-tests.ts': { lines: 100, branches: 95, functions: 100 },
  // MochiKit scaffolder — mirrors the xpcshell scaffolder shape.
  'src/commands/furnace/create-mochikit.ts': { lines: 95, branches: 80 },
  // Dry-run + success-note formatter for `furnace create` — pure string
  // assembly, exhaustively exercisable.
  'src/commands/furnace/create-dry-run.ts': { lines: 95, branches: 85, functions: 100 },
  // xpcshell appdir auto-injection — the resolver shapes the `--app-path`
  // arg passed verbatim to mach test, so a regression here re-breaks
  // every rebranded fork's xpcshell suite. Real-fs unit tests cover both
  // happy path and the four "skip" outcomes.
  'src/core/xpcshell-appdir.ts': { lines: 90, branches: 85, functions: 100 },
  // Override refresh merge semantics — fatal `git merge-file` exits must
  // never be surfaced as ordinary conflict counts.
  'src/core/furnace-refresh.ts': { lines: 95, branches: 85, functions: 100 },
  // Patch queue renumbering — destructive manifest/filesystem mutation.
  'src/commands/patch/compact.ts': { lines: 88, branches: 75, functions: 85 },
  // xpcshell scaffold rename — filesystem rewrite helper for component rename.
  'src/commands/furnace/rename-xpcshell.ts': { lines: 100, branches: 80, functions: 100 },
  // 0.35.0 edge modules — previously masked by the global threshold.
  // Signal-deferred critical sections: the SIGINT/SIGTERM exit path
  // depends on this registry behaving exactly as specified.
  'src/core/signal-critical.ts': { lines: 98, branches: 95, functions: 80 },
  // Bootstrap output pattern scanner + SDK-probe branching.
  'src/commands/bootstrap-checks.ts': { lines: 95, branches: 90, functions: 95 },
  // Destructive command: directory-recursion fallback, batch partial
  // failures, and the Furnace-managed warnings must stay exercised.
  'src/commands/discard.ts': { lines: 92, branches: 80, functions: 85 },
  // Furnace compatibility validation incl. compose/CSS hygiene warnings.
  'src/core/furnace-validate-compatibility.ts': { lines: 94, branches: 88, functions: 95 },
  // Tar extraction preflight — rejects traversal names and escaping links.
  'src/core/firefox-extract.ts': { lines: 90, branches: 85, functions: 85 },
  // 0.41.0 quality-survey remediation. These four sit on destructive or
  // verdict-blessing paths and had NO pin at all: with 314 files diluting the
  // global aggregate, a refactor could drop any of them 15 points and
  // `release:check` would still pass. Pinned just below landing coverage.
  //
  // Process-liveness primitives. `isProcessAlive` must keep treating EPERM as
  // ALIVE — two copies read it as "dead" before 0.41.0 and both gated an
  // `rm -rf`. Kept at 100 because the module is tiny and pure.
  'src/utils/errors.ts': { lines: 100, branches: 95, functions: 100 },
  // Tree clone removal: `inspectTreeLock` gates `rm -rf` of a full project
  // clone in `removeTree`.
  'src/core/tree-store.ts': { lines: 92, branches: 84 },
  // `doctor --repair-furnace` deletes the furnace lock directory. Had no test
  // file whatsoever before 0.41.0 (measured 78.9/69.9 → 83.9/74.0).
  'src/commands/doctor-furnace.ts': { lines: 82, branches: 72 },
  // Engine generation guard: decides whether a test verdict is trustworthy.
  // The suite bypasses the lock by default, so its own tests are the only
  // exercise this module gets (measured 75.0/72.2 → 92.3/81.8).
  'src/core/engine-session-lock.ts': { lines: 90, branches: 80 },
  // Severity resolution for every doctor check — one resolver shared by
  // `doctor.ts` and `bootstrap.ts`, which disagreed before 0.41.0.
  'src/commands/doctor-check-core.ts': { lines: 100, branches: 95, functions: 100 },
  // 0.41.0 quality-survey backfill. Each of these was a coverage outlier with
  // no pin, so the global aggregate could not see a regression in it.
  //
  // Pure config validator with zero I/O that runs on EVERY config load, and
  // had no test file importing it at all (was 10.5% line / 4.5% branch).
  'src/core/config-validate-test-toolchains.ts': { lines: 98, branches: 95, functions: 100 },
  // Commander wiring for `fireforge test`. Was 13.3% line / 0% branch: the
  // registration ran during help tests but no argParser callback or action
  // body was ever invoked. The two numeric flags must keep rejecting
  // out-of-range input through commander's invalid-argument channel.
  'src/commands/test-register.ts': { lines: 95, branches: 90, functions: 100 },
  // Stale jar.mn registration check (0.34.0 field report: --repair-furnace
  // reported success without pruning). Was 56.3 / 33.3.
  'src/commands/doctor-furnace-jar.ts': { lines: 95, branches: 90, functions: 100 },
  // Deletes engine sources and rewrites three jar manifests. Had the worst
  // branch coverage in the repo (86.1 / 51.2) because the only tests were
  // happy-path round trips; the refusal, cancel, idempotent-re-remove and
  // rollback arms were all dark.
  'src/commands/furnace/chrome-doc-remove.ts': { lines: 95, branches: 85, functions: 100 },
  // The two furnace mutators the survey called "the clearest risk
  // concentration in the corpus": both delete engine files, and both were the
  // weakest-tested commands in their own subsystem. Pinned so the §6 cap
  // extractions cannot silently thin the nets that now guard them.
  // remove.ts was 75.9 / 73.6; refresh.ts was 79.9 / 70.9.
  'src/commands/furnace/remove.ts': { lines: 96, branches: 84, functions: 100 },
  'src/commands/furnace/refresh.ts': { lines: 94, branches: 88, functions: 100 },
  // `tree remove --all` deletes whole cloned trees and `tree exec` spawns the
  // CLI inside one; `treeExecCommand` was entirely untested (was 61.7 / 60.5).
  'src/commands/tree.ts': { lines: 94, branches: 92 },
  // The ftlBasePath shape probe was unreachable in the all-mocked suite
  // because it only runs when engine/ exists (was 73.5 / 74.6).
  'src/commands/furnace/init.ts': { lines: 90, branches: 90 },
};

function loadCoverageSummary() {
  return JSON.parse(readFileSync(COVERAGE_SUMMARY_PATH, 'utf8'));
}

function findCoverageEntry(summary, modulePath) {
  if (summary[modulePath]) {
    return summary[modulePath];
  }

  const normalizedPath = modulePath.replace(/\\/g, '/');

  for (const [entryPath, entry] of Object.entries(summary)) {
    const normalizedEntry = entryPath.replace(/\\/g, '/');
    // Require a path-separator boundary: a bare endsWith could bind
    // 'core/git.ts' to an unrelated '.../not-core/git.ts'-shaped entry
    // whose path merely ends with the same characters.
    if (normalizedEntry === normalizedPath || normalizedEntry.endsWith(`/${normalizedPath}`)) {
      return entry;
    }
  }

  return null;
}

function formatThresholdFailure(modulePath, metric, actual, minimum) {
  return `${modulePath}: ${metric} coverage ${actual.toFixed(2)}% is below ${minimum}%`;
}

function checkMetric(failures, modulePath, entry, metric, minimum) {
  if (minimum === undefined) {
    return;
  }

  if (entry[metric].pct < minimum) {
    failures.push(formatThresholdFailure(modulePath, metric, entry[metric].pct, minimum));
  }
}

function main() {
  const summary = loadCoverageSummary();
  const failures = [];

  for (const [modulePath, thresholds] of Object.entries(MODULE_THRESHOLDS)) {
    const entry = findCoverageEntry(summary, modulePath);

    if (!entry) {
      failures.push(`${modulePath}: coverage entry not found in ${COVERAGE_SUMMARY_PATH}`);
      continue;
    }

    checkMetric(failures, modulePath, entry, 'lines', thresholds.lines);
    checkMetric(failures, modulePath, entry, 'branches', thresholds.branches);
    checkMetric(failures, modulePath, entry, 'functions', thresholds.functions);
  }

  if (failures.length > 0) {
    console.error('Critical module coverage checks failed:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Critical module coverage checks passed.');
}

main();
