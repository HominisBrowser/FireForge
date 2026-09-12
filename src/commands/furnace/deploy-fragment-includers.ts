// SPDX-License-Identifier: EUPL-1.2
/**
 * Includer follow-up for a targeted `furnace deploy <tag>`.
 *
 * When `<tag>` includes a shared CSS fragment that changed, every other
 * deployed includer of that fragment still carries the old expansion after
 * the targeted deploy. Deploy-all refreshes all of them as a side effect of
 * deploying everything; the targeted form used to refresh exactly the named
 * component and say nothing about the rest. This module refreshes the other
 * stale includers through the same pipeline and reports them, so a stale
 * expansion is never left behind silently.
 */

import { getProjectPaths } from '../../core/config.js';
import { applyAllComponents, type ApplyAllComponentsResult } from '../../core/furnace-apply.js';
import type { FurnacePaths } from '../../core/furnace-config.js';
import {
  findStaleIncludersOfTargetFragments,
  type StaleFragmentIncluder,
} from '../../core/furnace-fragment-includers.js';
import type { FurnaceOperationContext } from '../../core/furnace-operation.js';
import {
  getPersistableAppliedEntry,
  persistSingleComponentState,
  shouldPersistSingleComponentState,
} from '../../core/furnace-state-persist.js';
import type { FurnaceConfig } from '../../types/furnace.js';

/** Outcome of the includer follow-up. */
export interface FragmentIncluderRefresh {
  /** Fragments `<tag>` includes that other deployed includers had stale. */
  fragments: string[];
  /** Includers applied cleanly (dry-run: the includers that would be). */
  refreshed: string[];
  /** Includers whose refresh reported errors or step failures. */
  failed: StaleFragmentIncluder[];
  /** One apply result per includer attempted (empty in dry-run). */
  results: ApplyAllComponentsResult[];
}

const EMPTY_REFRESH: FragmentIncluderRefresh = {
  fragments: [],
  refreshed: [],
  failed: [],
  results: [],
};

/**
 * Refreshes the other deployed includers of the fragments `name` includes
 * whose engine sheets are stale. Each includer is its own atomic unit:
 * `applyAllComponents` restores its own journal on failure, and its state
 * is persisted right after it succeeds, before the next includer starts.
 * Must be called only after the primary component's state is persisted,
 * so a signal mid-loop leaves every earlier unit committed and consistent.
 *
 * Dry-run computes the would-be set and applies nothing.
 */
export async function refreshStaleFragmentIncluders(args: {
  projectRoot: string;
  name: string;
  config: FurnaceConfig;
  furnacePaths: FurnacePaths;
  isDryRun: boolean;
  operationContext: FurnaceOperationContext;
}): Promise<FragmentIncluderRefresh> {
  const { projectRoot, name, config, furnacePaths, isDryRun, operationContext } = args;
  if (!(name in config.custom)) return EMPTY_REFRESH;

  const { stale } = await findStaleIncludersOfTargetFragments({
    targetTag: name,
    custom: config.custom,
    furnacePaths,
    engineDir: getProjectPaths(projectRoot).engine,
  });
  if (stale.length === 0) return EMPTY_REFRESH;

  const fragmentsWithStaleIncluders = [...new Set(stale.flatMap((s) => s.fragments))].sort();
  if (isDryRun) {
    return {
      fragments: fragmentsWithStaleIncluders,
      refreshed: stale.map((s) => s.tag),
      failed: [],
      results: [],
    };
  }

  const refreshed: string[] = [];
  const failed: StaleFragmentIncluder[] = [];
  const results: ApplyAllComponentsResult[] = [];
  for (const includer of stale) {
    const result = await applyAllComponents(projectRoot, false, {
      componentName: includer.tag,
      persistState: false,
      operationContext,
    });
    results.push(result);
    if (shouldPersistSingleComponentState(result, false)) {
      await persistSingleComponentState(
        projectRoot,
        getPersistableAppliedEntry('Deploy', includer.tag, result.applied[0]),
        furnacePaths
      );
      refreshed.push(includer.tag);
    } else {
      failed.push(includer);
    }
  }
  return { fragments: fragmentsWithStaleIncluders, refreshed, failed, results };
}

/**
 * Folds includer apply results into the primary result so the deploy
 * summary, the jsconfig sync gate and the failed-component set all see
 * them. An includer failure is a real apply error of this deploy: the
 * operator asked for a consistent engine. `rolledBack` stays the
 * primary's; an includer's rollback is already visible through its errors.
 */
export function mergeApplyResults(
  primary: ApplyAllComponentsResult,
  extras: readonly ApplyAllComponentsResult[]
): ApplyAllComponentsResult {
  if (extras.length === 0) return primary;
  const warnings = [primary, ...extras].flatMap((r) => r.warnings ?? []);
  const actions = [primary, ...extras].flatMap((r) => r.actions ?? []);
  const anyWarnings = [primary, ...extras].some((r) => r.warnings !== undefined);
  const anyActions = [primary, ...extras].some((r) => r.actions !== undefined);
  return {
    ...primary,
    applied: [...primary.applied, ...extras.flatMap((r) => r.applied)],
    skipped: [...primary.skipped, ...extras.flatMap((r) => r.skipped)],
    errors: [...primary.errors, ...extras.flatMap((r) => r.errors)],
    ...(anyWarnings ? { warnings } : {}),
    ...(anyActions ? { actions } : {}),
  };
}

function quoteList(items: readonly string[]): string {
  return items.map((item) => `"${item}"`).join(', ');
}

/**
 * Operator-facing lines for the includer follow-up: zero, one or two.
 * The second is the fallback for includers that could not be refreshed and
 * names the command that refreshes everything.
 */
export function formatFragmentIncluderNotice(
  refresh: FragmentIncluderRefresh,
  isDryRun: boolean
): string[] {
  const lines: string[] = [];
  if (refresh.refreshed.length > 0) {
    const n = refresh.refreshed.length;
    lines.push(
      `${isDryRun ? 'Would also refresh' : 'Also refreshed'} ${n} other includer${n === 1 ? '' : 's'} ` +
        `of ${quoteList(refresh.fragments)}: ${refresh.refreshed.join(', ')}.`
    );
  }
  if (refresh.failed.length > 0) {
    const n = refresh.failed.length;
    const fragments = [...new Set(refresh.failed.flatMap((f) => f.fragments))].sort();
    lines.push(
      `${n} other includer${n === 1 ? '' : 's'} of ${quoteList(fragments)} ` +
        `remain stale: ${refresh.failed.map((f) => f.tag).join(', ')}. ` +
        'Run `fireforge furnace deploy` (all).'
    );
  }
  return lines;
}
