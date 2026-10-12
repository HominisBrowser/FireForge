// SPDX-License-Identifier: EUPL-1.2
/**
 * The Furnace-composed form of a component source, and the questions that
 * need it.
 *
 * `furnace apply` does not copy every source verbatim: a stylesheet with
 * `@fireforge-include` directives is deployed with each fragment body from
 * `components/shared/` inlined between the directive and its
 * `@fireforge-end-include` marker. Anything that compares a deployed engine
 * file with its source has to compare against that composed form, or a
 * freshly deployed widget reads as a large difference it is not:
 *
 *  - the unexported-drift belt (`build`/`test --refuse-unexported-drift`),
 *    which must not refuse to overwrite a deployed file with the very bytes
 *    it already holds;
 *  - `furnace diff`, which must show what the next apply would change.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { FurnaceConfig } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import { sha256Hex } from '../utils/hash.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { isOverrideCopyCandidate } from './furnace-apply-helpers.js';
import { extractComponentChecksums, normalizeForChecksum } from './furnace-checksum-utils.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from './furnace-config.js';
import { resolveFtlDir } from './furnace-constants.js';
import {
  expandCssFragments,
  listFragmentIncludes,
  stripExpandedFragments,
} from './furnace-css-fragments.js';
import { isRegularFile } from './furnace-dir-entry.js';

/**
 * Composes one component source into the bytes apply deploys: a stylesheet
 * carrying include directives is fragment-expanded, anything else is
 * returned as is.
 *
 * @param content - Workspace source content
 * @param fileName - Source file name (only `.css` is ever expanded)
 * @param sharedDir - Absolute path of `components/shared/`
 * @returns The composed content
 * @throws FurnaceError when an included fragment is missing or nested
 */
export async function composeComponentSource(
  content: string,
  fileName: string,
  sharedDir: string
): Promise<string> {
  if (!fileName.endsWith('.css') || listFragmentIncludes(content).length === 0) return content;
  return (await expandCssFragments(content, sharedDir)).expanded;
}

/** The workspace source apply deploys to one engine path. */
export interface FurnaceDeployedSource {
  type: 'custom' | 'override';
  component: string;
  /** Source file name inside the component directory. */
  fileName: string;
  /** Absolute path of the workspace source. */
  sourcePath: string;
}

/**
 * Maps every engine-relative path `furnace apply` writes to the workspace
 * source it writes there: custom `.mjs`/`.css` into `targetPath`, a custom
 * component's own `.ftl` into the Fluent tree (never for `sharedFtl`), and
 * each override copy candidate onto its engine target.
 *
 * @param root - Project root
 * @param config - Loaded furnace.json
 * @returns Engine-relative path (POSIX) → deployed source
 */
export async function mapDeployedComponentSources(
  root: string,
  config: FurnaceConfig
): Promise<Map<string, FurnaceDeployedSource>> {
  const furnacePaths = getFurnacePaths(root);
  const ftlDir = resolveFtlDir(config.ftlBasePath);
  const sources = new Map<string, FurnaceDeployedSource>();

  for (const [component, custom] of Object.entries(config.custom)) {
    const componentDir = join(furnacePaths.customDir, component);
    for (const fileName of await listSourceFiles(componentDir)) {
      let engineRel: string | undefined;
      if (fileName.endsWith('.mjs') || fileName.endsWith('.css')) {
        engineRel = normalizePathSlashes(join(custom.targetPath, fileName));
      } else if (fileName === `${component}.ftl` && custom.localized && !custom.sharedFtl) {
        engineRel = normalizePathSlashes(join(ftlDir, fileName));
      }
      if (engineRel === undefined) continue;
      sources.set(engineRel, {
        type: 'custom',
        component,
        fileName,
        sourcePath: join(componentDir, fileName),
      });
    }
  }

  for (const [component, override] of Object.entries(config.overrides)) {
    const componentDir = join(furnacePaths.overridesDir, component);
    for (const fileName of await listSourceFiles(componentDir)) {
      if (!isOverrideCopyCandidate(fileName, override.type)) continue;
      // Same target rule as `getOverrideEngineTargetPath`, engine-relative.
      const base = fileName.endsWith('.ftl') ? ftlDir : override.basePath;
      sources.set(normalizePathSlashes(join(base, fileName)), {
        type: 'override',
        component,
        fileName,
        sourcePath: join(componentDir, fileName),
      });
    }
  }
  return sources;
}

async function listSourceFiles(componentDir: string): Promise<string[]> {
  if (!(await pathExists(componentDir))) return [];
  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });
  return entries.filter((entry) => isRegularFile(entry)).map((entry) => entry.name);
}

/**
 * Why a deployed engine file is safe to overwrite from its component
 * source even though no patch body or baseline explains it:
 *
 * - `composed-source`: it already equals the Furnace-composed current
 *   source, so the overwrite writes the same bytes;
 * - `fragment-refresh`: it differs from the composed source only inside
 *   Furnace-generated fragment expansions (a fragment changed since it was
 *   deployed), so the overwrite only refreshes generated text;
 * - `previous-deploy`: it is exactly the content Furnace's last recorded
 *   apply deployed (the source has moved on since), so the overwrite loses
 *   nothing that was not already a component source.
 */
export type DeployedSourceMatch = 'composed-source' | 'fragment-refresh' | 'previous-deploy';

/**
 * Classifies one deployed engine file against its component source.
 *
 * @returns The match, or undefined when the engine copy is explained by
 *   none of them (a real, unrecorded engine edit)
 */
async function matchDeployedSource(
  engineContent: string,
  source: FurnaceDeployedSource,
  sharedDir: string,
  appliedChecksums: Record<string, string> | undefined
): Promise<DeployedSourceMatch | undefined> {
  const sourceContent = await readText(source.sourcePath);
  const engine = normalizeForChecksum(engineContent);
  let composed: string | undefined;
  try {
    composed = await composeComponentSource(sourceContent, source.fileName, sharedDir);
  } catch {
    // A missing fragment: no composed form exists. The other two
    // comparisons below still apply.
  }
  if (composed !== undefined && normalizeForChecksum(composed) === engine) {
    return 'composed-source';
  }
  const strippedEngine = stripExpandedFragments(engine);
  if (
    listFragmentIncludes(sourceContent).length > 0 &&
    strippedEngine === stripExpandedFragments(normalizeForChecksum(sourceContent))
  ) {
    return 'fragment-refresh';
  }
  const recorded = extractComponentChecksums(appliedChecksums, source.type, source.component)[
    source.fileName
  ];
  // Apply records the checksum of the (unexpanded) source it deployed, so
  // an engine copy with its expansions collapsed hashes to that value
  // exactly when it is that deployment.
  if (recorded !== undefined && sha256Hex(strippedEngine) === recorded) {
    return 'previous-deploy';
  }
  return undefined;
}

/**
 * For each engine-relative path, decides whether its current engine content
 * is a Furnace deployment of its component source (see
 * {@link DeployedSourceMatch}). Paths with no component source, an
 * unreadable engine copy, or content explained by none of the matches are
 * absent from the result.
 *
 * @param root - Project root
 * @param engineDir - Absolute engine directory
 * @param files - Engine-relative paths to classify
 * @returns Engine-relative path → match, for the matching paths only
 */
export async function matchDeployedComponentFiles(
  root: string,
  engineDir: string,
  files: readonly string[]
): Promise<Map<string, DeployedSourceMatch>> {
  const matches = new Map<string, DeployedSourceMatch>();
  if (files.length === 0 || !(await furnaceConfigExists(root))) return matches;
  const sources = await mapDeployedComponentSources(root, await loadFurnaceConfig(root));
  const { sharedDir } = getFurnacePaths(root);
  const { appliedChecksums } = await loadFurnaceState(root);
  for (const file of files) {
    const source = sources.get(file);
    if (source === undefined) continue;
    const enginePath = join(engineDir, file);
    if (!(await pathExists(enginePath))) continue;
    const match = await matchDeployedSource(
      await readText(enginePath),
      source,
      sharedDir,
      appliedChecksums
    );
    if (match !== undefined) matches.set(file, match);
  }
  return matches;
}
