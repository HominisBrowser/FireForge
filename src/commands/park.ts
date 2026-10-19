// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge park`: set one session's edits in a patch's files aside and
 * put them back after the owner commits.
 *
 *   park <patch> [--label <l>] [--hunks <diff>]   park and restore baseline
 *   park --restore <label>                         three-way merge them back
 *   park --list | park --drop <label>
 *
 * Without `--hunks` every drifted file of the patch goes back to its
 * queue-applied baseline. With `--hunks` only the named hunks are taken out
 * of the working tree. Either way the park warns when a hunk it takes out
 * removes a Fluent message id, or a whole file, that files outside the
 * patch still reference: a parked string still used by markup another
 * patch owns makes `document.l10n.ready` reject in every new window.
 */
import { basename, join } from 'node:path';

import type { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { withEngineSessionLock } from '../core/engine-session-lock.js';
import { appendHistoryBestEffort } from '../core/history-log.js';
import {
  dropPark,
  fluentIds,
  listParks,
  type ParkedFile,
  planRestore,
  readEngineFile,
  readPark,
  removedLines,
  writeEngineFile,
  writePark,
} from '../core/park-store.js';
import { createPatchedContentContext } from '../core/patch-apply.js';
import { formatPatchNotFoundError } from '../core/patch-identifier-suggest.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../core/patch-manifest.js';
import { parseDiffSections } from '../core/patch-parse.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import type { ProjectPaths } from '../types/config.js';
import { pathExists, readText } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { addWaitLockOption, resolveWaitLockSeconds } from '../utils/options.js';
import { applyHunksByContext } from './re-export-hunks.js';
import { normalizeEngineRelativeInput } from './re-export-scan.js';

/** Options for `fireforge park`. */
export interface ParkOptions {
  label?: string;
  hunks?: string;
  restore?: string;
  list?: boolean;
  drop?: string;
  dryRun?: boolean;
  waitLock?: number | boolean;
}

/** The patch-applied baseline of each of `patch`'s files (null = absent). */
async function baselinesOf(
  paths: ProjectPaths,
  patch: PatchMetadata
): Promise<Map<string, string | null>> {
  const { computePatched } = await createPatchedContentContext(paths.patches, paths.engine);
  const deleted = new Set(
    parseDiffSections(await readText(join(paths.patches, patch.filename)))
      .filter((section) => section.isDeletedFile)
      .map((section) => section.targetPath)
  );
  const baselines = new Map<string, string | null>();
  for (const file of patch.filesAffected) {
    baselines.set(file, deleted.has(file) ? null : await computePatched(file));
  }
  return baselines;
}

/** The files a park would change, with both sides. */
async function planPark(
  paths: ProjectPaths,
  patch: PatchMetadata,
  hunksPath: string | undefined
): Promise<ParkedFile[]> {
  if (hunksPath === undefined) {
    const baselines = await baselinesOf(paths, patch);
    const files: ParkedFile[] = [];
    for (const [path, after] of baselines) {
      const before = await readEngineFile(paths.engine, path);
      if (before !== after) files.push({ path, before, after });
    }
    return files;
  }
  if (!(await pathExists(hunksPath))) {
    throw new InvalidArgumentError(`--hunks ${hunksPath} does not exist.`, '--hunks');
  }
  const owned = new Set(patch.filesAffected);
  const files: ParkedFile[] = [];
  for (const section of parseDiffSections(await readText(hunksPath))) {
    const path = normalizeEngineRelativeInput(section.targetPath, '--hunks');
    if (!owned.has(path)) {
      throw new InvalidArgumentError(
        `--hunks names ${path}, which ${patch.filename} does not own.`,
        '--hunks'
      );
    }
    const before = await readEngineFile(paths.engine, path);
    const after = applyHunksByContext(before ?? '', section.hunks, true, path);
    if (before !== after) files.push({ path, before, after });
  }
  return files;
}

/**
 * Referrers outside the patch of what the park takes away: Fluent ids its
 * removed lines declare, and files it removes outright.
 */
async function findOutsideReferrers(
  paths: ProjectPaths,
  manifest: PatchesManifest,
  patch: PatchMetadata,
  files: readonly ParkedFile[]
): Promise<string[]> {
  const needles = new Map<string, string>();
  for (const file of files) {
    if (file.path.endsWith('.ftl')) {
      for (const id of fluentIds(removedLines(file.before, file.after))) {
        needles.set(id, `Fluent id "${id}" (${file.path})`);
      }
    }
    if (file.before !== null && file.after === null) {
      needles.set(basename(file.path), `file ${file.path}`);
    }
  }
  if (needles.size === 0) return [];
  const own = new Set(patch.filesAffected);
  const outside = [...new Set(manifest.patches.flatMap((entry) => entry.filesAffected))].filter(
    (file) => !own.has(file)
  );
  const findings: string[] = [];
  for (const file of outside) {
    const content = await readEngineFile(paths.engine, file);
    if (content === null) continue;
    for (const [needle, label] of needles) {
      if (content.includes(needle)) findings.push(`${label} is still referenced by ${file}`);
    }
  }
  return findings;
}

async function runPark(
  projectRoot: string,
  identifier: string,
  options: ParkOptions
): Promise<void> {
  const paths = getProjectPaths(projectRoot);
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest) throw new GeneralError('No patches/patches.json; nothing to park against.');
  const patch = resolvePatchIdentifier(identifier, manifest.patches);
  if (!patch) {
    throw new InvalidArgumentError(formatPatchNotFoundError(identifier, manifest.patches), 'park');
  }
  const files = await planPark(paths, patch, options.hunks);
  if (files.length === 0) {
    info(`${patch.filename}: nothing to park; its files match ${options.hunks ?? 'the baseline'}.`);
    return;
  }
  for (const finding of await findOutsideReferrers(paths, manifest, patch, files)) {
    warn(`Parking removes what is still in use: ${finding}. Move it somewhere you own first.`);
  }
  const label =
    options.label ?? `${patch.filename.replace(/\.patch$/, '')}-${Date.now().toString(36)}`;
  for (const file of files) info(`  ${file.path}`);
  if (options.dryRun === true) {
    info(`[dry-run] would park ${files.length} file(s) of ${patch.filename} as "${label}".`);
    return;
  }
  const dir = await writePark(projectRoot, {
    label,
    patch: patch.filename,
    createdAt: new Date().toISOString(),
    mode: options.hunks === undefined ? 'baseline' : 'hunks',
    files,
  });
  for (const file of files) await writeEngineFile(paths.engine, file.path, file.after);
  await appendHistoryBestEffort(
    paths.patches,
    {
      operation: 'park',
      args: { label, patch: patch.filename, files: files.map((file) => file.path) },
      result: 'ok',
    },
    `park ${label}`
  );
  success(`Parked ${files.length} file(s) of ${patch.filename} as "${label}" (${dir}).`);
  info(`Restore with: fireforge park --restore ${label}`);
}

async function runRestore(projectRoot: string, label: string, dryRun: boolean): Promise<void> {
  const paths = getProjectPaths(projectRoot);
  const park = await readPark(projectRoot, label);
  const conflicts: string[] = [];
  const plans: { file: ParkedFile; content: string | null; outcome: string }[] = [];
  for (const file of park.files) {
    const now = await readEngineFile(paths.engine, file.path);
    const plan = await planRestore(file, now);
    plans.push({ file, ...plan });
    if (plan.outcome === 'conflict') conflicts.push(file.path);
  }
  for (const { file, outcome } of plans) info(`  ${file.path}: ${outcome}`);
  if (dryRun) {
    info(`[dry-run] restoring "${label}" would leave ${conflicts.length} conflict(s).`);
    return;
  }
  for (const { file, content, outcome } of plans) {
    if (outcome !== 'unchanged') await writeEngineFile(paths.engine, file.path, content);
  }
  await appendHistoryBestEffort(
    paths.patches,
    {
      operation: 'park-restore',
      args: { label, patch: park.patch, conflicts },
      result: conflicts.length === 0 ? 'ok' : 'conflict',
    },
    `park --restore ${label}`
  );
  if (conflicts.length > 0) {
    throw new GeneralError(
      `Restoring "${label}" left conflict markers in ${conflicts.join(', ')}. Resolve them, ` +
        `then drop the park with "fireforge park --drop ${label}".`
    );
  }
  await dropPark(projectRoot, label);
  success(`Restored "${label}" into ${park.files.length} file(s) of ${park.patch}.`);
}

/**
 * Runs `fireforge park`.
 *
 * @param projectRoot - Project root
 * @param identifier - The patch to park (omitted for --restore/--list/--drop)
 * @param options - See {@link ParkOptions}
 */
export async function parkCommand(
  projectRoot: string,
  identifier: string | undefined,
  options: ParkOptions
): Promise<void> {
  intro('FireForge park');
  const modes = [identifier !== undefined, options.restore, options.list, options.drop].filter(
    (mode) => mode !== undefined && mode !== false
  );
  if (modes.length !== 1) {
    throw new InvalidArgumentError(
      'Pass exactly one of: a patch to park, --restore <label>, --list or --drop <label>.',
      'park'
    );
  }
  if (options.list === true) {
    const parks = await listParks(projectRoot);
    if (parks.length === 0) info('No parks.');
    for (const park of parks) {
      info(`${park.label}  ${park.patch}  ${park.files.length} file(s)  ${park.createdAt}`);
    }
  } else if (options.drop !== undefined) {
    await dropPark(projectRoot, options.drop);
    success(`Dropped park "${options.drop}".`);
  } else if (options.restore !== undefined) {
    await runRestore(projectRoot, options.restore, options.dryRun === true);
  } else if (identifier !== undefined) {
    await runPark(projectRoot, identifier, options);
  }
  outro('Park complete');
}

/** Registers `fireforge park`. */
export function registerPark(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const command = program
    .command('park [patch]')
    .description(
      "Set a session's edits in a patch's files aside (back to the queue-applied baseline, or minus the hunks a diff names) and three-way merge them back later"
    )
    .option('--label <label>', 'Name for the park (default: <patch>-<time>)')
    .option('--hunks <diff>', 'Park only the hunks this diff names, not every drifted line')
    .option('--restore <label>', 'Three-way merge a park back into the engine, then drop it')
    .option('--list', 'List the parks')
    .option('--drop <label>', 'Delete a park without restoring it')
    .option('--dry-run', 'Show what would be parked or restored');
  addWaitLockOption(command).action(
    withErrorHandling(async (patch: string | undefined, options: ParkOptions) => {
      const projectRoot = getProjectRoot();
      if (options.list === true || options.drop !== undefined || options.dryRun === true) {
        await parkCommand(projectRoot, patch, options);
        return;
      }
      await withEngineSessionLock(
        projectRoot,
        'park',
        () => parkCommand(projectRoot, patch, options),
        { waitLockSeconds: resolveWaitLockSeconds(options.waitLock) }
      );
    })
  );
}
