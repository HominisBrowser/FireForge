// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COVERAGE_SUMMARY_PATH = resolve('coverage/coverage-summary.json');

const MODULE_THRESHOLDS = {
  'src/core/mach.ts': { lines: 95, branches: 88 },
  'src/cli.ts': { lines: 98, branches: 95, functions: 98 },
  'src/commands/setup.ts': { lines: 98, branches: 79 },
  'src/commands/setup-support.ts': { lines: 96, branches: 85 },
  'src/commands/token.ts': { lines: 98, branches: 76, functions: 98 },
  'src/commands/furnace/index.ts': { lines: 98, branches: 50, functions: 98 },
  'src/commands/furnace/validate.ts': { lines: 93, branches: 95 },
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
