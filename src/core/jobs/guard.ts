// SPDX-License-Identifier: EUPL-1.2
import { realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { rpc } from './client.js';
import { projectIdentity } from './guard-project.js';
import type { Endpoint } from './protocol.js';
import { ADAPTER_COMMANDS, type CoordinatorConfig } from './schema.js';
import { readJson, slotDirectory } from './store.js';

/** A host namespace is explicit and shared by all participating FireForge clients. */
export function coordinatorNamespace(): string {
  return resolve(
    process.env['FIREFORGE_COORDINATOR'] ?? join(userInfo().homedir, '.fireforge', 'host', 'jobs')
  );
}

/** Direct commands a configured project routes through jobs: they build, run a browser or change a slot. */
const HOST_RESOURCE_COMMANDS: ReadonlySet<string> = new Set([
  'build',
  'test',
  'run',
  'package',
  'furnace',
]);

/**
 * Keeps direct execution off resources the coordinator owns. Inside a job the
 * phase capability always authenticates. Outside one, only commands that need a
 * build, a browser or a slot refuse, and only for a project this namespace
 * configured or a slot inside it: static checks and other projects are not its
 * business.
 */
export async function assertJobAdmission(command: string, projectRoot: string): Promise<void> {
  if (!ADAPTER_COMMANDS.some((name) => name === command)) return;
  if (process.env['FIREFORGE_JOB_TOKEN'] !== undefined) {
    await assertExecutorCommand(command, projectRoot);
    return;
  }
  if (!HOST_RESOURCE_COMMANDS.has(command)) return;
  const namespace = coordinatorNamespace();
  let config: Partial<CoordinatorConfig>;
  try {
    config = await readJson<Partial<CoordinatorConfig>>(join(namespace, 'config.json'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return;
    throw error;
  }
  const inSlot = (await realpath(projectRoot).catch(() => projectRoot)).startsWith(
    `${await realpath(namespace)}/slots/`
  );
  if (!inSlot && !(config.projects ?? []).includes(await projectIdentity(projectRoot))) return;
  throw new Error(
    `This project runs ${command} through coordinated jobs. Run it with: fireforge job run --build ui --test <path>`
  );
}

/** Asks the supervisor to confirm this process's exact live phase and returns what it says. */
async function authorizeCommand(command: string): Promise<Record<string, unknown>> {
  const token = process.env['FIREFORGE_JOB_TOKEN'];
  const jobId = process.env['FIREFORGE_JOB_ID'];
  if (token === undefined || jobId === undefined)
    throw new Error(
      'This host uses coordinated resources. Submit a frozen job; direct legacy execution is refused. An engine lock does not establish host admission.'
    );
  const endpoint = await readJson<Endpoint>(join(coordinatorNamespace(), 'endpoint.json'));
  return (await rpc(endpoint, {
    operation: 'authorize',
    jobId,
    token,
    command,
    phase: process.env['FIREFORGE_JOB_PHASE'] ?? '',
  })) as Record<string, unknown>;
}

async function assertAuthorizedRoot(authorized: unknown, projectRoot: string): Promise<void> {
  const root = (authorized as { root?: string }).root;
  if (root === undefined || (await realpath(root)) !== (await realpath(projectRoot)))
    throw new Error('Job capability does not authorize this runtime root');
}

/** Always require a live exact phase capability; suitable for slot mutation guards. */
export async function assertExecutorCommand(command: string, projectRoot: string): Promise<void> {
  await assertAuthorizedRoot(await authorizeCommand(command), projectRoot);
}

/** Read only the already admitted frozen source; never recapture a materialized slot as an editor checkout. */
export async function readAdmittedSnapshot(projectRoot: string): Promise<{
  snapshot: import('../authored/types.js').AuthoredSnapshot;
  pristineRepository: string;
  slot: import('./slot-types.js').SlotRecord;
  phase: string;
  execution?: { jobId: string; index: number; args: string[]; cpu: number };
  qualityToolsDigest?: string;
  nativeToolsDigest?: string;
  gitExecutable?: string;
  gitExecPath?: string;
}> {
  const authorized = (await authorizeCommand(
    process.env['FIREFORGE_ADAPTER_COMMAND'] ?? 'status'
  )) as {
    slot: string;
    jobId?: string;
    stepIndex?: number;
    stepArgs?: string[];
    cpu?: number;
    qualityToolsDigest?: string;
    nativeToolsDigest?: string;
    gitExecutable?: string;
    gitExecPath?: string;
  };
  await assertAuthorizedRoot(authorized, projectRoot);
  const namespace = coordinatorNamespace();
  const slot = await readJson<import('./slot-types.js').SlotRecord>(
    join(slotDirectory(namespace, authorized.slot), 'slot.json')
  );
  const snapshot = await readJson<import('../authored/types.js').AuthoredSnapshot>(
    join(slotDirectory(namespace, authorized.slot), 'snapshot.json')
  );
  if (snapshot.id !== slot.sourceId) throw new Error('Admitted source identity mismatch');
  const { jobId, stepIndex, stepArgs, cpu } = authorized;
  return {
    snapshot,
    pristineRepository: slot.pristineRepository,
    slot,
    phase: process.env['FIREFORGE_JOB_PHASE'] ?? '',
    ...(jobId !== undefined &&
    stepIndex !== undefined &&
    stepArgs !== undefined &&
    cpu !== undefined
      ? { execution: { jobId, index: stepIndex, args: stepArgs, cpu } }
      : {}),
    ...(authorized.qualityToolsDigest === undefined
      ? {}
      : { qualityToolsDigest: authorized.qualityToolsDigest }),
    ...(authorized.gitExecutable === undefined ? {} : { gitExecutable: authorized.gitExecutable }),
    ...(authorized.gitExecPath === undefined ? {} : { gitExecPath: authorized.gitExecPath }),
    ...(authorized.nativeToolsDigest === undefined
      ? {}
      : { nativeToolsDigest: authorized.nativeToolsDigest }),
  };
}

/** A fast-path claim needs authenticated live ownership and unchanged real build/package metadata. */
export async function trustedSlotBuild(
  projectRoot: string
): Promise<import('./slot-types.js').TrustedBuildIdentity | undefined> {
  if (process.env['FIREFORGE_JOB_TOKEN'] === undefined) return undefined;
  const { slot } = await readAdmittedSnapshot(projectRoot);
  const identity = slot.trustedBuild;
  if (
    !identity ||
    slot.requiresFullBuild ||
    slot.fullBuildAnchor === undefined ||
    identity.sourceId !== slot.sourceId ||
    identity.slotGeneration !== slot.generation ||
    slot.quarantined !== null
  )
    return undefined;
  const { createHash } = await import('node:crypto');
  const { readFile, readdir } = await import('node:fs/promises');
  try {
    const pending = await readdir(join(slot.root, '.fireforge', 'negative-control'));
    if (pending.length > 0) return undefined;
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  const ledger = await readFile(
    join(slotDirectory(coordinatorNamespace(), slot.id), 'materialization.json')
  );
  const baseline = await readFile(join(slot.root, '.fireforge', 'last-build.json'));
  if (
    createHash('sha256').update(ledger).digest('hex') !== identity.materializationDigest ||
    createHash('sha256').update(baseline).digest('hex') !== identity.baselineDigest
  )
    return undefined;
  return identity;
}

/** Report uncertainty while the CLI still has its live phase capability and birth ancestry. */
export async function reportExecutorCleanupUncertainty(reason: string): Promise<void> {
  if (process.env['FIREFORGE_JOB_TOKEN'] === undefined) return;
  const endpoint = await readJson<Endpoint>(join(coordinatorNamespace(), 'endpoint.json'));
  await rpc(endpoint, {
    operation: 'cleanup-uncertain',
    jobId: process.env['FIREFORGE_JOB_ID'] ?? '',
    token: process.env['FIREFORGE_JOB_TOKEN'] ?? '',
    command: process.env['FIREFORGE_ADAPTER_COMMAND'] ?? 'status',
    phase: process.env['FIREFORGE_JOB_PHASE'] ?? '',
    reason: reason.slice(0, 4096),
  });
}
