// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch rename <name>` — relabels a patch's filename, manifest
 * `name`, and (optionally) `description` without rewriting the `.patch`
 * file body.
 *
 * Companion to `re-export --files <subset>`. Re-export shrinks the body
 * + `filesAffected`, but leaves the patch's identity describing the
 * pre-shrink scope. Before this verb existed, the only workaround for
 * that drift was `delete` + re-export, which briefly removed the patch
 * from the queue (any forward-import dependent would refuse the
 * re-export until the deleted patch's siblings were rewritten).
 *
 * The filename rename and the manifest mutation happen under the patch
 * directory lock so concurrent exports cannot allocate the new
 * filename, and a filesystem rename failure rolls back before the
 * manifest is touched.
 */

import { rename as fsRename } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import { appendHistory, confirmDestructive } from '../../core/destructive.js';
import { patchNameSlug } from '../../core/patch-export.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifest,
  rewriteStagedDependencyOwners,
  savePatchesManifest,
} from '../../core/patch-manifest.js';
import { buildProjectedManifest, enforcePatchPolicy } from '../../core/patch-policy.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchMetadata, PatchRenameOptions } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { pickDefined } from '../../utils/options.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';

/**
 * Pulls the ordinal-string + category prefix out of a patch filename so
 * the rename keeps the existing ordinal padding verbatim. Returning the
 * literal substring (rather than recomputing from the parsed integer)
 * avoids any chance of the new filename's ordinal differing from the
 * old by a leading-zero count.
 */
function splitPatchFilename(
  filename: string
): { ordinalStr: string; category: string; slug: string } | null {
  const m = /^(\d+)-([a-z]+)-(.+)\.patch$/.exec(filename);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { ordinalStr: m[1], category: m[2], slug: m[3] };
}

/**
 * Inputs for {@link commitRenameUnderLock}. All shape validation and
 * confirmation has already happened in the caller — this helper only
 * owns the under-lock transactional dance.
 */
interface CommitRenameInput {
  patchesDir: string;
  target: PatchMetadata;
  newFilename: string;
  newName: string;
  /** New description value, or `undefined` to leave the field unchanged. */
  newDescription?: string;
  filenameChanging: boolean;
  nameChanging: boolean;
  descriptionChanging: boolean;
  /** Mirrors `--yes`; recorded in the history entry for audit consistency. */
  yes?: boolean;
  /** Mirrors `--force-unsafe`; used for force-mode patchPolicy bypass. */
  forceUnsafe?: boolean;
  /** Project config used when opt-in patchPolicy is present. */
  config: FireForgeConfig;
}

/**
 * Performs the rename's transactional core under the patch directory
 * lock: re-reads the manifest, re-checks for filename collisions,
 * renames the `.patch` file on disk (when applicable), writes the
 * updated manifest, and appends a history entry. Filesystem rename
 * happens before the manifest save so an interrupted run never leaves
 * the manifest pointing at a missing file; a manifest-save failure
 * rolls the filesystem rename back.
 */
async function commitRenameUnderLock(input: CommitRenameInput): Promise<void> {
  const {
    patchesDir,
    target,
    newFilename,
    newName,
    newDescription,
    filenameChanging,
    nameChanging,
    descriptionChanging,
  } = input;

  await withPatchDirectoryLock(patchesDir, async () => {
    const fresh = await loadPatchesManifest(patchesDir);
    if (!fresh) {
      throw new GeneralError('Manifest disappeared between resolution and rename.');
    }
    const idx = fresh.patches.findIndex((p) => p.filename === target.filename);
    if (idx === -1) {
      throw new GeneralError(
        `Patch ${target.filename} disappeared from the manifest during rename. Re-run after investigating.`
      );
    }
    const before = fresh.patches[idx];
    if (!before) {
      throw new GeneralError(
        `Patch ${target.filename} disappeared from the manifest during rename.`
      );
    }

    let oldPath: string | undefined;
    let newPath: string | undefined;
    if (filenameChanging) {
      const collisionInLock = fresh.patches.find(
        (p) => p.filename === newFilename && p.filename !== target.filename
      );
      if (collisionInLock) {
        throw new InvalidArgumentError(
          `Cannot rename to "${newFilename}" — a different patch claimed that filename concurrently.`,
          'patch rename'
        );
      }

      oldPath = join(patchesDir, target.filename);
      newPath = join(patchesDir, newFilename);

      if (await pathExists(newPath)) {
        throw new InvalidArgumentError(
          `Cannot rename: ${newFilename} already exists on disk. Resolve manually before retrying.`,
          'patch rename'
        );
      }

      fresh.patches[idx] = {
        ...before,
        filename: newFilename,
        name: newName,
        ...(descriptionChanging ? { description: newDescription ?? '' } : {}),
      };
      // Staged-dependency owners on other patches reference the old
      // filename; remap them so forward-import declarations survive the
      // rename instead of dangling.
      const ownerLookup = (old: string): string | undefined =>
        old === target.filename ? newFilename : undefined;
      fresh.patches = fresh.patches.map((p) => rewriteStagedDependencyOwners(p, ownerLookup));
    } else {
      fresh.patches[idx] = {
        ...before,
        ...(nameChanging ? { name: newName } : {}),
        ...(descriptionChanging ? { description: newDescription ?? '' } : {}),
      };
    }

    enforcePatchPolicy({
      config: input.config,
      manifest: buildProjectedManifest(fresh, fresh.patches),
      command: 'patch rename',
      forceUnsafe: input.forceUnsafe === true,
    });

    if (filenameChanging && oldPath !== undefined && newPath !== undefined) {
      await fsRename(oldPath, newPath);
      try {
        await savePatchesManifest(patchesDir, fresh);
      } catch (saveError: unknown) {
        try {
          await fsRename(newPath, oldPath);
        } catch (rollbackError: unknown) {
          warn(
            `Rollback warning: could not restore ${target.filename} after manifest write failure: ${toError(rollbackError).message}`
          );
        }
        throw saveError;
      }
    } else {
      await savePatchesManifest(patchesDir, fresh);
    }

    try {
      await appendHistory(patchesDir, {
        operation: 'patch-rename',
        args: {
          oldFilename: target.filename,
          newFilename,
          oldName: target.name,
          newName,
          ...(descriptionChanging ? { oldDescription: target.description, newDescription } : {}),
        },
        ...(input.yes === true ? { yes: true } : {}),
        ...(input.forceUnsafe === true ? { unsafeOverride: true } : {}),
        result: 'ok',
      });
    } catch (historyError: unknown) {
      warn(
        `History log append failed after patch rename committed (${newFilename}): ${toError(historyError).message}`
      );
    }
  });
}

/**
 * Runs the `patch rename` command: relabels filename + manifest entry
 * for a single patch atomically.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename, ordinal, or manifest `name`
 * @param options - Command options (`--to <new-name>` is required)
 */
export async function patchRenameCommand(
  projectRoot: string,
  identifier: string,
  options: PatchRenameOptions = {}
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge patch rename (dry run)' : 'FireForge patch rename');

  if (options.to === undefined || options.to.trim() === '') {
    throw new InvalidArgumentError(
      'Specify --to <new-name>. The new name is sanitised into the filename slug the same way `export --name` is.',
      'patch rename'
    );
  }

  const config = await loadConfig(projectRoot);
  const { paths, manifest } = await requirePatchQueue(projectRoot);
  const target = requirePatchTarget(identifier, manifest.patches);

  const split = splitPatchFilename(target.filename);
  if (!split) {
    throw new GeneralError(
      `Cannot rename ${target.filename}: filename does not match the expected {ordinal}-{category}-{slug}.patch convention. Re-export the patch instead.`
    );
  }

  const newSlug = patchNameSlug(options.to, split.category);
  if (newSlug === '') {
    throw new InvalidArgumentError(
      '--to must contain at least one alphanumeric character after sanitisation.',
      'patch rename'
    );
  }

  const newFilename = `${split.ordinalStr}-${split.category}-${newSlug}.patch`;
  const filenameChanging = newFilename !== target.filename;
  const nameChanging = options.to !== target.name;
  const descriptionChanging =
    options.description !== undefined && options.description !== target.description;

  if (!filenameChanging && !nameChanging && !descriptionChanging) {
    info(
      `${target.filename}: nothing to change — filename already "${target.filename}" ` +
        `(slug of "${options.to}" is "${newSlug}"), name already "${target.name}"` +
        (options.description !== undefined ? ', description already matches' : '') +
        '.'
    );
    outro(isDryRun ? 'Dry run complete — no changes made' : 'Patch rename (no-op)');
    return;
  }

  // Pre-flight collision check against the manifest snapshot we already
  // loaded. The authoritative check happens again inside the lock to
  // close the TOCTOU window — surface a helpful error here when the
  // collision is obvious so the operator does not get surprised by a
  // late refusal after a confirmation prompt.
  if (filenameChanging) {
    const collision = manifest.patches.find(
      (p) => p.filename === newFilename && p.filename !== target.filename
    );
    if (collision) {
      throw new InvalidArgumentError(
        `Cannot rename to "${newFilename}" — a different patch already uses that filename.`,
        'patch rename'
      );
    }
  }

  const summary: string[] = [];
  if (filenameChanging) {
    summary.push(`rename ${target.filename} → ${newFilename}`);
  }
  if (nameChanging) {
    summary.push(`name: "${target.name}" → "${options.to}"`);
  }
  if (descriptionChanging) {
    summary.push(
      `description: "${target.description || '(none)'}" → "${options.description ?? '(none)'}"`
    );
  }

  enforcePatchPolicy({
    config,
    manifest: buildProjectedManifest(
      manifest,
      manifest.patches.map((entry) =>
        entry.filename === target.filename
          ? {
              ...entry,
              filename: newFilename,
              name: nameChanging ? (options.to ?? entry.name) : entry.name,
              ...(descriptionChanging ? { description: options.description ?? '' } : {}),
            }
          : entry
      )
    ),
    command: 'patch rename',
    forceUnsafe: options.forceUnsafe === true,
  });

  const decision = await confirmDestructive({
    operation: 'patch-rename',
    title: `Rename ${target.filename}`,
    summary,
    yes: options.yes === true,
    dryRun: isDryRun,
    conflicts: null,
  });

  if (decision === 'dry-run') {
    outro('Dry run complete — no changes made');
    return;
  }
  if (decision === 'cancelled') {
    outro('Rename cancelled');
    return;
  }

  await commitRenameUnderLock({
    patchesDir: paths.patches,
    target,
    newFilename,
    newName: options.to,
    ...(options.description !== undefined ? { newDescription: options.description } : {}),
    filenameChanging,
    nameChanging,
    descriptionChanging,
    ...(options.yes === true ? { yes: true } : {}),
    ...(options.forceUnsafe === true ? { forceUnsafe: true } : {}),
    config,
  });

  if (filenameChanging) {
    info(`${target.filename} → ${newFilename}`);
  } else {
    info(`${target.filename}: metadata updated.`);
  }
  outro('Patch rename complete');
}

/**
 * Registers the `patch rename` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchRename(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  parent
    .command('rename <name>')
    .description(
      'Rename a patch: filename + manifest name (and optional description) update without rewriting the .patch body.'
    )
    .requiredOption(
      '--to <new-name>',
      'New human-readable name, category-prefixed slug, or full filename stem (normalised into the filename slug)'
    )
    .option(
      '-d, --description <text>',
      'Replacement description (omit to leave description unchanged)'
    )
    .option('--dry-run', 'Show what would change without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option('--force-unsafe', 'Bypass force-mode patchPolicy refusals')
    .action(
      withErrorHandling(
        async (
          name: string,
          options: {
            to?: string;
            description?: string;
            dryRun?: boolean;
            yes?: boolean;
            forceUnsafe?: boolean;
          }
        ) => {
          await patchRenameCommand(getProjectRoot(), name, pickDefined(options));
        }
      )
    );
}
