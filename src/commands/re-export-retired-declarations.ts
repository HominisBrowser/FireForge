// SPDX-License-Identifier: EUPL-1.2
/**
 * `re-export --expect-removed` drops the staged declarations whose
 * `creates` path the run retires.
 *
 * Retiring a file would otherwise leave another patch's staged
 * registration (or forward import) for it in place, unflagged until the
 * per-patch lint after both re-exports reported `staged-dependency-unused`.
 * The run that retires the path drops every such declaration, in any patch of the queue, in one manifest
 * update, and names each one.
 */
import { withPatchDirectoryLock } from '../core/patch-lock.js';
import { loadPatchesManifestForWrite, mutatePatchRowsInManifest } from '../core/patch-manifest.js';
import type {
  PatchesManifest,
  PatchMetadata,
  PatchStagedDependencies,
  ReExportOptions,
} from '../types/commands/index.js';
import type { ProjectPaths } from '../types/config.js';
import { info } from '../utils/logger.js';
import {
  type PrunedStagedDeclaration,
  recordStagedDeclarationPrune,
} from './re-export-stale-registrations.js';

/** One holder's declarations on retired paths and the staged block left after them. */
interface RetiredDeclarationDrop {
  holder: string;
  dropped: PrunedStagedDeclaration[];
  stagedDependencies: PatchStagedDependencies | undefined;
}

/**
 * Finds the declarations whose `creates` path is retired and owned by no
 * patch outside `retiring`.
 *
 * @param manifest - The queue to judge
 * @param removed - The run's `--expect-removed` paths
 * @param retiring - Patches whose ownership of a removed path does not
 *   count: the selected owners in a dry run, whose rows are not rewritten
 *   yet; nothing after the write, where a failed owner still owns its path
 */
function planRetiredDeclarationDrops(
  manifest: PatchesManifest,
  removed: readonly string[],
  retiring: ReadonlySet<string>
): RetiredDeclarationDrop[] {
  const orphaned = new Set(
    removed.filter(
      (file) =>
        !manifest.patches.some(
          (patch) => !retiring.has(patch.filename) && patch.filesAffected.includes(file)
        )
    )
  );
  if (orphaned.size === 0) return [];
  const drops: RetiredDeclarationDrop[] = [];
  for (const patch of manifest.patches) {
    const drop = planHolderDrop(patch, orphaned);
    if (drop !== undefined) drops.push(drop);
  }
  return drops;
}

function planHolderDrop(
  patch: PatchMetadata,
  orphaned: ReadonlySet<string>
): RetiredDeclarationDrop | undefined {
  const forwardImports = patch.stagedDependencies?.forwardImports ?? [];
  const registrations = patch.stagedDependencies?.registrations ?? [];
  const dropped: PrunedStagedDeclaration[] = [
    ...registrations
      .filter((entry) => orphaned.has(entry.creates))
      .map((entry) => ({ kind: 'registration' as const, ...entry })),
    ...forwardImports
      .filter((entry) => orphaned.has(entry.creates))
      .map((entry) => ({ kind: 'import' as const, ...entry })),
  ];
  if (dropped.length === 0) return undefined;
  const keptImports = forwardImports.filter((entry) => !orphaned.has(entry.creates));
  const keptRegistrations = registrations.filter((entry) => !orphaned.has(entry.creates));
  const staged: PatchStagedDependencies = {
    ...(keptImports.length > 0 ? { forwardImports: keptImports } : {}),
    ...(keptRegistrations.length > 0 ? { registrations: keptRegistrations } : {}),
  };
  return {
    holder: patch.filename,
    dropped,
    stagedDependencies: Object.keys(staged).length > 0 ? staged : undefined,
  };
}

function reportRetiredDeclarationDrops(
  drops: readonly RetiredDeclarationDrop[],
  isDryRun: boolean
): void {
  const verb = isDryRun ? 'would drop' : 'drops';
  for (const { holder, dropped } of drops) {
    for (const entry of dropped) {
      const what =
        entry.kind === 'registration'
          ? `staged registration ${entry.file} "${entry.line.trim()}"`
          : `staged forward-import ${entry.file} "${entry.specifier}"`;
      info(`${holder}: ${verb} ${what}: --expect-removed retires ${entry.creates}.`);
    }
  }
}

/** What {@link dropRetiredPathDeclarations} needs from the run. */
export interface RetiredPathDeclarationsArgs {
  /** Resolved project paths. */
  paths: ProjectPaths;
  /** The queue as the run loaded it (judged in a dry run). */
  manifest: PatchesManifest;
  /** The run's options; `expectRemoved` holds the validated paths. */
  options: ReExportOptions;
  /** The run's selected patches. */
  selectedPatches: readonly PatchMetadata[];
  /** Name the drops without writing. */
  isDryRun: boolean;
}

/**
 * Drops (or, in a dry run, names) every staged declaration whose `creates`
 * path this run retired. Runs after the selected patches are written, so a
 * path whose owner failed to re-export is still owned and its declarations
 * stay.
 */
export async function dropRetiredPathDeclarations(
  args: RetiredPathDeclarationsArgs
): Promise<void> {
  const { manifest, isDryRun } = args;
  const patchesDir = args.paths.patches;
  const removed = args.options.expectRemoved ?? [];
  const selected = new Set(args.selectedPatches.map((patch) => patch.filename));
  if (removed.length === 0) return;
  if (isDryRun) {
    reportRetiredDeclarationDrops(
      planRetiredDeclarationDrops(manifest, removed, selected),
      isDryRun
    );
    return;
  }
  const drops = await withPatchDirectoryLock(
    patchesDir,
    async () => {
      const current = await loadPatchesManifestForWrite(patchesDir);
      if (!current) return [];
      const planned = planRetiredDeclarationDrops(current, removed, new Set());
      const byHolder = new Map(planned.map((drop) => [drop.holder, drop]));
      if (byHolder.size === 0) return [];
      await mutatePatchRowsInManifest(patchesDir, [...byHolder.keys()], (existing) => {
        const drop = byHolder.get(existing.filename);
        if (drop === undefined) return null;
        return drop.stagedDependencies === undefined
          ? { unset: ['stagedDependencies'] }
          : { set: { stagedDependencies: drop.stagedDependencies } };
      });
      return planned;
    },
    { command: 're-export' }
  );
  reportRetiredDeclarationDrops(drops, isDryRun);
  for (const drop of drops) {
    await recordStagedDeclarationPrune(
      patchesDir,
      drop.holder,
      drop.dropped,
      'staged declarations on retired paths'
    );
  }
}
