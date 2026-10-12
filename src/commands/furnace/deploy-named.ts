// SPDX-License-Identifier: EUPL-1.2
/**
 * Targeted `furnace deploy <name>...`: one or more named components applied
 * under ONE furnace lock hold.
 *
 * Deploying a set of widgets one invocation at a time put every call at the
 * back of the engine-lock queue, so a forty-widget deploy waited forty
 * times. Naming them together waits once. Each named component is still its
 * own atomic unit (applied, then its state persisted, before the next one
 * starts), exactly as a single-name deploy, so a failure or signal midway
 * leaves every earlier component committed and consistent.
 */

import { applyAllComponents, type ApplyAllComponentsResult } from '../../core/furnace-apply.js';
import type { FurnacePaths } from '../../core/furnace-config.js';
import type { FurnaceOperationContext } from '../../core/furnace-operation.js';
import {
  getPersistableAppliedEntry,
  persistSingleComponentState,
  shouldPersistSingleComponentState,
} from '../../core/furnace-state-persist.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import {
  type FragmentIncluderRefresh,
  mergeApplyResults,
  refreshStaleFragmentIncluders,
} from './deploy-fragment-includers.js';

/** Outcome of {@link deployNamedComponents}. */
export type NamedDeployOutcome =
  | { kind: 'stock'; stock: string[] }
  | {
      kind: 'result';
      result: ApplyAllComponentsResult;
      includers: FragmentIncluderRefresh;
      /** Named entries that are stock (warned about, never applied). */
      stock: string[];
      /** Named entries that are overrides or custom components, in order. */
      deployed: string[];
    };

/**
 * Splits the requested names into deployable and stock entries, refusing
 * the whole invocation before any write when one is unknown. Duplicates
 * are dropped, keeping the first occurrence.
 */
function partitionDeployNames(
  names: readonly string[],
  config: FurnaceConfig
): { deployable: string[]; stock: string[] } {
  const deployable: string[] = [];
  const stock: string[] = [];
  for (const name of new Set(names)) {
    if (name in config.overrides || name in config.custom) deployable.push(name);
    else if (config.stock.includes(name)) stock.push(name);
    else throw new FurnaceError(`Component "${name}" not found in furnace.json.`, name);
  }
  return { deployable, stock };
}

/** Folds several includer refreshes into one, without repeating a tag. */
function mergeIncluderRefreshes(
  refreshes: readonly FragmentIncluderRefresh[],
  named: ReadonlySet<string>
): FragmentIncluderRefresh {
  // A named component is reported as deployed in its own right, never as
  // an includer some other named component refreshed on its behalf.
  const refreshed = [...new Set(refreshes.flatMap((r) => r.refreshed))].filter(
    (tag) => !named.has(tag)
  );
  return {
    fragments: [...new Set(refreshes.flatMap((r) => r.fragments))].sort(),
    refreshed,
    failed: refreshes.flatMap((r) => r.failed).filter((f) => !named.has(f.tag)),
    results: refreshes.flatMap((r) => r.results),
  };
}

/**
 * Applies each named override or custom component through the same
 * pipeline as deploy-all (`applyAllComponents` with a `componentName`
 * filter), persisting each one's state right after it applies cleanly.
 * Only then are the other stale includers of the fragments the cleanly
 * applied components include refreshed, so an includer that is itself
 * named is applied once, as a named component.
 *
 * Must run inside one `runFurnaceMutation` so the whole set shares a single
 * lock hold.
 */
export async function deployNamedComponents(args: {
  projectRoot: string;
  names: readonly string[];
  config: FurnaceConfig;
  furnacePaths: FurnacePaths;
  isDryRun: boolean;
  operationContext: FurnaceOperationContext;
}): Promise<NamedDeployOutcome> {
  const { projectRoot, names, config, furnacePaths, isDryRun, operationContext } = args;
  const { deployable, stock } = partitionDeployNames(names, config);
  if (deployable.length === 0) return { kind: 'stock', stock };

  const results: ApplyAllComponentsResult[] = [];
  const clean: string[] = [];
  for (const name of deployable) {
    const result = await applyAllComponents(projectRoot, isDryRun, {
      componentName: name,
      persistState: false,
      operationContext,
    });
    results.push(result);
    // Each named deploy is atomic: state is persisted only when every apply
    // step succeeded, and any rollback has already restored the engine.
    if (shouldPersistSingleComponentState(result, isDryRun)) {
      await persistSingleComponentState(
        projectRoot,
        getPersistableAppliedEntry('Deploy', name, result.applied[0]),
        furnacePaths
      );
      clean.push(name);
    } else if (isDryRun) {
      clean.push(name);
    }
  }

  // Other deployed includers of a fragment these components include would
  // otherwise keep a stale expansion. Only after a clean, persisted apply
  // (dry-run always previews).
  const refreshes: FragmentIncluderRefresh[] = [];
  for (const name of clean) {
    refreshes.push(
      await refreshStaleFragmentIncluders({
        projectRoot,
        name,
        config,
        furnacePaths,
        isDryRun,
        operationContext,
      })
    );
  }
  const includers = mergeIncluderRefreshes(refreshes, new Set(deployable));
  const [first, ...rest] = results;
  // `deployable` is non-empty, so `first` is always set.
  const primary = first as ApplyAllComponentsResult;
  return {
    kind: 'result',
    result: mergeApplyResults(primary, [...rest, ...includers.results]),
    includers,
    stock,
    deployed: deployable,
  };
}
