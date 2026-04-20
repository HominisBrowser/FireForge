// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COVERAGE_SUMMARY_PATH = resolve('coverage/coverage-summary.json');

const MODULE_THRESHOLDS = {
  'src/core/mach.ts': { lines: 95, branches: 88 },
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
    if (entryPath.replace(/\\/g, '/').endsWith(normalizedPath)) {
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
