// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import { sourceGit } from '../core/authored/git.js';
import { captureAuthoredSnapshot } from '../core/authored/index.js';
import type { AuthoredSnapshot } from '../core/authored/types.js';
import { loadConfig } from '../core/config.js';
import {
  declaredCaches,
  lockfileOf,
  parseCacheAssignments,
  resolveCacheSources,
} from '../core/jobs/dependency-caches.js';
import { qualifySlotNativeTools } from '../core/jobs/native-qualify.js';
import { assertNativeBootstrapDisabled, toolchainManifestPath } from '../core/jobs/native-tools.js';
import { assertPackageUnchanged } from '../core/jobs/package-signature.js';
import {
  createSlot,
  refreshSlotDependencies,
  removeSlot,
  restoreSlot,
} from '../core/jobs/slot-lifecycle.js';
import { pathPresent, readTemplate } from '../core/jobs/slot-template.js';
import type { SlotCache, SlotRecord } from '../core/jobs/slot-types.js';
import { acquireSlot, auditSlot, prepareSlot, readSlot } from '../core/jobs/slots.js';
import { readJson, slotDirectory } from '../core/jobs/store.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import {
  assertSourceMode,
  exitWithState,
  jobAction,
  jobVerdict,
  namespaceOf,
  printJob,
  printResult,
  pristineDonor,
  progress,
} from './job-support.js';

interface NamespaceOption {
  namespace?: string;
}

/** One line for a person: the slot, what source it holds, and anything that stops it serving. */
function slotLine(record: SlotRecord): string {
  return [
    record.id,
    `source=${record.sourceId.slice(0, 12)}`,
    `generation=${record.generation}`,
    ...(record.quarantined === null ? [] : [`quarantined="${record.quarantined}"`]),
    ...(record.requiresFullBuild === true
      ? ['needs=full-build']
      : record.requiresBuild === true
        ? ['needs=build']
        : []),
  ].join(' ');
}

/** One slot's record, or why it cannot be read. One broken entry never hides the others. */
async function slotEntry(
  namespace: string,
  name: string
): Promise<SlotRecord | { id: string; error: string }> {
  try {
    return await readSlot(namespace, name);
  } catch (error) {
    return { id: name, error: toError(error).message };
  }
}

/** What a new slot starts on: the snapshot named, a built slot's own source, or this checkout now. */
async function snapshotForSlot(
  ctx: CommandContext,
  namespace: string,
  options: { snapshot?: string; pristineRepository?: string; from?: string }
): Promise<AuthoredSnapshot> {
  if (options.snapshot !== undefined) return readJson<AuthoredSnapshot>(resolve(options.snapshot));
  if (options.from !== undefined) {
    await readSlot(namespace, options.from);
    return readJson<AuthoredSnapshot>(
      join(slotDirectory(namespace, options.from), 'snapshot.json')
    );
  }
  const projectRoot = ctx.getProjectRoot();
  return captureAuthoredSnapshot({
    projectRoot,
    pristineRepository:
      options.pristineRepository === undefined
        ? await pristineDonor(namespace, projectRoot)
        : resolve(options.pristineRepository),
  });
}

/** The paths a status line in `git status --porcelain -z` names; a rename's source follows it. */
function porcelainPaths(status: string): string[] {
  const entries = status.split('\0').filter((entry) => entry !== '');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? '';
    paths.push(entry.slice(3));
    if (/^[RC]/.test(entry)) index += 1;
  }
  return paths;
}

/**
 * This checkout as its dependency trees see it. They follow only fireforge.json
 * and the declared lockfiles, so those have to be committed; anything else dirty
 * is taken at its committed bytes rather than refused.
 *
 * @throws When the configuration or a lockfile has uncommitted changes
 */
async function dependencySnapshot(
  projectRoot: string,
  namespace: string
): Promise<AuthoredSnapshot> {
  const config = await loadConfig(projectRoot);
  const owned = config.sources?.root;
  const lockfiles = declaredCaches(config).flatMap((cache) => {
    const path = lockfileOf(cache);
    // An engine lockfile this source owns lives under its source root.
    return path.startsWith('engine/') && owned !== undefined
      ? [path, `${owned}/${path.slice('engine/'.length)}`]
      : [path];
  });
  const paths = [...new Set(['fireforge.json', ...lockfiles])];
  const dirty = porcelainPaths(
    (
      await sourceGit(projectRoot, [
        'status',
        '--porcelain',
        '-z',
        '--untracked-files=all',
        '--',
        ...paths,
      ])
    ).toString('utf8')
  );
  if (dirty.length > 0)
    throw new GeneralError(
      `Dependency trees follow the committed fireforge.json and lockfiles, and these have uncommitted changes: ${dirty.join(', ')}. Commit or restore them first`
    );
  return captureAuthoredSnapshot({
    projectRoot,
    pristineRepository: await pristineDonor(namespace, projectRoot),
    allowDirtyRoot: true,
  });
}

/** The trees a new slot takes: a clone of a built slot already has its own. */
async function cachesFor(
  ctx: CommandContext,
  snapshot: AuthoredSnapshot,
  options: { cache?: string[]; from?: string }
): Promise<SlotCache[]> {
  const named = parseCacheAssignments(options.cache ?? []);
  if (options.from !== undefined && Object.keys(named).length === 0) return [];
  return resolveCacheSources(snapshot.config, {
    projectRoot: ctx.getProjectRoot(),
    named,
  });
}

/**
 * Qualifies a new slot's native sites, as host init does, when this host can:
 * an unqualified slot refuses every native job. When it cannot, it says so on
 * stderr, with why and the command that qualifies it later.
 *
 * @returns Why the slot was left unqualified, or nothing when it qualified
 * @throws When qualification ran and did not pass
 */
async function qualifyNewSlot(
  namespace: string,
  id: string,
  snapshot: AuthoredSnapshot,
  wanted: boolean
): Promise<string | undefined> {
  let skipped: string | undefined;
  if (!wanted) skipped = '--no-qualify skipped it.';
  else if (!(await pathPresent(toolchainManifestPath(namespace))))
    skipped =
      'This host has no frozen toolchain; derive one with: fireforge host init --from-engine <engine>.';
  else
    try {
      await assertNativeBootstrapDisabled(snapshot);
    } catch (error) {
      skipped = toError(error).message;
    }
  const remedy = `fireforge slot qualify-native ${id}`;
  if (skipped !== undefined) {
    process.stderr.write(
      `warning: Slot ${id} is NOT qualified for native jobs: builds and tests refuse on it. ${skipped} Then run: ${remedy}\n`
    );
    return skipped;
  }
  const job = await qualifySlotNativeTools(namespace, id, snapshot);
  progress(jobVerdict(job));
  if (job.state !== 'passed')
    throw new GeneralError(
      `Slot ${id} was created, but its native sites did not qualify: ${job.reason ?? job.state}. Static jobs can run on it; after fixing that, run: ${remedy}`
    );
  return undefined;
}

function registerCreate(slot: Command, ctx: CommandContext): void {
  slot
    .command('create <name>')
    .description('Clone a slot from the pin’s pristine template, or from a built slot')
    .option('--from <slot>', 'Clone this built slot, objects included, keeping its build')
    .option('--snapshot <file>', 'Captured source snapshot JSON; captures this checkout by default')
    .option(
      '--pristine-repository <repository>',
      'Pristine object donor, until the pin has a template'
    )
    .option('--cache <target=path...>', 'Where a declared dependency tree is on this host')
    .option('--no-qualify', 'Leave native sites unqualified, as on a host with no toolchain')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(
        ctx,
        async (
          id: string,
          options: NamespaceOption & {
            from?: string;
            snapshot?: string;
            pristineRepository?: string;
            cache?: string[];
            qualify: boolean;
          }
        ) => {
          const namespace = namespaceOf(options);
          await assertSourceMode(ctx.getProjectRoot());
          const snapshot = await snapshotForSlot(ctx, namespace, options);
          const donor =
            options.pristineRepository !== undefined
              ? resolve(options.pristineRepository)
              : options.from === undefined &&
                  (await readTemplate(namespace, snapshot.pin.commit)) === undefined
                ? await pristineDonor(namespace, ctx.getProjectRoot())
                : undefined;
          const created = await createSlot({
            namespace,
            id,
            snapshot,
            ...(donor === undefined ? {} : { pristineRepository: donor }),
            ...(options.from === undefined ? {} : { from: options.from }),
            caches: await cachesFor(ctx, snapshot, options),
          });
          const unqualified = await qualifyNewSlot(namespace, id, snapshot, options.qualify);
          printResult(
            {
              slot: created,
              qualified: unqualified === undefined,
              ...(unqualified === undefined ? {} : { unqualified }),
            },
            `Slot ${slotLine(created)}${unqualified === undefined ? ' qualified' : ''}`
          );
        }
      )
    );
}

/** Stable execution slots never import a donor's ignored files, profiles, secrets or Git configuration. */
export function registerSlot(program: Command, ctx: CommandContext): void {
  const slot = program
    .command('slot')
    .description('Create and audit private stable execution slots')
    .option('--json', 'Write one JSON document, or an error envelope');
  registerCreate(slot, ctx);
  slot
    .command('qualify-native <name>')
    .description('Provision a slot’s native tool sites as a job, and configure it')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: NamespaceOption) => {
        const job = await qualifySlotNativeTools(namespaceOf(options), id);
        printJob(job);
        exitWithState(job);
      })
    );
  slot
    .command('refresh-deps <name...>')
    .description('Replace slots’ dependency trees with what this checkout’s lockfiles state')
    .option('--cache <target=path...>', 'Where a declared dependency tree is on this host')
    .option('--from-engine <engine>', 'The engine an engine/ tree comes from')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(
        ctx,
        async (
          names: string[],
          options: NamespaceOption & { cache?: string[]; fromEngine?: string }
        ) => {
          const namespace = namespaceOf(options);
          await assertSourceMode(ctx.getProjectRoot());
          const snapshot = await dependencySnapshot(ctx.getProjectRoot(), namespace);
          const caches = await resolveCacheSources(snapshot.config, {
            projectRoot: ctx.getProjectRoot(),
            ...(options.fromEngine === undefined ? {} : { engine: resolve(options.fromEngine) }),
            named: parseCacheAssignments(options.cache ?? []),
          });
          const refreshed: { slot: string; caches: string[] }[] = [];
          for (const id of names)
            refreshed.push({
              slot: id,
              caches: await refreshSlotDependencies({ namespace, id, snapshot, caches }),
            });
          printResult(
            { slots: refreshed },
            refreshed
              .map(
                (entry) => `Slot ${entry.slot}: refreshed ${entry.caches.join(', ') || 'nothing'}`
              )
              .join('\n')
          );
        }
      )
    );
  slot
    .command('remove <name>')
    .description('Remove an idle slot, keeping the pin’s template and every job record')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: NamespaceOption) => {
        const { removed } = await removeSlot(namespaceOf(options), id);
        printResult({ removed }, `Slot ${removed}: removed`);
      })
    );
  slot
    .command('restore <name>')
    .description('Re-materialize a quarantined slot, audit it and clear it, keeping its objdir')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: NamespaceOption) => {
        const restored = await restoreSlot(namespaceOf(options), id);
        printResult({ slot: restored }, `Slot ${slotLine(restored)}: restored`);
      })
    );
  slot
    .command('list')
    .description('List every slot; an unreadable one reports its error')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: NamespaceOption) => {
        const namespace = namespaceOf(options);
        let names: string[];
        try {
          names = await readdir(join(namespace, 'slots'));
        } catch (error) {
          if (getNodeErrorCode(error) !== 'ENOENT') throw error;
          names = [];
        }
        const slots = await Promise.all(names.map((name) => slotEntry(namespace, name)));
        printResult(
          { slots },
          slots.length === 0
            ? 'No slots'
            : slots
                .map((entry) =>
                  'error' in entry ? `${entry.id} error="${entry.error}"` : slotLine(entry)
                )
                .join('\n')
        );
      })
    );
  slot
    .command('prepare <name>')
    .description('Bring an idle slot to a snapshot')
    .requiredOption('--snapshot <file>', 'Captured source snapshot JSON')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: NamespaceOption & { snapshot: string }) => {
        const namespace = namespaceOf(options);
        const release = await acquireSlot(namespace, id);
        try {
          const prepared = await prepareSlot(
            namespace,
            await readSlot(namespace, id),
            await readJson<AuthoredSnapshot>(resolve(options.snapshot))
          );
          printResult({ slot: prepared }, `Slot ${slotLine(prepared)}: prepared`);
        } finally {
          await release();
        }
      })
    );
  slot
    .command('audit <name>')
    .description('Report a slot’s integrity; this never clears a quarantine')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: NamespaceOption) => {
        const namespace = namespaceOf(options);
        const release = await acquireSlot(namespace, id);
        try {
          const record = await readSlot(namespace, id);
          const audited = await auditSlot(namespace, record);
          await assertPackageUnchanged(record);
          printResult({ slot: id, audit: audited }, `Slot ${id}: audit passed`);
        } finally {
          await release();
        }
      })
    );
}
