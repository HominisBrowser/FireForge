// SPDX-License-Identifier: EUPL-1.2
/**
 * Stale-furnace-source gate for `fireforge patch export` / `re-export`.
 *
 * Exports capture the DEPLOYED engine copies of furnace-managed files, not
 * the `components/` sources. Editing a component source and re-exporting
 * its owning patch WITHOUT an intervening `furnace deploy`/`apply` silently
 * exports the stale deployed copy — per-patch lint then flags the old line
 * count and the patch body lags the source. This gate detects that
 * sequence by comparing component source directories against the checksums
 * recorded at the last apply (`FurnaceState.appliedChecksums`) — the same
 * signal `warnIfFurnaceStale` uses for run/watch — and refuses the export
 * unless the operator passes `--allow-stale-furnace`.
 *
 * Checksum-based on purpose: git checkouts and `furnace refresh` churn
 * mtimes without content changes, so an mtime comparison would misfire.
 *
 * Probe failures (broken furnace config, missing state) degrade to a
 * verbose log and an empty result — a broken furnace setup must never
 * block non-furnace patch work.
 */

import { GeneralError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';
import { extractComponentChecksums, hasComponentChanged } from './furnace-apply-helpers.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from './furnace-config.js';
import { resolveFtlDir } from './furnace-constants.js';

/** One furnace component whose source drifted from its deployed copy. */
export interface StaleFurnaceComponent {
  /** Component name (furnace.json key). */
  name: string;
  /** Component flavor — resolves the source directory root. */
  type: 'custom' | 'override';
  /** Engine-relative deployed prefix (`/`-terminated) the component owns. */
  prefix: string;
}

/**
 * Returns the furnace components whose deployed engine copies the given
 * files fall under AND whose `components/` sources have changed since the
 * last apply. Empty when furnace is not configured, never applied, or the
 * probe fails.
 *
 * Files are attributed per component: the custom `targetPath` / override
 * `basePath` prefixes, plus — for a localized non-sharedFtl custom
 * component — its exact deployed `<ftlDir>/<name>.ftl` file (the shared
 * FTL dir as a whole stays unclaimed; sibling files there belong to other
 * components). `sharedFtl` bundles are NOT furnace-deployed (apply only
 * prunes a dangling per-widget jar.mn line), so they have no deployed copy
 * to go stale and get no candidate by design. The storybook stories prefix
 * is likewise skipped.
 *
 * @param projectRoot - Project root directory
 * @param files - Engine-relative paths the export will capture
 */
export async function findStaleFurnaceComponentsForFiles(
  projectRoot: string,
  files: readonly string[]
): Promise<StaleFurnaceComponent[]> {
  try {
    if (files.length === 0) return [];
    if (!(await furnaceConfigExists(projectRoot))) return [];

    const config = await loadFurnaceConfig(projectRoot);
    const state = await loadFurnaceState(projectRoot);
    if (!state.appliedChecksums) return [];
    const furnacePaths = getFurnacePaths(projectRoot);

    const ftlDir = resolveFtlDir(config.ftlBasePath);
    const ftlPrefix = ftlDir.endsWith('/') ? ftlDir : `${ftlDir}/`;

    const candidates: (StaleFurnaceComponent & { exactFiles: readonly string[] })[] = [
      ...Object.entries(config.overrides).map(([name, cfg]) => ({
        name,
        type: 'override' as const,
        prefix: cfg.basePath.endsWith('/') ? cfg.basePath : `${cfg.basePath}/`,
        exactFiles: [],
      })),
      ...Object.entries(config.custom).map(([name, cfg]) => ({
        name,
        type: 'custom' as const,
        prefix: cfg.targetPath.endsWith('/') ? cfg.targetPath : `${cfg.targetPath}/`,
        // A localized non-sharedFtl component also owns exactly one
        // deployed file in the shared FTL dir (applyCustomFtlFile copies
        // `<name>.ftl` there). sharedFtl bundles are not furnace-deployed.
        exactFiles: cfg.localized && cfg.sharedFtl === undefined ? [`${ftlPrefix}${name}.ftl`] : [],
      })),
    ];

    const stale: StaleFurnaceComponent[] = [];
    for (const candidate of candidates) {
      if (
        !files.some(
          (file) => file.startsWith(candidate.prefix) || candidate.exactFiles.includes(file)
        )
      )
        continue;
      const sourceRoot =
        candidate.type === 'override' ? furnacePaths.overridesDir : furnacePaths.customDir;
      const sourceDir = `${sourceRoot}/${candidate.name}`;
      if (!(await pathExists(sourceDir))) continue;
      const previous = extractComponentChecksums(
        state.appliedChecksums,
        candidate.type,
        candidate.name
      );
      if (await hasComponentChanged(sourceDir, previous)) {
        stale.push({ name: candidate.name, type: candidate.type, prefix: candidate.prefix });
      }
    }
    return stale;
  } catch (error: unknown) {
    verbose(`Stale-furnace export gate skipped due to an error: ${toError(error).message}`);
    return [];
  }
}

/**
 * Gate helper for export/re-export: refuses (or, with `allow`, warns) when
 * any exported file belongs to a furnace component whose source changed
 * since the last apply — the export would capture the stale deployed copy.
 *
 * @param projectRoot - Project root directory
 * @param files - Engine-relative paths the export will capture
 * @param allow - True when the operator passed `--allow-stale-furnace`
 * @param command - Which command runs the gate (message wording only)
 */
export async function enforceFreshFurnaceSources(
  projectRoot: string,
  files: readonly string[],
  allow: boolean,
  command: 'export' | 're-export'
): Promise<void> {
  const stale = await findStaleFurnaceComponentsForFiles(projectRoot, files);
  if (stale.length === 0) return;

  const list = stale
    .map(
      (component) =>
        `${component.name} (components/${component.type === 'custom' ? 'custom' : 'overrides'}/${component.name}/ → ${component.prefix})`
    )
    .join(', ');
  const message =
    `Component source${stale.length === 1 ? '' : 's'} changed since the last furnace apply: ${list}. ` +
    `The deployed engine cop${stale.length === 1 ? 'y is' : 'ies are'} stale, so this ${command} would ` +
    'capture the OLD component content into the patch. Run "fireforge furnace deploy" (or ' +
    '"fireforge furnace apply") first so the export captures the current source, or pass ' +
    '--allow-stale-furnace to export the deployed copy anyway.';

  if (allow) {
    warn(message);
    return;
  }
  throw new GeneralError(message);
}
