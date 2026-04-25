// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch tier <name>` — sets or clears `PatchMetadata.tier` on
 * a single patch without rewriting the `.patch` file body.
 *
 * Companion to `fireforge re-export <name> --tier <tier>`. Re-export is
 * the right tool when the patch body itself needs to be regenerated; this
 * subcommand exists for the metadata-only adjustment, where the operator
 * has discovered (e.g. from a `lint --per-patch` warning) that the
 * threshold-tier override should be set but the patch body is already
 * correct. Avoiding the re-export saves the engine read + diff
 * regeneration roundtrip and leaves the `.patch` file's mtime alone.
 *
 * Modes are mutually exclusive: exactly one of `--tier <branding>` or
 * `--clear` must be supplied per invocation.
 */

import { Command, Option } from 'commander';

import { getProjectPaths } from '../../core/config.js';
import { appendHistory } from '../../core/destructive.js';
import { updatePatchMetadata } from '../../core/patch-export.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchTierOptions } from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { pickDefined } from '../../utils/options.js';

/**
 * Runs the `patch tier` command: updates `PatchMetadata.tier` on the
 * named patch (or clears the field) and writes the manifest.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename, ordinal, or manifest `name`
 * @param options - Command options
 */
export async function patchTierCommand(
  projectRoot: string,
  identifier: string,
  options: PatchTierOptions = {}
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge patch tier (dry run)' : 'FireForge patch tier');

  // Mode mutex: a single invocation either sets or clears the tier.
  // Combining both is ambiguous — the operator's intent is not obvious
  // and silently picking one would mask the typo.
  const setting = options.tier !== undefined;
  const clearing = options.clear === true;
  if (setting && clearing) {
    throw new InvalidArgumentError(
      '--tier and --clear are mutually exclusive. Pick one mode per invocation.',
      'patch tier'
    );
  }
  if (!setting && !clearing) {
    throw new InvalidArgumentError(
      'Specify --tier <tier> to set the override, or --clear to remove it.',
      'patch tier'
    );
  }

  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.patches))) {
    throw new GeneralError('Patches directory not found.');
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }

  const target = resolvePatchIdentifier(identifier, manifest.patches);
  if (!target) {
    const available = manifest.patches
      .map((p) =>
        p.name && p.name !== p.filename ? `${p.filename} (name: ${p.name})` : p.filename
      )
      .join(', ');
    throw new InvalidArgumentError(
      `Patch "${identifier}" not found. Accepted identifiers: ordinal (e.g. 2), filename (e.g. 002-ui-foo.patch), or manifest name (e.g. ui-foo). Available: ${available}`,
      identifier
    );
  }

  const before = target.tier;
  const after: 'branding' | undefined = setting ? options.tier : undefined;

  if (before === after) {
    info(
      after === undefined
        ? `${target.filename}: tier is already absent — no change.`
        : `${target.filename}: tier is already "${after}" — no change.`
    );
    outro(isDryRun ? 'Dry run complete — no changes made' : 'Patch tier (no-op)');
    return;
  }

  const action =
    after === undefined
      ? `clear tier (was "${before}")`
      : before === undefined
        ? `set tier to "${after}"`
        : `change tier from "${before}" to "${after}"`;

  if (isDryRun) {
    info(`[dry-run] ${target.filename}: would ${action}.`);
    outro('Dry run complete — no changes made');
    return;
  }

  // Single write under the patch directory lock (delegated inside
  // updatePatchMetadata). Setting routes through `updates`; clearing
  // routes through `unsetFields` so TypeScript's exact optional types
  // do not have to carry an explicit `undefined` on the `tier` field.
  if (after !== undefined) {
    await updatePatchMetadata(paths.patches, target.filename, { tier: after });
  } else {
    await updatePatchMetadata(paths.patches, target.filename, {}, ['tier']);
  }

  try {
    await appendHistory(paths.patches, {
      operation: 'patch-tier',
      args: {
        filename: target.filename,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      },
      ...(options.yes === true ? { yes: true } : {}),
      result: 'ok',
    });
  } catch (historyError: unknown) {
    warn(
      `History log append failed after patch tier committed (${target.filename}): ${toError(historyError).message}`
    );
  }

  info(`${target.filename}: ${action}.`);
  outro('Patch tier complete');
}

/**
 * Registers the `patch tier` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchTier(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  parent
    .command('tier <name>')
    .description(
      'Set or clear PatchMetadata.tier on a single patch (no .patch body rewrite). Use --tier <branding> to set, --clear to remove.'
    )
    .addOption(
      new Option(
        '--tier <tier>',
        'Force the tier override on the patch (only "branding" recognised)'
      ).choices(['branding'])
    )
    .option('--clear', 'Remove the tier override (restores tier auto-detection)')
    .option('--dry-run', 'Show what would change without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .action(
      withErrorHandling(
        async (
          name: string,
          options: { tier?: string; clear?: boolean; dryRun?: boolean; yes?: boolean }
        ) => {
          const { tier, ...rest } = options;
          await patchTierCommand(getProjectRoot(), name, {
            ...pickDefined(rest),
            ...(tier !== undefined ? { tier: tier as 'branding' } : {}),
          });
        }
      )
    );
}
