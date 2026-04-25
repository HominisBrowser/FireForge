// SPDX-License-Identifier: EUPL-1.2
/**
 * "Furnace manifest sync" doctor check.
 *
 * Surfaces orphaned component directories on disk whose names are missing
 * from `furnace.json`. The motivating eval case is the concurrent-override
 * race (eval 2) where two parallel `furnace override` commands both left
 * their directory on disk but only the second reached
 * `writeFurnaceConfig`. Under `--repair-furnace`, override orphans are
 * re-registered from the `override.json` sidecar the command wrote during
 * the copy phase; custom orphans are listed for the operator to either
 * re-run `furnace create` against or delete manually, because custom
 * components have no similar persisted metadata.
 *
 * Lives in a sibling module to keep `doctor-furnace.ts` under the
 * per-file LOC budget.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getFurnacePaths, loadFurnaceConfig, writeFurnaceConfig } from '../core/furnace-config.js';
import type { FurnaceConfig, OverrideComponentConfig, OverrideType } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson } from '../utils/fs.js';
import type { CheckResult, DoctorCheckDefinition } from './doctor.js';
import { failure, ok, warning } from './doctor.js';

interface OrphanOverride {
  name: string;
  recoveredConfig: OverrideComponentConfig | undefined;
}

async function listComponentDirs(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function recoverOverrideConfig(
  overrideDir: string,
  name: string
): Promise<OverrideComponentConfig | undefined> {
  // `furnace override` writes `override.json` alongside the copied files.
  // That sidecar is enough to reconstruct the furnace.json entry lost to
  // a concurrent-write race (eval 2: second override wrote back the
  // outer-snapshot config, dropping the sibling write's addition).
  const sidecarPath = join(overrideDir, name, 'override.json');
  if (!(await pathExists(sidecarPath))) return undefined;
  try {
    const raw = await readJson<{
      type?: unknown;
      description?: unknown;
      basePath?: unknown;
      baseVersion?: unknown;
      baseCommit?: unknown;
    }>(sidecarPath);
    const type = raw.type;
    const description = raw.description;
    const basePath = raw.basePath;
    const baseVersion = raw.baseVersion;
    if (
      (type !== 'css-only' && type !== 'full') ||
      typeof description !== 'string' ||
      typeof basePath !== 'string' ||
      typeof baseVersion !== 'string'
    ) {
      return undefined;
    }
    const restored: OverrideComponentConfig = {
      type: type as OverrideType,
      description,
      basePath,
      baseVersion,
    };
    if (typeof raw.baseCommit === 'string') {
      (restored as OverrideComponentConfig & { baseCommit?: string }).baseCommit = raw.baseCommit;
    }
    return restored;
  } catch {
    return undefined;
  }
}

async function collectOrphans(
  projectRoot: string,
  config: FurnaceConfig
): Promise<{ overrides: OrphanOverride[]; customNames: string[] }> {
  const furnacePaths = getFurnacePaths(projectRoot);

  const overrideDirs = await listComponentDirs(furnacePaths.overridesDir);
  const overrideOrphans: OrphanOverride[] = [];
  for (const name of overrideDirs) {
    if (name in config.overrides) continue;
    const recoveredConfig = await recoverOverrideConfig(furnacePaths.overridesDir, name);
    overrideOrphans.push({ name, recoveredConfig });
  }

  const customDirs = await listComponentDirs(furnacePaths.customDir);
  const customOrphans = customDirs.filter((name) => !(name in config.custom));

  return { overrides: overrideOrphans, customNames: customOrphans };
}

function formatOrphanSummary(orphans: {
  overrides: OrphanOverride[];
  customNames: string[];
}): string {
  const overrideCount = orphans.overrides.length;
  const customCount = orphans.customNames.length;
  const overrideLabel =
    overrideCount > 0
      ? `${overrideCount} override${overrideCount === 1 ? '' : 's'} ` +
        `(${orphans.overrides.map((o) => o.name).join(', ')})`
      : '';
  const customLabel =
    customCount > 0
      ? `${customCount} custom ${customCount === 1 ? 'directory' : 'directories'} ` +
        `(${orphans.customNames.join(', ')})`
      : '';
  const description = [overrideLabel, customLabel].filter(Boolean).join(' and ');
  return `Found orphaned component ${
    overrideCount + customCount === 1 ? 'directory' : 'directories'
  } on disk: ${description}. furnace.json does not list these — a previous mutation may have lost a concurrent write.`;
}

async function repairOrphanOverrides(
  projectRoot: string,
  orphans: OrphanOverride[]
): Promise<{ restored: string[]; unrecoverable: string[]; writeError?: string }> {
  const restored: string[] = [];
  const unrecoverable: string[] = [];
  if (orphans.length === 0) return { restored, unrecoverable };
  const freshConfig = await loadFurnaceConfig(projectRoot);
  for (const orphan of orphans) {
    if (orphan.recoveredConfig) {
      freshConfig.overrides[orphan.name] = orphan.recoveredConfig;
      restored.push(orphan.name);
    } else {
      unrecoverable.push(orphan.name);
    }
  }
  if (restored.length > 0) {
    try {
      await writeFurnaceConfig(projectRoot, freshConfig);
    } catch (err: unknown) {
      return { restored: [], unrecoverable, writeError: toError(err).message };
    }
  }
  return { restored, unrecoverable };
}

export const furnaceManifestSyncCheck: DoctorCheckDefinition = {
  name: 'Furnace manifest sync',
  dependsOn: ['Furnace configuration'],
  skipIf: (ctx) => !ctx.furnaceConfigExists || !ctx.furnaceConfig,
  run: async (ctx): Promise<CheckResult> => {
    const config = ctx.furnaceConfig;
    if (!config) return [];

    const orphans = await collectOrphans(ctx.projectRoot, config);
    const overrideCount = orphans.overrides.length;
    const customCount = orphans.customNames.length;
    if (overrideCount === 0 && customCount === 0) {
      return ok('Furnace manifest sync');
    }

    const summary = formatOrphanSummary(orphans);
    if (!ctx.options.repairFurnace) {
      return warning(
        'Furnace manifest sync',
        summary,
        'Run "fireforge doctor --repair-furnace" to re-register override orphans from their override.json sidecars (custom orphans are listed for manual follow-up).'
      );
    }

    const repairResult = await repairOrphanOverrides(ctx.projectRoot, orphans.overrides);
    if (repairResult.writeError) {
      return failure(
        'Furnace manifest sync',
        `Repair failed while writing furnace.json: ${repairResult.writeError}`,
        'Fix the underlying filesystem error and retry the doctor command.'
      );
    }

    const { restored, unrecoverable } = repairResult;
    const restoreDetail =
      restored.length > 0
        ? `Re-registered ${restored.length} override${restored.length === 1 ? '' : 's'} (${restored.join(', ')}) from their override.json sidecars.`
        : '';
    const unrecoverableDetail =
      unrecoverable.length > 0
        ? ` Could not recover ${unrecoverable.length} override${unrecoverable.length === 1 ? '' : 's'} without a valid override.json (${unrecoverable.join(', ')}) — delete components/overrides/<name> or re-run "fireforge furnace override" to restore the entry.`
        : '';
    const customDetail =
      customCount > 0
        ? ` ${customCount} custom ${customCount === 1 ? 'directory requires' : 'directories require'} manual action: re-run "fireforge furnace create" or delete components/custom/<name>/ to reconcile.`
        : '';
    return warning(
      'Furnace manifest sync',
      `${restoreDetail}${unrecoverableDetail}${customDetail}`.trim() ||
        'Nothing to repair (orphans surfaced but all were already recoverable).'
    );
  },
};
