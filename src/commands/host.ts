// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import { pristineRepositoryFor } from '../core/authored/git.js';
import { captureAuthoredSnapshot } from '../core/authored/index.js';
import type { AuthoredSnapshot } from '../core/authored/types.js';
import { slotViews } from '../core/jobs/admission-context.js';
import { readCoordinatorConfig } from '../core/jobs/admission-context.js';
import { initializeCoordinator } from '../core/jobs/client.js';
import { parseCacheAssignments, resolveCacheSources } from '../core/jobs/dependency-caches.js';
import { projectIdentity } from '../core/jobs/guard-project.js';
import { diskLowThreshold, diskUsage, gibText, readVolumeSpace } from '../core/jobs/host-disk.js';
import { qualifySlotNativeTools } from '../core/jobs/native-qualify.js';
import { bootstrapChanges } from '../core/jobs/native-tools.js';
import { artifactBounds, pruneArtifacts } from '../core/jobs/retention.js';
import {
  type CoordinatorConfig,
  DEFAULT_MAX_SLOTS,
  type JobView,
  quietLoadLimit,
} from '../core/jobs/schema.js';
import { createSlot } from '../core/jobs/slot-lifecycle.js';
import { pathPresent } from '../core/jobs/slot-template.js';
import { readJournal, slotDirectory } from '../core/jobs/store.js';
import { deriveToolchain } from '../core/jobs/toolchain.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { getPlatform } from '../utils/platform.js';
import { registerHostUpgrade, runtimeStatus } from './host-runtime.js';
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
  allowDirtyRoot?: boolean;
  cpu?: string;
  memory?: string;
  browsers?: string;
  quietLoad?: string;
  replicateDepth?: string;
  diskLowGib?: string;
  artifactMaxGib?: string;
  artifactMaxAgeDays?: string;
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
  const snapshot = await captureAuthoredSnapshot({
    projectRoot,
    pristineRepository: donor,
    ...(options.allowDirtyRoot === true ? { allowDirtyRoot: true } : {}),
    onNotice: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
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
  const replicateDepth = parseWhole('--replicate-depth', options.replicateDepth, 0);
  const diskLowGib = parseWhole('--disk-low-gib', options.diskLowGib);
  const artifactMaxGib = parseWhole('--artifact-max-gib', options.artifactMaxGib);
  const artifactMaxAgeDays = parseWhole('--artifact-max-age-days', options.artifactMaxAgeDays);
  const config: CoordinatorConfig = await initializeCoordinator(namespace, {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
    ...(browsers === undefined ? {} : { browsers }),
    ...(quietLoad === undefined ? {} : { quietLoad }),
    ...(replicateDepth === undefined ? {} : { replicateDepth }),
    ...(diskLowGib === undefined ? {} : { diskLowGib }),
    ...(artifactMaxGib === undefined ? {} : { artifactMaxGib }),
    ...(artifactMaxAgeDays === undefined ? {} : { artifactMaxAgeDays }),
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

/** Free disk on the namespace's volume against the low threshold, what the coordinator holds, and a warning when low. */
async function hostStatus(namespace: string): Promise<void> {
  const config = await readCoordinatorConfig(namespace);
  const space = await readVolumeSpace(namespace);
  const threshold = diskLowThreshold(space.totalBytes, config.diskLowGib);
  const usage = await diskUsage(namespace);
  const low = space.freeBytes < threshold;
  const runtime = await runtimeStatus(namespace);
  const lines = [
    ...runtime.lines,
    `Disk: ${gibText(space.freeBytes)} GiB free of ${gibText(space.totalBytes)} GiB (low below ${gibText(threshold)} GiB)`,
    `Slots: ${String(usage.slots)}, ${gibText(usage.slotBytes)} GiB measured`,
    `Job artifacts: ${gibText(usage.artifactBytes)} GiB (fireforge host prune bounds them)`,
    ...(low
      ? [
          `Warning: free disk is below ${gibText(threshold)} GiB; steps that run now may fail from disk pressure. Free space with: fireforge host prune`,
        ]
      : []),
  ];
  printResult(
    {
      namespace,
      disk: {
        freeBytes: space.freeBytes,
        totalBytes: space.totalBytes,
        lowBelowBytes: threshold,
        low,
      },
      slots: usage.slots,
      slotBytes: usage.slotBytes,
      artifactBytes: usage.artifactBytes,
      ...runtime.data,
    },
    lines.join('\n')
  );
}

/** Bounds job artifacts now, by the configured bounds or the ones this run states. */
async function hostPrune(
  namespace: string,
  options: { maxGib?: string; maxAgeDays?: string; dryRun?: boolean }
): Promise<void> {
  const config = await readCoordinatorConfig(namespace);
  const maxGib = parseWhole('--max-gib', options.maxGib, 0);
  const maxAgeDays = parseWhole('--max-age-days', options.maxAgeDays, 0);
  const bounds = artifactBounds({
    ...(maxGib === undefined
      ? config.artifactMaxGib === undefined
        ? {}
        : { artifactMaxGib: config.artifactMaxGib }
      : { artifactMaxGib: maxGib }),
    ...(maxAgeDays === undefined
      ? config.artifactMaxAgeDays === undefined
        ? {}
        : { artifactMaxAgeDays: config.artifactMaxAgeDays }
      : { artifactMaxAgeDays: maxAgeDays }),
  });
  const dryRun = options.dryRun === true;
  const result = await pruneArtifacts(namespace, await readJournal(namespace), bounds, { dryRun });
  const verb = dryRun ? 'Would free' : 'Freed';
  printResult(
    {
      namespace,
      dryRun,
      removed: result.removed,
      freedBytes: result.freedBytes,
      remainingBytes: result.remainingBytes,
    },
    [
      ...result.removed.map(
        (entry) =>
          `${dryRun ? 'would remove' : 'removed'} ${entry.id} (${entry.reason}) ${gibText(entry.bytes)} GiB`
      ),
      `${verb} ${gibText(result.freedBytes)} GiB from ${String(result.removed.length)} job${result.removed.length === 1 ? '' : 's'}; artifacts now ${gibText(result.remainingBytes)} GiB`,
    ].join('\n')
  );
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
    .option('--allow-dirty-root', 'Capture with changed files outside the selection left out')
    .option('--cpu <units>', 'CPU units jobs may use together; defaults to every available CPU')
    .option('--memory <gib>', 'GiB jobs may use together; defaults to 80% of physical memory')
    .option('--max-slots <count>', 'Most slots the host provisions')
    .option('--browsers <count>', 'Browsers that may run at once; defaults to 1')
    .option(
      '--quiet-load <load>',
      'One-minute load a quiet step waits to fall below; defaults to the CPU units'
    )
    .option(
      '--disk-low-gib <gib>',
      'Free GiB below which a red step is annotated as possible disk pressure; at least 3% of the volume applies too'
    )
    .option(
      '--artifact-max-gib <gib>',
      'Most GiB job artifacts may occupy before the oldest of finished jobs go; defaults to 10'
    )
    .option(
      '--artifact-max-age-days <days>',
      "Days after which a finished job's artifacts go; defaults to 14"
    )
    .option(
      '--replicate-depth <jobs>',
      'Waiting jobs per slot holding their build at which it is copied into an idle slot; 0 turns it off; defaults to 2'
    )
    .option('--release-secrets <directory>', 'Where this host keeps declared release secrets')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: HostInitOptions) => {
        await hostInit(ctx, options);
      })
    );
  registerHostUpgrade(host, ctx);
  host
    .command('status')
    .description(
      'Show the pinned FireForge build, free disk and what the coordinator holds, and warn when disk is low'
    )
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: { namespace?: string }) => {
        await hostStatus(namespaceOf(options));
      })
    );
  host
    .command('prune')
    .description(
      "Remove finished jobs' artifacts past the age or size bound, and print what was freed"
    )
    .option('--max-gib <gib>', 'Size bound for this run, instead of the configured one')
    .option('--max-age-days <days>', 'Age bound for this run, instead of the configured one')
    .option('--dry-run', 'Say what would be removed and remove nothing')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(
        ctx,
        async (options: {
          namespace?: string;
          maxGib?: string;
          maxAgeDays?: string;
          dryRun?: boolean;
        }) => {
          await hostPrune(namespaceOf(options), options);
        }
      )
    );
}
