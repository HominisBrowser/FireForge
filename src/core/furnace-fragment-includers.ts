// SPDX-License-Identifier: EUPL-1.2
/**
 * Reverse index from shared CSS fragments to the custom components that
 * include them, plus the staleness probe a targeted `furnace deploy <tag>`
 * runs over the OTHER includers of the fragments it just refreshed.
 *
 * Fragment staleness was only ever a validator finding
 * (`stale-fragment-expansion` in {@link validateCssFragments}), printed per
 * includer by `furnace validate` and `deploy --dry-run`. A targeted deploy
 * validates only the component it was asked for, so the one command that
 * changes a fragment's deployed state for SOME includers is the one that
 * never mentioned the rest: after a fragment edit, `deploy <a> <b>` left
 * every other consumer carrying the old expansion, and nothing said so
 * until a `grep` over the engine found it.
 *
 * Only custom components are indexed. Override components are copied
 * byte-for-byte and never expand fragments.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CustomComponentConfig } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import type { FurnacePaths } from './furnace-config.js';
import {
  extractExpandedFragmentBodies,
  listFragmentIncludes,
  readFragmentSource,
} from './furnace-css-fragments.js';

/** One includer whose deployed sheets carry a stale expansion. */
export interface StaleFragmentIncluder {
  /** Custom component tag. */
  tag: string;
  /** Fragments (relative to `components/shared/`) whose expansion is stale. */
  fragments: string[];
}

/** Workspace `.css` sheets of one custom component, with their includes. */
async function listComponentSheetIncludes(
  componentDir: string
): Promise<Array<{ fileName: string; includes: string[] }>> {
  if (!(await pathExists(componentDir))) return [];
  let entries: string[];
  try {
    entries = await readdir(componentDir);
  } catch {
    // An unreadable component directory includes nothing. Same degradation
    // as validateCssFragments: the index must never crash a deploy.
    return [];
  }
  const sheets: Array<{ fileName: string; includes: string[] }> = [];
  for (const fileName of entries.sort()) {
    if (!fileName.endsWith('.css')) continue;
    const includes = listFragmentIncludes(await readText(join(componentDir, fileName)));
    if (includes.length > 0) sheets.push({ fileName, includes });
  }
  return sheets;
}

/**
 * Maps every fragment name to the custom tags whose workspace sheets
 * include it.
 *
 * @param customDir - `components/custom/` directory
 * @param custom - The `custom` map from furnace.json
 */
export async function collectFragmentIncluders(
  customDir: string,
  custom: Readonly<Record<string, CustomComponentConfig>>
): Promise<Map<string, Set<string>>> {
  const index = new Map<string, Set<string>>();
  for (const tag of Object.keys(custom).sort()) {
    for (const sheet of await listComponentSheetIncludes(join(customDir, tag))) {
      for (const fragment of sheet.includes) {
        const tags = index.get(fragment) ?? new Set<string>();
        tags.add(tag);
        index.set(fragment, tags);
      }
    }
  }
  return index;
}

/**
 * Finds the other DEPLOYED includers of the fragments `targetTag` includes
 * whose engine sheets do not carry the current fragment source.
 *
 * Only fragments the target includes are considered: a fragment unrelated
 * to this deploy is not its business. An includer whose engine sheet does
 * not exist is not deployed and is skipped. A deployed sheet with no
 * expansion at all counts as stale, the same rule `validateCssFragments`
 * applies.
 *
 * @returns The fragments the target includes, and the stale includers
 *   (sorted by tag), each naming the fragments that are stale for it
 */
export async function findStaleIncludersOfTargetFragments(args: {
  targetTag: string;
  custom: Readonly<Record<string, CustomComponentConfig>>;
  furnacePaths: FurnacePaths;
  engineDir: string;
}): Promise<{ fragments: string[]; stale: StaleFragmentIncluder[] }> {
  const { targetTag, custom, furnacePaths, engineDir } = args;
  const index = await collectFragmentIncluders(furnacePaths.customDir, custom);
  const fragments = [...index]
    .filter(([, tags]) => tags.has(targetTag))
    .map(([fragment]) => fragment)
    .sort();
  if (fragments.length === 0) return { fragments, stale: [] };

  const targetFragments = new Set(fragments);
  const sources = new Map<string, string>();
  const stale: StaleFragmentIncluder[] = [];

  for (const tag of Object.keys(custom).sort()) {
    if (tag === targetTag) continue;
    const componentConfig = custom[tag];
    if (!componentConfig) continue;
    const engineTargetDir = join(engineDir, componentConfig.targetPath);
    const staleFragments = new Set<string>();

    for (const sheet of await listComponentSheetIncludes(join(furnacePaths.customDir, tag))) {
      const relevant = sheet.includes.filter((f) => targetFragments.has(f));
      if (relevant.length === 0) continue;
      const destPath = join(engineTargetDir, sheet.fileName);
      if (!(await pathExists(destPath))) continue;
      const bodies = extractExpandedFragmentBodies(await readText(destPath));
      for (const fragment of relevant) {
        let source = sources.get(fragment);
        if (source === undefined) {
          source = await readFragmentSource(furnacePaths.sharedDir, fragment);
          sources.set(fragment, source);
        }
        if (bodies.get(fragment) !== source) staleFragments.add(fragment);
      }
    }

    if (staleFragments.size > 0) {
      stale.push({ tag, fragments: [...staleFragments].sort() });
    }
  }
  return { fragments, stale };
}
