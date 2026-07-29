// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COVERAGE_SUMMARY_PATH = resolve('coverage/coverage-summary.json');

const MODULE_THRESHOLDS = {
  'src/core/mach.ts': { lines: 95, branches: 88 },
  // 0.31.0 modules — pinned just below their landing coverage so
  // regressions surface without blocking unrelated refactors.
  'src/core/test-harness-crash.ts': { lines: 98, branches: 90 },
  'src/core/furnace-css-fragments.ts': { lines: 96, branches: 78 },
  'src/core/furnace-jsconfig.ts': { lines: 89, branches: 78 },
  'src/core/patch-lint-observer.ts': { lines: 94, branches: 85 },
  'src/commands/test-run.ts': { lines: 94, branches: 75 },
  'src/commands/test-diagnose.ts': { lines: 92, branches: 85 },
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
