// SPDX-License-Identifier: EUPL-1.2
/**
 * CLI registration for `fireforge re-export`.
 *
 * Split out of `re-export.ts`, which was otherwise over the per-file line
 * cap. The split direction matches the existing `re-export-scan.ts` /
 * `re-export-options.ts` boundary. Folding `re-export-files.ts` back into
 * the orchestrator would go the wrong way.
 */

import { Command, Option } from 'commander';

import { withEngineSessionLock } from '../core/engine-session-lock.js';
import type { CommandContext } from '../types/cli.js';
import type { ReExportOptions } from '../types/commands/index.js';
import {
  addWaitLockOption,
  pickDefined,
  resolveWaitLockSeconds,
  stringListOption,
} from '../utils/options.js';
import { reExportCommand } from './re-export.js';
import { preflightReExportArguments, readPathListFile } from './re-export-preflight.js';

/** Registers the re-export command on the CLI program. */
export function registerReExport(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const reExport = program
    .command('re-export [patches...]')
    .description(
      'Refresh existing patch bodies (and filesAffected with --scan) from the current engine ' +
        'state. Does NOT change sourceVersion/sourceProduct by default — use --stamp or run ' +
        'rebase for source metadata stamping.'
    )
    .option('-a, --all', 'Re-export all patches')
    .option('-s, --scan', 'Scan directories for new/removed files and update filesAffected')
    .option(
      '--scan-file <path>',
      'With --scan, add this explicit engine-relative file without collecting adjacent files. Prefix the owning patch (<patch>:<path>, required with several target patches) to adopt into one of them; selected patches without a --scan-file refresh scan-less. Repeatable.',
      ...stringListOption()
    )
    .option(
      '--scan-files <manifest>',
      'With --scan, bulk-assign generated files from a JSON manifest: {"assignments":[{"patch":"002-name.patch","files":["path"]}]}. Selects patches from the manifest.'
    )
    .option(
      '--files <paths>',
      'Restrict the re-exported filesAffected to this comma-separated list (single target patch only)',
      (value: string) =>
        value
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
    )
    .option(
      '--refuse-adjacent-unmanaged',
      'Refuse a scan-less re-export (non-zero exit, patch not written) when unmanaged files exist adjacent to the patch ownership, instead of warning. Adjacent means the same directory as an owned file (not a sibling or nested directory), or named by a registration line the patch adds. Mutually exclusive with --scan and --files.'
    )
    .option(
      '--refuse-foreign-drift',
      "Refuse a re-export (non-zero exit, patch not written) when the refreshed body would add or drop lines, in a file the patch already owns, that the old patch body did not carry — protects multi-session checkouts from silently capturing another session's uncommitted edits. Beside --scan it guards each patch's existing files (adopted files count as expected). Mutually exclusive with --files."
    )
    .option(
      '--expect <path>',
      "With --refuse-foreign-drift, name an engine-relative file whose drift is this session's intended edit: drift confined to --expect files proceeds, drift anywhere else still refuses. Repeatable, and the whitelist applies across EVERY patch in this invocation, not per patch — so pass all the patches and all their --expect paths in one call rather than looping one patch at a time.",
      ...stringListOption()
    )
    .option(
      '--expect-unmanaged <path>',
      'With --refuse-adjacent-unmanaged, name an engine-relative file that is a REVIEWED, recorded exception to the adjacency refusal: an approved unmanaged path is still listed, but no longer refuses. Repeatable, and the carve-out applies across EVERY patch in this invocation, not per patch. Use it to keep the belt armed for everything else instead of dropping --refuse-adjacent-unmanaged entirely.',
      ...stringListOption()
    )
    .option(
      '--expect-from <file>',
      'Read --expect paths from a file, one engine-relative path per line (blank lines and # comments ignored). Adds to any --expect flags.'
    )
    .option(
      '--expect-new <path>',
      'With --refuse-adjacent-unmanaged, name a file this session created and will adopt with its next export (or --scan-file): it passes the belt and is reported, while every other adjacent file still refuses. Must be changed in engine/ and owned by no patch. Repeatable.',
      ...stringListOption()
    )
    .option(
      '--adjacent-ignore <path|glob>',
      'With --refuse-adjacent-unmanaged, a reviewed ignore-list entry: an engine-relative path, or a glob whose * stays within one path segment (** is refused). Matches are reported, never refused. Repeatable.',
      ...stringListOption()
    )
    .option(
      '--expect-removed <path>',
      'Retire a file from the selected patch while keeping scan-less refusals armed: an absent file the patch created, or a patch-modified upstream file whose engine copy is back at HEAD. Repeatable.',
      ...stringListOption()
    )
    .option('--dry-run', 'Show what would change without writing')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .option('--no-cache', 'Bypass per-patch lint result cache reads and writes for this re-export')
    .option(
      '--allow-stale-furnace',
      'Export the deployed engine copy even when the components/ source changed since the last furnace apply'
    )
    .option(
      '--allow-shrink',
      'Allow --files to remove paths currently owned by the patch. Required before --yes can bypass the shrink confirmation.'
    )
    .option('-y, --yes', 'Skip confirmation prompts (required for non-TTY destructive writes)')
    .option('--force-unsafe', 'Bypass cross-patch lint refusal when --files shrinks a patch')
    .option(
      '--stamp',
      "After every selected patch refreshes cleanly, stamp each re-exported patch's sourceVersion/sourceProduct in patches.json to firefox.version/firefox.product from fireforge.json. No effect on a partial run."
    )
    .addOption(
      new Option(
        '--tier <tier>',
        'Force a tier override on the selected patch (only "branding" recognised). Mutually exclusive with --all.'
      ).choices(['branding'])
    )
    .option(
      '--lint-ignore <check-id>',
      'Append a lint check ID to the patch\'s PatchMetadata.lintIgnore (union, de-duped, repeatable). Mutually exclusive with --all. Use "fireforge patch lint-ignore" for --remove / --clear.',
      ...stringListOption()
    );
  addWaitLockOption(reExport).action(
    withErrorHandling(async (patches: string[], options: ReExportCliOptions) => {
      const projectRoot = getProjectRoot();
      const reExportOptions = await toReExportOptions(options);
      // Refuse what the locked run would refuse before queueing for the
      // lock, which can be a long wait under contention.
      await preflightReExportArguments(projectRoot, patches, reExportOptions);
      await withEngineSessionLock(
        projectRoot,
        're-export',
        () => reExportCommand(projectRoot, patches, reExportOptions),
        { waitLockSeconds: resolveWaitLockSeconds(options.waitLock) }
      );
    })
  );
}

/** Raw commander options for `re-export`, before renaming and list reads. */
interface ReExportCliOptions {
  all?: boolean;
  scan?: boolean;
  scanFile?: string[];
  scanFiles?: string;
  files?: string[];
  refuseAdjacentUnmanaged?: boolean;
  refuseForeignDrift?: boolean;
  expect?: string[];
  expectUnmanaged?: string[];
  expectFrom?: string;
  expectNew?: string[];
  adjacentIgnore?: string[];
  expectRemoved?: string[];
  dryRun?: boolean;
  skipLint?: boolean;
  yes?: boolean;
  allowShrink?: boolean;
  allowStaleFurnace?: boolean;
  forceUnsafe?: boolean;
  stamp?: boolean;
  tier?: string;
  lintIgnore?: string[];
  waitLock?: number | boolean;
  cache?: boolean;
}

/**
 * Maps commander's option names onto {@link ReExportOptions}, reading the
 * `--expect-from` list into `expect` and dropping empty repeatables.
 */
async function toReExportOptions(options: ReExportCliOptions): Promise<ReExportOptions> {
  const {
    tier,
    lintIgnore,
    scanFile,
    scanFiles,
    cache,
    expect: expectFlags,
    expectFrom,
    expectUnmanaged,
    expectNew,
    adjacentIgnore,
    ...rest
  } = options;
  const expect = [
    ...(expectFlags ?? []),
    ...(expectFrom !== undefined ? await readPathListFile(expectFrom, '--expect-from') : []),
  ];
  return {
    ...pickDefined({
      ...rest,
      scanFiles: nonEmpty(scanFile),
      scanFilesManifest: scanFiles,
      tier: tier as 'branding' | undefined,
      lintIgnore: nonEmpty(lintIgnore),
      expect: nonEmpty(expect),
      expectUnmanaged: nonEmpty(expectUnmanaged),
      expectNew: nonEmpty(expectNew),
      adjacentIgnore: nonEmpty(adjacentIgnore),
    }),
    ...(cache === false ? { noCache: true } : {}),
  };
}

/** The list when it has entries, else undefined (which `pickDefined` drops). */
function nonEmpty(values: string[] | undefined): string[] | undefined {
  return values !== undefined && values.length > 0 ? values : undefined;
}
