// SPDX-License-Identifier: EUPL-1.2
/**
 * "Furnace config sync" doctor check.
 *
 * Surfaces orphaned component directories on disk whose names are missing
 * from `furnace.json` — typically the concurrent-override race, where two
 * parallel `furnace override` commands both leave their directory on disk
 * but only the second reaches `writeFurnaceConfig`. Under
 * `--repair-furnace`, override orphans are re-registered from the
 * `override.json` sidecar the command wrote during the copy phase; custom
 * orphans are listed for the operator to either re-run `furnace create`
 * against or delete manually, because custom components have no similar
 * persisted metadata.
 *
 * Lives in a sibling module to keep `doctor-furnace.ts` under the per-file
 * LOC budget.
 */

import type { Dirent } from 'node:fs';
import { readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import { withFileLock } from '../core/file-lock.js';
import { getFurnacePaths, loadFurnaceConfig, writeFurnaceConfig } from '../core/furnace-config.js';
import { getFurnaceLockPath } from '../core/furnace-operation.js';
import type { FurnaceConfig, OverrideComponentConfig } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExistsStrict, readJson } from '../utils/fs.js';
import type { CheckResult, DoctorCheckDefinition } from './doctor-check-core.js';
import { failure, ok, warning } from './doctor-check-core.js';

interface OrphanOverride {
  name: string;
  recoveredConfig: OverrideComponentConfig | undefined;
}

/**
 * Lists component directories, distinguishing "none" from "could not look".
 *
 * A missing directory is genuinely empty. A `readdir` failure is not: this
 * check exists to detect the concurrent-override orphan race, and swallowing
 * the error into `[]` made it report clean for the one condition it is here
 * to catch. The caller surfaces the failure instead.
 */
async function listComponentDirs(dir: string): Promise<string[]> {
  // `pathExistsStrict`, not `pathExists`: the latter answers `false` for EVERY
  // access error, so an unreadable components directory reported "no orphans",
  // i.e. a clean check — the same fail-open the comment above rejects for
  // `readdir`. Only ENOENT means genuinely absent.
  if (!(await pathExistsStrict(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function recoverOverrideConfig(
  overrideDir: string,
  name: string
): Promise<OverrideComponentConfig | undefined> {
  // `furnace override` writes `override.json` alongside the copied files.
  // That sidecar is enough to reconstruct the furnace.json entry lost to a
  // concurrent-write race, where the second override writes back the
  // outer-snapshot config and drops the sibling write's addition.
  //
  // No `pathExists` precheck: it collapses "absent" and "unreadable" into
  // the same `false`, and both outcomes lead here anyway — a missing file
  // lands in the catch below with the same `undefined` result.
  const sidecarPath = join(overrideDir, name, 'override.json');
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
      type: type,
      description,
      basePath,
      baseVersion,
    };
    if (typeof raw.baseCommit === 'string') {
      // `baseCommit` is already declared optional on OverrideComponentConfig,
      // so the intersection this replaced widened nothing.
      restored.baseCommit = raw.baseCommit;
    }
    return restored;
  } catch {
    // Unreadable or malformed sidecar. Returning `undefined` here is the same
    // value as "no sidecar present", so the caller reports the override as
    // unrecoverable — which is the safe direction (it never invents config),
    // but the operator sees "no valid override.json" rather than "the
    // override.json is corrupt". The remediation is identical either way.
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

interface RepairOutcome {
  restored: string[];
  unrecoverable: string[];
  /** Names a concurrent writer registered between collection and the lock. */
  reconciled: string[];
  deleted: string[];
  retained: string[];
  errors: string[];
  /** Set when the repair failed before anything was persisted; names the phase. */
  repairError?: string;
}

function emptyOutcome(): RepairOutcome {
  return {
    restored: [],
    unrecoverable: [],
    reconciled: [],
    deleted: [],
    retained: [],
    errors: [],
  };
}

/**
 * Re-registers override orphans and deletes empty custom orphan directories,
 * under ONE furnace lock held across both.
 *
 * Two things this must not do, both of which reproduce the lost-write race the
 * check exists to clean up after:
 *
 * 1. Write back a decision made before the lock. The orphan list is computed
 *    from a config snapshot loaded well before we hold anything, so by the
 *    time we can write, a concurrent `furnace override` may have registered
 *    the same name — writing our sidecar-reconstructed entry over it discards
 *    a live write, and a concurrent `furnace create` registering the name
 *    under `custom` would leave it in BOTH maps, a state nothing validates.
 *    Every orphan is therefore re-checked against `freshConfig` inside the
 *    lock and skipped when it is no longer orphaned.
 * 2. Delete custom directories outside the lock. `repairCustomOrphans` used to
 *    run after the lock was released, so a `furnace create` that had
 *    registered a name and not yet populated its directory had that directory
 *    deleted underneath it.
 */
async function repairOrphans(
  projectRoot: string,
  orphans: { overrides: OrphanOverride[]; customNames: string[] }
): Promise<RepairOutcome> {
  const outcome = emptyOutcome();
  if (orphans.overrides.length === 0 && orphans.customNames.length === 0) return outcome;

  const lockPath = getFurnaceLockPath(projectRoot);
  // One catch covers four distinct phases; naming the one that failed keeps
  // the report honest — a lock timeout otherwise renders as "failed while
  // writing furnace.json", the phase least likely to have been reached.
  // Held in an object rather than two `let`s: the lock callback mutates them
  // from inside a closure, and TS's control-flow analysis does not propagate
  // that through the call — it would narrow both to their initial literals
  // in the catch below.
  const progress = { phase: 'waiting for the furnace lock', persisted: false };
  try {
    await withFileLock(
      lockPath,
      async () => {
        progress.phase = 'loading furnace.json under the lock';
        const freshConfig = await loadFurnaceConfig(projectRoot);
        repairOverridesLocked(freshConfig, orphans.overrides, outcome);
        if (outcome.restored.length > 0) {
          progress.phase = 'writing furnace.json';
          await writeFurnaceConfig(projectRoot, freshConfig);
        }
        // From here the restore (if any) is on disk; a later failure must not
        // report the whole repair as if it never happened.
        progress.persisted = true;
        progress.phase = 'cleaning custom orphan directories';
        await deleteEmptyCustomOrphans(projectRoot, freshConfig, orphans.customNames, outcome);
      },
      {
        onTimeoutMessage:
          `Timed out waiting for the furnace lock at ${lockPath}. ` +
          'Another fireforge furnace command may be running; retry the repair once it finishes.',
      }
    );
  } catch (err: unknown) {
    if (progress.persisted) {
      outcome.errors.push(`repair failed while ${progress.phase}: ${toError(err).message}`);
      return outcome;
    }
    return {
      ...emptyOutcome(),
      unrecoverable: outcome.unrecoverable,
      repairError: `while ${progress.phase}: ${toError(err).message}`,
    };
  }
  return outcome;
}

/** Override half of {@link repairOrphans}; mutates `freshConfig` in place. */
function repairOverridesLocked(
  freshConfig: FurnaceConfig,
  orphans: OrphanOverride[],
  outcome: RepairOutcome
): void {
  for (const orphan of orphans) {
    if (orphan.name in freshConfig.overrides || orphan.name in freshConfig.custom) {
      // Registered while we waited for the lock — no longer an orphan, and
      // writing over it would either discard that write or duplicate the name
      // across `overrides` and `custom`.
      outcome.reconciled.push(orphan.name);
      continue;
    }
    if (orphan.recoveredConfig) {
      freshConfig.overrides[orphan.name] = orphan.recoveredConfig;
      outcome.restored.push(orphan.name);
    } else {
      outcome.unrecoverable.push(orphan.name);
    }
  }
}

/** Custom half of {@link repairOrphans}; must run under the same lock. */
async function deleteEmptyCustomOrphans(
  projectRoot: string,
  freshConfig: FurnaceConfig,
  customNames: string[],
  outcome: RepairOutcome
): Promise<void> {
  if (customNames.length === 0) return;
  const furnacePaths = getFurnacePaths(projectRoot);
  for (const name of customNames) {
    if (name in freshConfig.custom || name in freshConfig.overrides) {
      // A name that was orphaned in BOTH trees is reconciled once, not once
      // per tree — the report reads "Skipped 2 names (x, x)" otherwise.
      if (!outcome.reconciled.includes(name)) outcome.reconciled.push(name);
      continue;
    }
    const dir = join(furnacePaths.customDir, name);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      outcome.errors.push(`${name}: ${toError(err).message}`);
      continue;
    }

    if (entries.length > 0) {
      outcome.retained.push(name);
      continue;
    }

    try {
      // `rmdir`, not `rm`: `rm` without `{ recursive: true }` throws EISDIR on
      // a directory, so on a real filesystem this branch always failed and the
      // "deleted N empty directories" report was unreachable. `rmdir` is also
      // the exact semantics wanted here — it refuses a non-empty directory,
      // which keeps the emptiness check above from being the only safeguard.
      await rmdir(dir);
      outcome.deleted.push(name);
    } catch (err: unknown) {
      outcome.errors.push(`${name}: ${toError(err).message}`);
    }
  }
}

export const furnaceConfigSyncCheck: DoctorCheckDefinition = {
  name: 'Furnace config sync',
  dependsOn: ['Furnace configuration'],
  skipIf: (ctx) => !ctx.furnaceConfigExists || !ctx.furnaceConfig,
  run: async (ctx): Promise<CheckResult> => {
    const config = ctx.furnaceConfig;
    if (!config) return [];

    const orphans = await collectOrphans(ctx.projectRoot, config);
    const overrideCount = orphans.overrides.length;
    const customCount = orphans.customNames.length;
    if (overrideCount === 0 && customCount === 0) {
      return ok('Furnace config sync');
    }

    const summary = formatOrphanSummary(orphans);
    if (!ctx.options.repairFurnace) {
      return warning(
        'Furnace config sync',
        summary,
        'Run "fireforge doctor --repair-furnace" to re-register override orphans from their override.json sidecars (custom orphans are listed for manual follow-up).'
      );
    }

    const repairResult = await repairOrphans(ctx.projectRoot, orphans);
    if (repairResult.repairError) {
      return failure(
        'Furnace config sync',
        `Repair failed ${repairResult.repairError}`,
        'Fix the underlying error and retry the doctor command.'
      );
    }

    const customRepair = repairResult;
    const { restored, unrecoverable, reconciled } = repairResult;
    const reconciledDetail =
      reconciled.length > 0
        ? ` Skipped ${reconciled.length} name${reconciled.length === 1 ? '' : 's'} (${reconciled.join(', ')}) that furnace.json already listed by the time the repair held the furnace lock — a concurrent furnace command registered ${reconciled.length === 1 ? 'it' : 'them'} first.`
        : '';
    const restoreDetail =
      restored.length > 0
        ? `Re-registered ${restored.length} override${restored.length === 1 ? '' : 's'} (${restored.join(', ')}) from their override.json sidecars.`
        : '';
    const unrecoverableDetail =
      unrecoverable.length > 0
        ? ` Could not recover ${unrecoverable.length} override${unrecoverable.length === 1 ? '' : 's'} without a valid override.json (${unrecoverable.join(', ')}) — delete components/overrides/<name> or re-run "fireforge furnace override" to restore the entry.`
        : '';
    const customDetail =
      customRepair.deleted.length > 0
        ? ` Deleted ${customRepair.deleted.length} empty custom orphan ${customRepair.deleted.length === 1 ? 'directory' : 'directories'} (${customRepair.deleted.join(', ')}).`
        : '';
    const retainedCustomDetail =
      customRepair.retained.length > 0
        ? ` ${customRepair.retained.length} non-empty custom orphan ${customRepair.retained.length === 1 ? 'directory requires' : 'directories require'} manual action (${customRepair.retained.join(', ')}): re-run "fireforge furnace create" or delete components/custom/<name>/ to reconcile.`
        : '';
    const customErrorDetail =
      customRepair.errors.length > 0
        ? ` Could not inspect or delete ${customRepair.errors.length} custom orphan ${customRepair.errors.length === 1 ? 'directory' : 'directories'} (${customRepair.errors.join('; ')}).`
        : '';
    return warning(
      'Furnace config sync',
      `${restoreDetail}${unrecoverableDetail}${customDetail}${retainedCustomDetail}${customErrorDetail}${reconciledDetail}`.trim() ||
        'Nothing to repair (orphans surfaced but all were already recoverable).'
    );
  },
};
