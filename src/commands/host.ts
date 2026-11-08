// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import { pristineRepositoryFor } from '../core/authored/git.js';
import { captureAuthoredSnapshot } from '../core/authored/index.js';
import type { AuthoredSnapshot } from '../core/authored/types.js';
import { slotViews } from '../core/jobs/admission-context.js';
import { initializeCoordinator } from '../core/jobs/client.js';
import { parseCacheAssignments, resolveCacheSources } from '../core/jobs/dependency-caches.js';
import { projectIdentity } from '../core/jobs/guard-project.js';
import { qualifySlotNativeTools } from '../core/jobs/native-qualify.js';
import { bootstrapChanges } from '../core/jobs/native-tools.js';
import {
  type CoordinatorConfig,
  DEFAULT_MAX_SLOTS,
  type JobView,
  quietLoadLimit,
} from '../core/jobs/schema.js';
import { createSlot } from '../core/jobs/slot-lifecycle.js';
import { pathPresent } from '../core/jobs/slot-template.js';
import { slotDirectory } from '../core/jobs/store.js';
import { deriveToolchain } from '../core/jobs/toolchain.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { getPlatform } from '../utils/platform.js';
import {
  assertSourceMode,
  jobAction,
  jobVerdict,
  namespaceOf,
  parseWhole,
  printResult,
  progress,
} from './job-support.js';

interface HostInitOptions {
  slots?: string;
  fromEngine?: string;
  python?: string;
  pristineRepository?: string;
  cache?: string[];
  cpu?: string;
  memory?: string;
  browsers?: string;
  quietLoad?: string;
  maxSlots?: string;
  releaseSecrets?: string;
  namespace?: string;
}

/** Slots are named a, b, c and so on: nothing depends on the name, and short names read well in a verdict. */
const slotNames = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));

/** What in the project's mozconfigs has to change before native builds can use frozen tools. */
async function requiredMozconfigChanges(projectRoot: string): Promise<string[]> {
  const configs = new Map<string, string>();
  for (const path of ['configs/common.mozconfig', `configs/${getPlatform()}.mozconfig`]) {
    const text = await readFile(join(projectRoot, path), 'utf8').catch(() => undefined);
    if (text !== undefined) configs.set(path, text);
  }
  return bootstrapChanges(configs).map(
    (item) => `${item.path}${item.line === undefined ? '' : `:${item.line}`}: ${item.change}`
  );
}

/** Captures this checkout and creates each named slot that is not there yet. */
async function provisionSlots(
  namespace: string,
  projectRoot: string,
  names: readonly string[],
  options: HostInitOptions
): Promise<AuthoredSnapshot> {
  const engine = options.fromEngine === undefined ? undefined : resolve(options.fromEngine);
  const donor =
    options.pristineRepository !== undefined
      ? resolve(options.pristineRepository)
      : pristineRepositoryFor(
          projectRoot,
          engine !== undefined && (await pathPresent(join(engine, '.git'))) ? engine : undefined
        );
  const snapshot = await captureAuthoredSnapshot({ projectRoot, pristineRepository: donor });
  const caches = await resolveCacheSources(snapshot.config, {
    projectRoot,
    ...(engine === undefined ? {} : { engine }),
    named: parseCacheAssignments(options.cache ?? []),
  });
  for (const id of names) {
    if (await pathPresent(join(slotDirectory(namespace, id), 'slot.json'))) continue;
    await createSlot({ namespace, id, snapshot, pristineRepository: donor, caches });
    progress(`Slot ${id}: created`);
  }
  return snapshot;
}

/**
 * The one command that readies a host: coordinator, frozen toolchain, slots and
 * their qualification. Every step is idempotent, so running it again finishes
 * what stopped and changes nothing that is right. It never edits a project's
 * files; what they must change, it prints.
 */
async function hostInit(ctx: CommandContext, options: HostInitOptions): Promise<void> {
  const namespace = namespaceOf(options);
  const projectRoot = ctx.getProjectRoot();
  // Configuring a namespace routes this project's direct builds through jobs, which a legacy one cannot use.
  await assertSourceMode(projectRoot);
  const count = parseWhole('--slots', options.slots, 0) ?? 1;
  const cpu = parseWhole('--cpu', options.cpu);
  const memory = parseWhole('--memory', options.memory);
  const maxSlots = parseWhole('--max-slots', options.maxSlots);
  const browsers = parseWhole('--browsers', options.browsers);
  const quietLoad = parseWhole('--quiet-load', options.quietLoad);
  const config: CoordinatorConfig = await initializeCoordinator(namespace, {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
    ...(browsers === undefined ? {} : { browsers }),
    ...(quietLoad === undefined ? {} : { quietLoad }),
    ...(options.releaseSecrets === undefined
      ? {}
      : { releaseSecrets: resolve(options.releaseSecrets) }),
    maxSlots: maxSlots ?? Math.max(count, DEFAULT_MAX_SLOTS),
    legacyExcluded: true,
    projectRoot,
  });
  progress(
    `Coordinator ${namespace}: cpu=${config.capacity.cpu} memory=${config.capacity.memory}GiB max-slots=${config.maxSlots} browsers=${config.capacity.browser} quiet-load=${quietLoadLimit(config)}`
  );
  let qualifiable = false;
  const blockers: string[] = [];
  if (options.fromEngine !== undefined) {
    const { manifest, reused } = await deriveToolchain({
      namespace,
      engine: options.fromEngine,
      ...(options.python === undefined ? {} : { python: options.python }),
    });
    progress(`Toolchain ${manifest.digest.slice(0, 12)}: ${reused ? 'reused' : 'frozen'}`);
    const changes = await requiredMozconfigChanges(projectRoot);
    if (changes.length > 0)
      blockers.push(
        ...changes.map((change) => `Native builds need this change, which you make: ${change}`)
      );
    qualifiable = changes.length === 0;
  }
  const names = slotNames(count);
  const snapshot =
    count > 0 ? await provisionSlots(namespace, projectRoot, names, options) : undefined;
  if (qualifiable && snapshot !== undefined) {
    const jobs: JobView[] = await Promise.all(
      names.map((id) => qualifySlotNativeTools(namespace, id, snapshot))
    );
    for (const job of jobs) {
      progress(jobVerdict(job));
      if (job.state !== 'passed') blockers.push(`Slot ${job.slot ?? '?'} did not qualify`);
    }
  }
  if (blockers.length > 0)
    throw new GeneralError(
      [
        ...blockers,
        `Static jobs can run now. After making any change above, run this again: fireforge host init --slots ${count} --from-engine <engine>`,
      ].join('\n')
    );
  const built = await anyBuiltSlot(namespace, names);
  printResult(
    {
      namespace,
      capacity: config.capacity,
      maxSlots: config.maxSlots,
      quietLoad: quietLoadLimit(config),
      slots: names,
      built,
      project: await projectIdentity(projectRoot),
    },
    count === 0
      ? 'Ready. No slot yet: add some with fireforge host init --slots <count> --from-engine <engine>'
      : built
        ? 'Ready. Run: fireforge job run --test <path>'
        : 'Ready. No slot is built yet, and a test needs one: fireforge job run --build full'
  );
}

/** Whether a slot has a binary a UI build can extend. */
async function anyBuiltSlot(namespace: string, names: readonly string[]): Promise<boolean> {
  const views = await slotViews(namespace);
  return names.some((id) => views.get(id)?.anchorDigest !== undefined);
}

/** Host-wide setup, once per machine and project. */
export function registerHost(program: Command, ctx: CommandContext): void {
  const host = program
    .command('host')
    .description('Set this machine up for coordinated jobs')
    .option('--json', 'Write one JSON document, or an error envelope');
  host
    .command('init')
    .description('Create the coordinator, freeze a toolchain, and provision and qualify slots')
    .option('--slots <count>', 'Slots to provision; 0 sets up the coordinator alone; defaults to 1')
    .option('--from-engine <engine>', 'A configured engine whose config.statusd names the tools')
    .option('--python <path>', 'Interpreter to use, instead of the one the engine configured')
    .option(
      '--pristine-repository <repository>',
      'Pristine object donor; defaults from this checkout'
    )
    .option('--cache <target=path...>', 'Where a declared dependency tree is on this host')
    .option('--cpu <units>', 'CPU units jobs may use together; defaults to every available CPU')
    .option('--memory <gib>', 'GiB jobs may use together; defaults to 80% of physical memory')
    .option('--max-slots <count>', 'Most slots the host provisions')
    .option('--browsers <count>', 'Browsers that may run at once; defaults to 1')
    .option(
      '--quiet-load <load>',
      'One-minute load a quiet step waits to fall below; defaults to the CPU units'
    )
    .option('--release-secrets <directory>', 'Where this host keeps declared release secrets')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: HostInitOptions) => {
        await hostInit(ctx, options);
      })
    );
}
