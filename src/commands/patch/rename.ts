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
import {
  buildPatchQueueContext,
  formatPatchLintIssue,
  lintPatchQueue,
} from '../../core/patch-lint.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifest,
  rewriteStagedDependencyOwners,
  savePatchesManifest,
} from '../../core/patch-manifest.js';
import {
  buildProjectedManifest,
  enforcePatchPolicy,
  getPatchPolicyCategories,
  isCategoryAllowedByConfig,
} from '../../core/patch-policy.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchMetadata, PatchRenameOptions } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import {
  addWaitLockOption,
  commanderArgParser,
  pickDefined,
  resolveWaitLockSeconds,
} from '../../utils/options.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';
import { projectReorder } from './reorder.js';

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
  /** New manifest order (only when `orderChanging`). */
  newOrder?: number;
  /** New manifest category (only when `categoryChanging`). */
  newCategory?: string;
  filenameChanging: boolean;
  nameChanging: boolean;
  descriptionChanging: boolean;
  orderChanging: boolean;
  categoryChanging: boolean;
  /** Mirrors `--yes`; recorded in the history entry for audit consistency. */
  yes?: boolean;
  /** Mirrors `--force-unsafe`; used for force-mode patchPolicy bypass. */
  forceUnsafe?: boolean;
  /** Project config used when opt-in patchPolicy is present. */
  config: FireForgeConfig;
  /** Wait budget for the patch directory lock (resolved `--wait-lock`). */
  waitLockSeconds?: number | undefined;
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
    orderChanging,
    categoryChanging,
  } = input;
  const identityUpdates = {
    ...(orderChanging && input.newOrder !== undefined ? { order: input.newOrder } : {}),
    ...(categoryChanging && input.newCategory !== undefined ? { category: input.newCategory } : {}),
  };

  await withPatchDirectoryLock(
    patchesDir,
    async () => {
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

      if (orderChanging && input.newOrder !== undefined) {
        const orderHolder = fresh.patches.find(
          (p) => p.order === input.newOrder && p.filename !== target.filename
        );
        if (orderHolder) {
          throw new InvalidArgumentError(
            `Order ${String(input.newOrder)} was claimed by ${orderHolder.filename} concurrently. Pick an unused order, or use "fireforge patch reorder" to renumber siblings.`,
            '--order'
          );
        }
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
          ...identityUpdates,
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
          ...identityUpdates,
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
            ...(orderChanging ? { oldOrder: target.order, newOrder: input.newOrder } : {}),
            ...(categoryChanging
              ? { oldCategory: target.category, newCategory: input.newCategory }
              : {}),
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
    },
    { waitLockSeconds: input.waitLockSeconds, command: 'patch rename' }
  );
}

/** Resolved shape of a rename: new identity fields + what is changing. */
interface RenamePlan {
  hasTo: boolean;
  newCategory: string;
  newSlug: string;
  newFilename: string;
  filenameChanging: boolean;
  nameChanging: boolean;
  descriptionChanging: boolean;
  orderChanging: boolean;
  categoryChanging: boolean;
}

/** Validates the flags and resolves the new filename/identity fields. */
function resolveRenamePlan(
  target: PatchMetadata,
  options: PatchRenameOptions,
  config: FireForgeConfig
): RenamePlan {
  const hasTo = options.to !== undefined && options.to.trim() !== '';
  if (
    !hasTo &&
    options.category === undefined &&
    options.order === undefined &&
    options.description === undefined
  ) {
    throw new InvalidArgumentError(
      'Specify at least one of --to <new-name>, --category <category>, --order <n>, or --description. --to is sanitised into the filename slug the same way `export --name` is.',
      'patch rename'
    );
  }

  const split = splitPatchFilename(target.filename);
  if (!split) {
    throw new GeneralError(
      `Cannot rename ${target.filename}: filename does not match the expected {ordinal}-{category}-{slug}.patch convention. Re-export the patch instead.`
    );
  }

  const newCategory = options.category ?? split.category;
  if (options.category !== undefined && !isCategoryAllowedByConfig(config, options.category)) {
    throw new InvalidArgumentError(
      `Invalid category. Must be one of: ${getPatchPolicyCategories(config).join(', ')}`,
      '--category'
    );
  }

  // Keep the existing slug verbatim when --to is absent: re-running
  // `patchNameSlug` against a different category could strip a
  // category-looking prefix out of an established slug.
  const newSlug =
    hasTo && options.to !== undefined ? patchNameSlug(options.to, newCategory) : split.slug;
  if (newSlug === '') {
    throw new InvalidArgumentError(
      '--to must contain at least one alphanumeric character after sanitisation.',
      'patch rename'
    );
  }

  // Preserve the ordinal's zero-padding width; a wider order simply
  // prints unpadded-longer.
  const newOrdinalStr =
    options.order !== undefined
      ? String(options.order).padStart(split.ordinalStr.length, '0')
      : split.ordinalStr;
  const newFilename = `${newOrdinalStr}-${newCategory}-${newSlug}.patch`;

  return {
    hasTo,
    newCategory,
    newSlug,
    newFilename,
    filenameChanging: newFilename !== target.filename,
    nameChanging: hasTo && options.to !== target.name,
    descriptionChanging:
      options.description !== undefined && options.description !== target.description,
    orderChanging: options.order !== undefined && options.order !== target.order,
    categoryChanging:
      options.category !== undefined &&
      (options.category !== target.category || options.category !== split.category),
  };
}

/**
 * Pre-flight refusals: order collision (with a pointer to the verb that
 * renumbers siblings — `--order` means "this exact unused sparse slot",
 * mirroring `export --order`), projected cross-patch lint on an order
 * change (forward imports resolve by queue position, FORGE J10), and the
 * filename collision. The authoritative collision checks run again inside
 * the lock to close the TOCTOU window.
 */
async function assertRenamePreconditions(
  patchesDir: string,
  manifest: { patches: PatchMetadata[] },
  target: PatchMetadata,
  plan: RenamePlan,
  options: PatchRenameOptions,
  config: FireForgeConfig
): Promise<void> {
  if (plan.orderChanging && options.order !== undefined) {
    const holder = manifest.patches.find(
      (p) => p.order === options.order && p.filename !== target.filename
    );
    if (holder) {
      throw new InvalidArgumentError(
        `Order ${String(options.order)} is already used by ${holder.filename}. Pick an unused order, or use "fireforge patch reorder ${target.filename} --to ${String(options.order)}" to renumber siblings.`,
        '--order'
      );
    }
    if (options.forceUnsafe !== true) {
      const baseCtx = await buildPatchQueueContext(patchesDir, config);
      const projected = projectReorder(
        baseCtx,
        new Map([[target.filename, { newFilename: plan.newFilename, newOrder: options.order }]])
      );
      const projectedErrors = lintPatchQueue(projected).filter((i) => i.severity === 'error');
      if (projectedErrors.length > 0) {
        throw new InvalidArgumentError(
          `Refusing to run patch rename: the order change would introduce ${String(projectedErrors.length)} cross-patch lint error(s):\n  ${projectedErrors
            .map(formatPatchLintIssue)
            .join('\n  ')}\nPass --force-unsafe to override.`,
          '--force-unsafe'
        );
      }
    }
  }

  if (plan.filenameChanging) {
    const collision = manifest.patches.find(
      (p) => p.filename === plan.newFilename && p.filename !== target.filename
    );
    if (collision) {
      throw new InvalidArgumentError(
        `Cannot rename to "${plan.newFilename}" — a different patch already uses that filename.`,
        'patch rename'
      );
    }
  }
}

/** Change-summary lines shown by the confirmation prompt. */
function buildRenameSummary(
  target: PatchMetadata,
  plan: RenamePlan,
  options: PatchRenameOptions
): string[] {
  const summary: string[] = [];
  if (plan.filenameChanging) {
    summary.push(`rename ${target.filename} → ${plan.newFilename}`);
  }
  if (plan.nameChanging) {
    summary.push(`name: "${target.name}" → "${options.to}"`);
  }
  if (plan.descriptionChanging) {
    summary.push(
      `description: "${target.description || '(none)'}" → "${options.description ?? '(none)'}"`
    );
  }
  if (plan.orderChanging && options.order !== undefined) {
    summary.push(`order: ${String(target.order)} → ${String(options.order)}`);
  }
  if (plan.categoryChanging) {
    summary.push(`category: ${target.category} → ${plan.newCategory}`);
  }
  return summary;
}

/**
 * Runs the `patch rename` command: relabels filename + manifest entry
 * (name, category, order, description) for a single patch atomically.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename, ordinal, or manifest `name`
 * @param options - Command options (at least one change flag required)
 */
export async function patchRenameCommand(
  projectRoot: string,
  identifier: string,
  options: PatchRenameOptions = {}
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge patch rename (dry run)' : 'FireForge patch rename');

  const config = await loadConfig(projectRoot);
  const { paths, manifest } = await requirePatchQueue(projectRoot);
  const target = requirePatchTarget(identifier, manifest.patches);

  const plan = resolveRenamePlan(target, options, config);
  const {
    hasTo,
    newCategory,
    newSlug,
    newFilename,
    filenameChanging,
    nameChanging,
    descriptionChanging,
    orderChanging,
    categoryChanging,
  } = plan;

  if (
    !filenameChanging &&
    !nameChanging &&
    !descriptionChanging &&
    !orderChanging &&
    !categoryChanging
  ) {
    info(
      `${target.filename}: nothing to change — filename already "${target.filename}"` +
        (hasTo && options.to !== undefined ? ` (slug of "${options.to}" is "${newSlug}")` : '') +
        `, name already "${target.name}"` +
        (options.description !== undefined ? ', description already matches' : '') +
        '.'
    );
    outro(isDryRun ? 'Dry run complete — no changes made' : 'Patch rename (no-op)');
    return;
  }

  await assertRenamePreconditions(paths.patches, manifest, target, plan, options, config);

  const summary = buildRenameSummary(target, plan, options);

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
              ...(orderChanging && options.order !== undefined ? { order: options.order } : {}),
              ...(categoryChanging ? { category: newCategory } : {}),
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
    newName: hasTo && options.to !== undefined ? options.to : target.name,
    ...(options.description !== undefined ? { newDescription: options.description } : {}),
    ...(orderChanging && options.order !== undefined ? { newOrder: options.order } : {}),
    ...(categoryChanging ? { newCategory } : {}),
    filenameChanging,
    nameChanging,
    descriptionChanging,
    orderChanging,
    categoryChanging,
    ...(options.yes === true ? { yes: true } : {}),
    ...(options.forceUnsafe === true ? { forceUnsafe: true } : {}),
    config,
    waitLockSeconds: resolveWaitLockSeconds(options.waitLock),
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
  const command = parent
    .command('rename <name>')
    .description(
      'Rename a patch: filename, manifest name, category, order, and/or description update in one transaction without rewriting the .patch body.'
    )
    .option(
      '--to <new-name>',
      'New human-readable name, category-prefixed slug, or full filename stem (normalised into the filename slug)'
    )
    .option(
      '--category <category>',
      'New category for the patch (validated against configured categories); rewrites the filename prefix and manifest row in one transaction'
    )
    .option(
      '--order <n>',
      'Move the patch to this exact unused order; refuses on collision — use "patch reorder" to renumber siblings',
      commanderArgParser((raw: string) => {
        const n = Number.parseInt(raw, 10);
        if (!Number.isInteger(n) || n <= 0) {
          throw new InvalidArgumentError(
            `--order must be a positive integer, got "${raw}".`,
            '--order'
          );
        }
        return n;
      })
    )
    .option(
      '-d, --description <text>',
      'Replacement description (omit to leave description unchanged)'
    )
    .option('--dry-run', 'Show what would change without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option('--force-unsafe', 'Bypass force-mode patchPolicy refusals');
  addWaitLockOption(command).action(
    withErrorHandling(
      async (
        name: string,
        options: {
          to?: string;
          category?: string;
          order?: number;
          description?: string;
          dryRun?: boolean;
          yes?: boolean;
          forceUnsafe?: boolean;
          waitLock?: number | boolean;
        }
      ) => {
        await patchRenameCommand(getProjectRoot(), name, pickDefined(options));
      }
    )
  );
}
