// SPDX-License-Identifier: EUPL-1.2
import type { ApplyResult, ApplySkipKind, DryRunAction } from '../types/furnace.js';
import { error, info, success, warn } from '../utils/logger.js';

type ApplyResultWithActions = ApplyResult & { actions?: DryRunAction[] };

/** Summary label and per-component explanation for each skip kind. */
const SKIP_KIND_TEXT: Record<ApplySkipKind, { label: string; detail: string }> = {
  'already-current': {
    label: 'already current',
    detail:
      'already current: source unchanged since the last recorded apply (from any session) and the engine copy matches it',
  },
};

/** The per-component line text for one skip. */
function describeSkip(skipped: ApplyResult['skipped'][number]): string {
  return skipped.kind !== undefined ? SKIP_KIND_TEXT[skipped.kind].detail : skipped.reason;
}

/**
 * The reason breakdown appended to a "skipped N" summary, e.g.
 * ` (2 already current)`, so `Applied 0, skipped 1` says whether the
 * component was already current or skipped for another reason without
 * diffing the deployed files by hand. Empty when nothing was skipped.
 *
 * @param skipped - `result.skipped` from applyAllComponents
 * @returns The parenthesised breakdown with a leading space, or ''
 */
export function formatSkipBreakdown(skipped: ApplyResult['skipped']): string {
  if (skipped.length === 0) return '';
  const counts = new Map<string, number>();
  for (const entry of skipped) {
    const label = entry.kind !== undefined ? SKIP_KIND_TEXT[entry.kind].label : entry.reason;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return ` (${[...counts].map(([label, count]) => `${count} ${label}`).join(', ')})`;
}

/**
 * Prints a standard summary of an apply result for both normal and dry-run flows.
 *
 * Dry-run output lists the planned actions collected by the apply helpers.
 * Normal output lists applied files, skipped components, and any step errors.
 * Errors are always printed after the main body.
 *
 * @param result - Result returned by applyAllComponents
 * @param isDryRun - Whether apply was invoked with dryRun=true
 */
export function logApplyResult(result: ApplyResultWithActions, isDryRun: boolean): void {
  if (isDryRun && result.actions && result.actions.length > 0) {
    info('Planned actions:');
    for (const action of result.actions) {
      info(`  [${action.action}] ${action.component}: ${action.description}`);
    }
  } else if (isDryRun) {
    info('No actions would be performed.');
  } else if (result.rolledBack) {
    // When the rollback journal was restored, entries in `applied` reflect
    // what was attempted but no longer exists in the engine. Print them as
    // "attempted" rather than "success" to avoid misleading the operator.
    if (result.applied.length > 0) {
      warn('The following components were applied but have been rolled back due to errors:');
      for (const applied of result.applied) {
        warn(`  ${applied.name} (${applied.type}) — rolled back`);
        if (applied.stepErrors && applied.stepErrors.length > 0) {
          for (const stepErr of applied.stepErrors) {
            warn(`    ${applied.name}: [${stepErr.step}] ${stepErr.error}`);
          }
        }
      }
    }
  } else {
    for (const applied of result.applied) {
      success(`${applied.name} (${applied.type}) → ${applied.filesAffected.length} files`);
    }

    for (const skipped of result.skipped) {
      info(`${skipped.name} — ${describeSkip(skipped)}`);
    }

    for (const applied of result.applied) {
      if (applied.stepErrors && applied.stepErrors.length > 0) {
        for (const stepErr of applied.stepErrors) {
          const advisoryPrefix = stepErr.advisory === true ? '(advisory) ' : '';
          warn(`${applied.name}: ${advisoryPrefix}[${stepErr.step}] ${stepErr.error}`);
        }
      }
    }
  }

  // Patch-owned overwrite warnings print on every non-dry-run
  // outcome, including the rolled-back branch, where the overwrite
  // happened before the rollback restored it and the operator still needs
  // to know the deployed copy was momentarily replaced.
  if (!isDryRun) {
    logApplyWarnings(result.warnings);
  }

  for (const err of result.errors) {
    error(`${err.name} — ${err.error}`);
  }
}

/**
 * Prints the operator-facing apply warnings (patch-owned overwrites) one
 * per line and returns how many were printed. Shared by `furnace apply`
 * and the pre-build source → engine sync, so a warning the apply computed
 * is never dropped on one path and printed on the other.
 *
 * @param warnings - `result.warnings` from applyAllComponents
 * @returns Number of warning lines printed
 */
export function logApplyWarnings(warnings: readonly string[] | undefined): number {
  if (warnings === undefined) return 0;
  for (const line of warnings) {
    warn(line);
  }
  return warnings.length;
}
