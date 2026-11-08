// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { Command } from 'commander';

import { wantsMachineOutput } from '../cli-usage-error.js';
import { resolveStaticDonor } from '../core/authored/donor.js';
import { exportAuthoredQueue } from '../core/authored/export-queue.js';
import {
  authenticateAuthoredSnapshot,
  captureAuthoredSnapshot,
  declareAuthoredOverride,
  generateAuthoredDelta,
  materializeAuthoredSnapshot,
  migrateLegacyQueue,
  refreshAuthoredSnapshot,
  removeAuthoredOverride,
} from '../core/authored/index.js';
import {
  authoredMergeDriverInstalled,
  installAuthoredMergeDriver,
  runAuthoredMergeDriver,
} from '../core/authored/merge.js';
import { fetchPristineDonor } from '../core/authored/pristine.js';
import type { AuthoredSnapshot } from '../core/authored/types.js';
import { loadConfig } from '../core/config.js';
import { validateConfig } from '../core/config-validate.js';
import { CommandError, GeneralError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import type { CommandContext } from '../types/cli.js';
import type { FirefoxConfig } from '../types/config.js';
import { setMachineOutputMode } from '../utils/logger.js';
import { isObject } from '../utils/validation.js';
import { registerAuthoredFeedback } from './authored-feedback.js';
import { assertSourceMode, printData, printResult } from './job-support.js';

interface CaptureOptions {
  path: string[];
  out: string;
  pristineRepository?: string;
  allowDirtyRoot?: boolean;
}
interface SnapshotOptions {
  snapshot: string;
  pristineRepository?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function readSnapshot(path: string, pristineRepository?: string): Promise<AuthoredSnapshot> {
  const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'));
  return authenticateAuthoredSnapshot(value, pristineRepository);
}

function printNotice(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Source commands never capture ignored engine edits or mutate a production ref. */
export function registerAuthored(program: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  const command = program
    .command('authored')
    .description('Capture tracked source, review upstream deltas and materialize frozen inputs')
    .option('--json', 'Write one JSON document, or an error envelope');
  command.hook('preAction', () => {
    setMachineOutputMode(true);
  });
  command
    .command('capture')
    .description('Capture what a commit of this checkout would hold, with a private Git index')
    .option(
      '--path <path>',
      'Extra project-relative input beyond the source and project roots, repeatable',
      collect,
      []
    )
    .requiredOption('--out <file>', 'Write the immutable snapshot handle here')
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .option('--allow-dirty-root', 'Capture with changed files outside the selection left out')
    .action(
      withErrorHandling(async (options: CaptureOptions) => {
        await assertSourceMode(getProjectRoot());
        const snapshot = await captureAuthoredSnapshot({
          projectRoot: getProjectRoot(),
          intendedPaths: options.path,
          onNotice: printNotice,
          ...(options.allowDirtyRoot ? { allowDirtyRoot: true } : {}),
          pristineRepository: await resolveStaticDonor(
            getProjectRoot(),
            options.pristineRepository && resolve(options.pristineRepository)
          ),
        });
        const destination = resolve(options.out);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, JSON.stringify(snapshot, null, 2) + '\n');
        printResult(
          { snapshot: snapshot.id, tree: snapshot.tree, out: destination },
          `${snapshot.id} ${snapshot.tree}`
        );
      })
    );
  command
    .command('status')
    .description('Validate source classification and authenticated upstream declarations')
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .option('--allow-dirty-root', 'Capture with changed files outside the selection left out')
    .action(
      withErrorHandling(
        async (options: { pristineRepository?: string; allowDirtyRoot?: boolean }) => {
          await assertSourceMode(getProjectRoot());
          const snapshot = await captureAuthoredSnapshot({
            projectRoot: getProjectRoot(),
            retain: false,
            onNotice: printNotice,
            ...(options.allowDirtyRoot ? { allowDirtyRoot: true } : {}),
            pristineRepository: await resolveStaticDonor(
              getProjectRoot(),
              options.pristineRepository && resolve(options.pristineRepository)
            ),
          });
          const counts = Object.fromEntries(
            ['created', 'override', 'delete', 'generated'].map((kind) => [
              kind,
              snapshot.files.filter((file) => file.kind === kind).length,
            ])
          );
          printResult(
            { snapshot: snapshot.id, tree: snapshot.tree, files: counts },
            `${snapshot.id} ${snapshot.tree} ${Object.entries(counts)
              .map(([kind, count]) => `${kind}=${String(count)}`)
              .join(' ')}`
          );
        }
      )
    );
  command
    .command('delta')
    .description('Read exact generated source deltas without reading engine worktree bytes')
    .requiredOption('--snapshot <file>', 'Captured immutable snapshot handle')
    .option('--upstream', 'Only upstream overrides and explicit deletions')
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .action(
      withErrorHandling(async (options: SnapshotOptions & { upstream?: boolean }) => {
        const donor = await resolveStaticDonor(
          getProjectRoot(),
          options.pristineRepository && resolve(options.pristineRepository)
        );
        const delta = await generateAuthoredDelta(await readSnapshot(options.snapshot, donor), {
          pristineRepository: donor,
          ...(options.upstream ? { upstreamOnly: true } : {}),
        });
        if (wantsMachineOutput()) printResult({ delta }, '');
        else process.stdout.write(delta);
      })
    );
  command
    .command('materialize')
    .description('Apply a frozen source snapshot to an explicitly named isolated engine')
    .requiredOption('--snapshot <file>', 'Captured immutable snapshot handle')
    .requiredOption(
      '--engine <path>',
      'Isolated engine destination already seeded with pristine files'
    )
    .option('--ledger <path>', 'Materialization ledger, defaults beside the engine directory')
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .action(
      withErrorHandling(async (options: SnapshotOptions & { engine: string; ledger?: string }) => {
        const snapshot = await readSnapshot(options.snapshot, options.pristineRepository);
        const result = await materializeAuthoredSnapshot({
          snapshot,
          engineDir: resolve(options.engine),
          ledgerPath: options.ledger
            ? resolve(options.ledger)
            : `${resolve(options.engine)}.authored-materialization.json`,
          ...(options.pristineRepository
            ? { pristineRepository: resolve(options.pristineRepository) }
            : {}),
        });
        printData({ ...result });
      })
    );
  registerAuthoredMutations(command, context);
  registerAuthoredRefresh(command, context);
  registerAuthoredMerge(command, context);
  registerAuthoredPristine(command, context);
  registerAuthoredFeedback(command, context);
  command
    .command('validate')
    .description('Authenticate a persisted snapshot against its captured Git objects')
    .requiredOption('--snapshot <file>', 'Captured immutable snapshot handle')
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .action(
      withErrorHandling(async (options: SnapshotOptions) => {
        const snapshot = await authenticateAuthoredSnapshot(
          await readSnapshot(options.snapshot, options.pristineRepository),
          options.pristineRepository
        );
        printResult({ snapshot: snapshot.id }, snapshot.id);
      })
    );
}

/** Refresh is always an external proposal, with no adoption side effect. */
function registerAuthoredRefresh(command: Command, context: CommandContext): void {
  command
    .command('refresh')
    .description('Prepare a disposable three-way source refresh proposal; never adopt a pin')
    .requiredOption('--snapshot <file>', 'Captured immutable old snapshot handle')
    .requiredOption(
      '--new-pin <file>',
      'JSON object containing the exact new firefox configuration and full commit'
    )
    .requiredOption('--new-pristine-repository <path>', 'Read-only new pristine object donor')
    .requiredOption('--out <directory>', 'External empty proposal destination')
    .option('--pristine-repository <path>', 'Read-only old pristine object donor')
    .action(
      context.withErrorHandling(
        async (
          options: SnapshotOptions & {
            newPin: string;
            newPristineRepository: string;
            out: string;
          }
        ) => {
          const pin: unknown = JSON.parse(await readFile(resolve(options.newPin), 'utf8'));
          if (!isObject(pin) || !isObject(pin['firefox']) || typeof pin['commit'] !== 'string')
            throw new GeneralError('authored-refresh-invalid-new-pin');
          const snapshot = await readSnapshot(options.snapshot, options.pristineRepository);
          const config = validateConfig({ ...snapshot.config, firefox: pin['firefox'] });
          const proposal = await refreshAuthoredSnapshot({
            snapshot,
            destination: resolve(options.out),
            newPin: { firefox: config.firefox, commit: pin['commit'] },
            newPristineRepository: resolve(options.newPristineRepository),
            ...(options.pristineRepository
              ? { oldPristineRepository: resolve(options.pristineRepository) }
              : {}),
          });
          printData({ ...proposal });
        }
      )
    );
}

/** First-touch merges: the driver Git calls, and the configuration that names it. */
function registerAuthoredMerge(command: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  command
    .command('merge-install')
    .description('Name the first-touch merge driver in this repository, for every linked worktree')
    .action(
      withErrorHandling(async () => {
        const path = await installAuthoredMergeDriver(getProjectRoot());
        printResult({ path }, path);
      })
    );
  command
    .command('merge-driver <base> <ours> <theirs> <path>')
    .description('Merge one source file for Git, using the pristine blob when first touches meet')
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .action(
      withErrorHandling(
        async (
          base: string,
          ours: string,
          theirs: string,
          path: string,
          options: { pristineRepository?: string }
        ) => {
          const clean = await runAuthoredMergeDriver({
            projectRoot: getProjectRoot(),
            base,
            ours,
            theirs,
            path,
            onNotice: printNotice,
            ...(options.pristineRepository
              ? { pristineRepository: resolve(options.pristineRepository) }
              : {}),
          });
          if (!clean) throw new CommandError(ExitCode.GENERAL_ERROR);
        }
      )
    );
}

function registerAuthoredPristine(command: Command, context: CommandContext): void {
  const pristine = command
    .command('pristine')
    .description('Provision pristine object donors outside the checkout');
  pristine
    .command('fetch')
    .description('Create a standalone donor from a repository holding the pin, or its archive')
    .requiredOption('--out <directory>', 'Absent or empty destination outside this project')
    .option('--from <repository>', 'Path or URL of a repository holding the pinned commit')
    .option('--pin <file>', 'JSON naming another firefox configuration and optional commit')
    .action(
      context.withErrorHandling(async (options: { out: string; from?: string; pin?: string }) => {
        const donor = await fetchPristineDonor({
          projectRoot: context.getProjectRoot(),
          destination: resolve(options.out),
          ...(options.from ? { from: options.from } : {}),
          ...(options.pin
            ? { pin: await readPristinePin(context.getProjectRoot(), options.pin) }
            : {}),
        });
        printData({ ...donor });
      })
    );
}

async function readPristinePin(
  projectRoot: string,
  file: string
): Promise<{ firefox: FirefoxConfig; commit?: string }> {
  const pin: unknown = JSON.parse(await readFile(resolve(file), 'utf8'));
  if (!isObject(pin) || !isObject(pin['firefox']))
    throw new GeneralError('authored-pristine-invalid-pin: expected {"firefox": {...}, "commit"?}');
  if (pin['commit'] !== undefined && typeof pin['commit'] !== 'string')
    throw new GeneralError('authored-pristine-invalid-pin: commit must be a string');
  const { firefox } = validateConfig({
    ...(await loadConfig(projectRoot)),
    firefox: pin['firefox'],
  });
  return { firefox, ...(pin['commit'] !== undefined ? { commit: pin['commit'] } : {}) };
}

function registerAuthoredMutations(command: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  command
    .command('override <path>')
    .description('Declare a first upstream override or explicit upstream deletion')
    .option(
      '--component <id>',
      'Stable component or existing exception identity; defaults to the path’s top directory'
    )
    .option('--classification <kind>', 'registration or exception', 'registration')
    .option('--adr <path>', 'Project-relative approved ADR, required for exceptions')
    .option('--delete', 'Explicit tombstone, distinct from removing an override')
    .option(
      '--discard',
      'With --delete: remove an uncommitted postimage under an existing tombstone'
    )
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .action(
      withErrorHandling(
        async (
          path: string,
          options: {
            component?: string;
            classification: string;
            adr?: string;
            delete?: boolean;
            discard?: boolean;
            pristineRepository?: string;
          }
        ) => {
          if (options.classification !== 'registration' && options.classification !== 'exception')
            throw new GeneralError('authored-invalid-classification');
          const result = await declareAuthoredOverride(getProjectRoot(), path, {
            component: options.component ?? path.split('/')[0] ?? path,
            classification: options.classification,
            ...(options.adr ? { adr: options.adr } : {}),
            ...(options.delete ? { delete: true } : {}),
            ...(options.discard ? { discard: true } : {}),
            ...(options.pristineRepository
              ? { pristineRepository: resolve(options.pristineRepository) }
              : {}),
          });
          // Two branches can now first-touch this file; Git merges them through the driver.
          if (!(await authoredMergeDriverInstalled(getProjectRoot())))
            await installAuthoredMergeDriver(getProjectRoot());
          printData({ ...result });
        }
      )
    );
  command
    .command('restore-upstream <path>')
    .description('Remove an override or tombstone; next materialization restores upstream')
    .option('--discard', 'Remove the postimage even with uncommitted edits')
    .action(
      withErrorHandling(async (path: string, options: { discard?: boolean }) => {
        await removeAuthoredOverride(
          getProjectRoot(),
          path,
          options.discard ? { discard: true } : {}
        );
        printResult({ restored: path }, `Restored upstream: ${path}`);
      })
    );
  registerQueueBridges(command, context);
}

/** The two routes between a patch queue and source mode, one each way. */
function registerQueueBridges(command: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  command
    .command('export-queue')
    .description(
      'Write a snapshot as an ordered patch queue that "fireforge import" replays exactly'
    )
    .requiredOption('--snapshot <file>', 'Captured immutable snapshot handle')
    .requiredOption(
      '--out <directory>',
      'Absent or empty destination for patches.json and the patches'
    )
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .action(
      withErrorHandling(async (options: SnapshotOptions & { out: string }) => {
        const donor = await resolveStaticDonor(
          getProjectRoot(),
          options.pristineRepository && resolve(options.pristineRepository)
        );
        const result = await exportAuthoredQueue({
          snapshot: await readSnapshot(options.snapshot, donor),
          destination: resolve(options.out),
          pristineRepository: donor,
        });
        printData({ ...result });
      })
    );
  command
    .command('migrate')
    .description('Reconstruct a legacy queue into a separate reviewable authored-source overlay')
    .requiredOption(
      '--out <directory>',
      'Absent or empty destination outside this project; no adoption is performed'
    )
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .option(
      '--pristine-commit <oid>',
      "Exact upstream commit; defaults to an archive donor's commit, then the project's recorded base, then donor HEAD"
    )
    .option('--verify', 'Prove the overlay reconstructs the queue before publishing it')
    .action(
      withErrorHandling(
        async (options: {
          out: string;
          pristineRepository?: string;
          pristineCommit?: string;
          verify?: boolean;
        }) => {
          const result = await migrateLegacyQueue({
            projectRoot: getProjectRoot(),
            destination: resolve(options.out),
            ...(options.pristineRepository
              ? { pristineRepository: resolve(options.pristineRepository) }
              : {}),
            ...(options.pristineCommit ? { pristineCommit: options.pristineCommit } : {}),
            ...(options.verify ? { verify: true } : {}),
          });
          if (!result.pinReproducible) {
            printNotice(
              `The pin ${result.sources.pristineCommit} is not one the Firefox archive reproduces, so another host needs a repository holding it. Every sidecar carries the pin, so choose before adopting: create a donor with "fireforge authored pristine fetch --out <directory>" and migrate with --pristine-repository <directory>.`
            );
          }
          printData({ ...result });
        }
      )
    );
}
