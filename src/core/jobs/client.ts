// SPDX-License-Identifier: EUPL-1.2
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFile, open, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AmbiguousJobError, ExecutorMismatchError, UnknownJobError } from '../../errors/job.js';
import { getCliVersion } from '../../utils/build-info.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { notice } from '../../utils/logger.js';
import { getPackageRoot } from '../../utils/package-root.js';
import { sleep } from '../../utils/sleep.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { carriedSettings } from './coordinator-settings.js';
import { electionDirectory } from './election.js';
import { allowedEnvironment } from './environment.js';
import { executorFingerprint } from './executor-fingerprint.js';
import { projectIdentity } from './guard-project.js';
import { clearHostQuarantine } from './host-quarantine.js';
import { type LogChunk, type LogSelection, readLogRange, visibleJob } from './job-view.js';
import { cancelAttribution, ownerLabel } from './owner.js';
import {
  type PinnedBuild,
  type PinnedEntry,
  pinnedEntry,
  PinnedRuntimeError,
  readPinnedRuntime,
} from './pinned-runtime.js';
import { isSameProcess } from './process.js';
import { COORDINATOR_PROTOCOL, type Endpoint, type RpcReply, type RpcRequest } from './protocol.js';
import {
  type CoordinatorConfig,
  DEFAULT_MAX_SLOTS,
  hostCapacity,
  type JobRecord,
  type JobRequest,
  type JobView,
  type ResourceVector,
  terminal,
} from './schema.js';
import { claimHolder } from './slot-lock.js';
import { assertSourceLoaderEnvironment, sourceLoaderCacheEnvironment } from './source-loader.js';
import { ensurePrivateNamespace, readJournal, readJson, writeDurable } from './store.js';

export { ownerLabel };

/** How long a request may wait for an answer, by what it asks for. */
const RPC_TIMEOUT_MS = 10_000;
/** A submit validates and retains the source before its durable acknowledgement. */
const SUBMIT_TIMEOUT_MS = 300_000;
const SUBMIT_ATTEMPTS = 4;
/** How long a supervisor still running may take to answer before it counts as stuck. */
const STARTUP_BUDGET_MS = 30_000;
const STARTUP_POLL_MS = 50;
/** Polls between starts, when one ended by losing the election to a supervisor closing down. */
const POLLS_PER_START = 20;

/** The supervisor answered and the answer is a refusal: retrying the same request cannot help. */
export class CoordinatorRefusal extends Error {
  override readonly name = 'CoordinatorRefusal';

  constructor(
    message: string,
    /** The refusal's class on the other side. */
    readonly refusedAs?: string
  ) {
    super(message);
  }
}

/** No supervisor can run here until someone acts, so trying again only delays saying why. */
class CoordinatorUnusable extends Error {
  override readonly name = 'CoordinatorUnusable';
}

/** Host settings `host init` may state; everything else comes from the host itself. */
export interface CoordinatorOptions {
  cpu?: number;
  memory?: number;
  /** Browsers that may run at once. A display stays one, whatever this says. */
  browsers?: number;
  /** The one-minute load a quiet phase waits to fall below. */
  quietLoad?: number;
  /** Waiting jobs per holding slot at which a build is replicated into an idle slot; 0 turns it off. */
  replicateDepth?: number;
  /** Free GiB below which a red step is annotated as possible disk pressure. */
  diskLowGib?: number;
  /** Most GiB job artifacts may occupy. */
  artifactMaxGib?: number;
  /** Days after which a finished job's artifacts go. */
  artifactMaxAgeDays?: number;
  maxSlots?: number;
  idleMs?: number;
  legacyExcluded?: boolean;
  /** A checkout whose direct builds and browsers this namespace now owns. */
  projectRoot?: string;
  /** Where this host keeps the files a release build declares as secrets. */
  releaseSecrets?: string;
  /** Pins the host conditions steps read, for a test fixture. No command states it. */
  steadyHost?: true;
}

/** The configuration as stored; a namespace from another version may lack fields. */
async function readConfig(namespace: string): Promise<Partial<CoordinatorConfig> | undefined> {
  try {
    return await readJson<Partial<CoordinatorConfig>>(join(namespace, 'config.json'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Creates or updates a namespace. Nothing is required: capacity comes from the
 * host. Running it again applies only what it states and keeps the rest, so no
 * choice made at first initialization is permanent.
 */
export async function initializeCoordinator(
  namespace: string,
  options: CoordinatorOptions = {}
): Promise<CoordinatorConfig> {
  if (process.platform === 'win32')
    throw new Error('The local supervisor currently requires POSIX process groups');
  await ensurePrivateNamespace(namespace);
  const existing = await readConfig(namespace);
  const host = existing?.capacity ?? hostCapacity();
  const capacity: ResourceVector = {
    ...host,
    ...(options.cpu === undefined ? {} : { cpu: options.cpu }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.browsers === undefined ? {} : { browser: options.browsers }),
  };
  const project =
    options.projectRoot === undefined ? undefined : await projectIdentity(options.projectRoot);
  const config: CoordinatorConfig = {
    schemaVersion: 1,
    capacity,
    maxSlots: options.maxSlots ?? existing?.maxSlots ?? DEFAULT_MAX_SLOTS,
    idleMs: options.idleMs ?? existing?.idleMs ?? 30_000,
    legacyExcluded: options.legacyExcluded ?? existing?.legacyExcluded ?? false,
    projects: [
      ...new Set([...(existing?.projects ?? []), ...(project === undefined ? [] : [project])]),
    ],
    runtime: { node: process.execPath, environment: allowedEnvironment(process.env) },
    ...carriedSettings(options, existing),
  };
  await writeDurable(join(namespace, 'config.json'), config);
  return config;
}

/** A bounded private IPC exchange; client disconnect never cancels an acknowledged job. */
export async function rpc(
  endpoint: Endpoint,
  request: RpcRequest,
  timeoutMs = RPC_TIMEOUT_MS
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint.socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Coordinator IPC timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(`${JSON.stringify({ request })}\n`));
    socket.on('data', (data: string) => {
      buffer += data;
      if (buffer.length > 16 * 1024 * 1024)
        socket.destroy(new Error('Coordinator reply too large'));
    });
    socket.on('end', () => {
      try {
        const reply = JSON.parse(buffer) as RpcReply;
        if (!reply.ok) reject(new CoordinatorRefusal(reply.error ?? '', reply.errorName));
        else resolve(reply.value);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Whether a socket accepts connections. The kernel answers even when its server is busy. */
function acceptsConnections(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socket);
    probe.setTimeout(RPC_TIMEOUT_MS, () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });
}

/** The endpoint of a running supervisor, or undefined. Starts nothing. */
export async function liveEndpoint(namespace: string): Promise<Endpoint | undefined> {
  let endpoint: Endpoint;
  try {
    endpoint = await readJson<Endpoint>(join(namespace, 'endpoint.json'));
  } catch {
    return undefined;
  }
  return (await acceptsConnections(endpoint.socket)) ? endpoint : undefined;
}

/** A supervisor this client started, as far as this client can see it. */
interface SupervisorStart {
  child: ChildProcess;
  entry: string;
  /** How it ended: its exit code, or null for a signal. Unset while it runs. */
  exit?: number | null;
}

/**
 * The supervisor entry a start runs: the host's pinned build, verified, whatever
 * client starts it; on a host that pins none, this client's own package.
 *
 * @throws {CoordinatorUnusable} When the pinned build does not verify
 */
async function supervisorEntry(namespace: string): Promise<{ entry: string; fromSource: boolean }> {
  let pinned: PinnedEntry | undefined;
  try {
    pinned = await pinnedEntry(namespace);
  } catch (error) {
    if (error instanceof PinnedRuntimeError) throw new CoordinatorUnusable(error.message);
    throw error;
  }
  if (pinned !== undefined) return { entry: pinned.supervisor, fromSource: false };
  const fromSource = import.meta.url.endsWith('.ts');
  return {
    entry: fileURLToPath(
      new URL(fromSource ? './supervisor-main.ts' : './supervisor-main.js', import.meta.url)
    ),
    fromSource,
  };
}

/**
 * Launches the supervisor from the namespace's recorded Node and pinned build,
 * not from this caller's, as a detached child of this client. It inherits this
 * client's login session and privacy grants, and nothing else: the environment is
 * the recorded one, and the working directory is the namespace, never the caller's
 * checkout, which can be a removable worktree or a folder macOS privacy controls watch.
 */
async function spawnSupervisor(
  given: string,
  runtime: CoordinatorConfig['runtime']
): Promise<SupervisorStart> {
  const namespace = resolve(given);
  const { entry, fromSource } = await supervisorEntry(namespace);
  const log = await open(join(namespace, 'supervisor.log'), 'a', 0o600);
  try {
    const child = spawn(
      runtime.node,
      [
        ...(fromSource
          ? ['--import', fileURLToPath(new URL('./source-loader-bootstrap.cjs', import.meta.url))]
          : []),
        entry,
        namespace,
      ],
      {
        cwd: namespace,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: {
          ...runtime.environment,
          ...sourceLoaderCacheEnvironment(fromSource),
          NODE_DISABLE_COMPILE_CACHE: '1',
          JITI_FS_CACHE: 'false',
        },
      }
    );
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    const start: SupervisorStart = { child, entry };
    child.once('exit', (code) => {
      start.exit = code;
    });
    child.unref();
    return start;
  } catch (error: unknown) {
    throw new Error(
      `Coordinator supervisor could not be spawned from ${runtime.node}; rerun fireforge host init if Node moved, and inspect supervisor.log`,
      { cause: error }
    );
  } finally {
    await log.close();
  }
}

/** What the supervisor last wrote to its log, which says why it could not start. */
async function lastLogLine(namespace: string): Promise<string> {
  const path = join(namespace, 'supervisor.log');
  const text = await readFile(path, 'utf8').catch(() => '');
  const line = text.trim().split('\n').at(-1);
  return line === undefined || line === '' ? `inspect ${path}` : `${line} (log: ${path})`;
}

/**
 * Why no supervisor answered in time, written to its log as well. One stuck before
 * the election owns nothing, so it ends here; one holding the election may be
 * recovering jobs, so it stays.
 */
async function startupDiagnosis(
  namespace: string,
  start: SupervisorStart,
  waitedMs: number
): Promise<string> {
  const holder = await claimHolder(electionDirectory(namespace)).catch(() => undefined);
  const holding = holder !== undefined && (await isSameProcess(holder.owner));
  if (!holding && start.exit !== undefined) return lastLogLine(namespace);
  if (!holding) start.child.kill('SIGKILL');
  const seconds = String(Math.round(waitedMs / 1000));
  const privacy =
    process.platform === 'darwin'
      ? `. macOS privacy controls hold a process back from ~/Documents, ~/Desktop and ~/Downloads, which looks like this: ${start.entry} has to be readable by this client, so run from a terminal with access to that folder (System Settings, Privacy & Security, Files and Folders)`
      : '';
  const reason = holding
    ? `process ${String(holder.owner.pid)} holds the supervisor election and has not opened its socket after ${seconds} s${privacy}`
    : `supervisor process ${String(start.child.pid)} did not reach the election in ${seconds} s and was stopped${privacy}`;
  const log = join(namespace, 'supervisor.log');
  await appendFile(log, `${new Date().toISOString()} ${reason}\n`).catch(() => undefined);
  return `${reason} (log: ${log})`;
}

/**
 * Start on demand, preserving Node's source loader when running from TypeScript.
 *
 * @param namespace - The namespace to start it in
 * @param budgetMs - How long a start may take before it is diagnosed instead of awaited
 * @throws {CoordinatorUnusable} When none can run here, or none answered in time, saying why
 */
export async function ensureSupervisor(
  namespace: string,
  budgetMs = STARTUP_BUDGET_MS
): Promise<Endpoint> {
  if (import.meta.url.endsWith('.ts')) assertSourceLoaderEnvironment(getPackageRoot());
  await ensurePrivateNamespace(namespace);
  const running = await liveEndpoint(namespace);
  if (running !== undefined) return running;
  const config = await readConfig(namespace);
  if (config?.runtime === undefined)
    throw new CoordinatorUnusable(
      `No coordinator at ${namespace}; set this host up with: fireforge host init --slots <n> --from-engine <engine>`
    );
  const started = Date.now();
  let start = await spawnSupervisor(namespace, config.runtime);
  for (let poll = 1; Date.now() - started < budgetMs; poll += 1) {
    await sleep(STARTUP_POLL_MS);
    const endpoint = await liveEndpoint(namespace);
    if (endpoint !== undefined) return endpoint;
    if (start.exit !== undefined && start.exit !== 0)
      throw new CoordinatorUnusable(`Coordinator could not start: ${await lastLogLine(namespace)}`);
    if (start.exit === 0 && poll % POLLS_PER_START === 0)
      start = await spawnSupervisor(namespace, config.runtime);
  }
  throw new CoordinatorUnusable(
    `Coordinator did not start: ${await startupDiagnosis(namespace, start, Date.now() - started)}`
  );
}

/**
 * On a host that pins no build, refuses a supervisor that runs other FireForge
 * bytes than this client. It would seal every result under its own executor, which this client then reads
 * as stale, so the work would run for nothing. Only submission comes here:
 * reads, waits and cancellation produce no evidence and work across builds.
 *
 * @throws {ExecutorMismatchError} When the supervisor's executor is not this client's, or unrecorded
 */
async function assertSameExecutor(
  namespace: string,
  endpoint: Endpoint,
  own: string
): Promise<void> {
  if (endpoint.executorDigest === own) return;
  const pid = String(endpoint.owner.pid);
  const client = `this client is FireForge ${getCliVersion()} from ${getPackageRoot()}`;
  const supervisor =
    endpoint.executorDigest === undefined
      ? `The running supervisor (pid ${pid}) does not record which FireForge it runs, so it is not this one; ${client}`
      : `The running supervisor (pid ${pid}) runs FireForge ${endpoint.version ?? 'of unknown version'} from ${endpoint.packageRoot ?? 'an unrecorded package'}; ${client}, built from other bytes`;
  const idle = Math.round(
    ((await readConfig(namespace).catch(() => undefined))?.idleMs ?? 30_000) / 1000
  );
  throw new ExecutorMismatchError(
    `${supervisor}. Its results would read as stale here, so nothing was submitted. ` +
      `Give every checkout that shares ${namespace} the same FireForge install (the same package-lock.json, then npm ci in each), ` +
      `then let the supervisor go idle: it exits ${String(idle)} s after its last job (fireforge job list shows what it is running), ` +
      `and the next submit starts it from the aligned package. ` +
      `Or pin one build for every checkout: fireforge host upgrade --from <package directory>.`
  );
}

/**
 * With a pinned build, what a client has to share with the host is the protocol,
 * not its bytes: the pinned build runs and seals every job, and `prove` measures
 * that build. A running supervisor of another build either is the pinned one or
 * holds submissions until the host switches to it.
 *
 * @throws {ExecutorMismatchError} When this client cannot speak to the pinned build, or to the supervisor running now
 */
function assertCompatible(endpoint: Endpoint, pinned: PinnedBuild, own: string): void {
  const client = `this client is FireForge ${getCliVersion()} from ${getPackageRoot()} (protocol ${String(COORDINATOR_PROTOCOL)})`;
  if (pinned.protocol !== COORDINATOR_PROTOCOL)
    throw new ExecutorMismatchError(
      `The host runs its pinned FireForge ${pinned.version} (protocol ${String(pinned.protocol)}), and ${client}, so nothing was submitted. ` +
        `Pin a build this client speaks to: fireforge host upgrade --from <package directory>, or run this checkout on FireForge ${pinned.version}.`
    );
  if (endpoint.executorDigest === own || endpoint.protocol === COORDINATOR_PROTOCOL) return;
  throw new ExecutorMismatchError(
    `The running supervisor (pid ${String(endpoint.owner.pid)}) runs FireForge ${endpoint.version ?? 'of unknown version'}, which speaks ${endpoint.protocol === undefined ? 'an unrecorded protocol' : `protocol ${String(endpoint.protocol)}`}; ${client}, so nothing was submitted. ` +
      `The host switches to its pinned FireForge ${pinned.version} when that supervisor next goes idle (fireforge job list shows what it is running); submit again then.`
  );
}

const notedBuilds = new Set<string>();

/** One line, once per pinned build and process, saying jobs run on another build than this client. */
function noteBuildDifference(pinned: PinnedBuild, own: string): void {
  if (pinned.executorDigest === own || notedBuilds.has(pinned.executorDigest)) return;
  notedBuilds.add(pinned.executorDigest);
  notice(
    `This checkout runs FireForge ${getCliVersion()}; jobs run on the host's pinned FireForge ${pinned.version} (fireforge host upgrade pins another).`
  );
}

/**
 * Submit a frozen source request. The durable journal precedes the reply, and
 * an equal key returns the same job, so any transport failure, timeout included,
 * retries under the same key instead of running the work twice.
 */
export async function submitJob(
  namespace: string,
  request: JobRequest,
  snapshot: AuthoredSnapshot,
  owner: string = ownerLabel()
): Promise<JobView> {
  const executor = await executorFingerprint();
  let last: unknown;
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(100 * attempt);
    try {
      const endpoint = await ensureSupervisor(namespace);
      const pinned = (await readPinnedRuntime(namespace))?.current;
      if (pinned === undefined) await assertSameExecutor(namespace, endpoint, executor);
      else {
        assertCompatible(endpoint, pinned, executor);
        noteBuildDifference(pinned, executor);
      }
      return (await rpc(
        endpoint,
        { operation: 'submit', owner, request, snapshot },
        SUBMIT_TIMEOUT_MS
      )) as JobView;
    } catch (error) {
      if (error instanceof CoordinatorRefusal && !/closing/.test(error.message)) throw error;
      if (error instanceof CoordinatorUnusable || error instanceof ExecutorMismatchError)
        throw error;
      last = error;
    }
  }
  throw new Error(
    `Coordinator unavailable after ${SUBMIT_ATTEMPTS} attempts; retry with the same key: ${request.key}`,
    { cause: last }
  );
}

/** A job from the journal, for reads while no supervisor runs. */
async function offlineJob(namespace: string, jobId: string): Promise<JobRecord> {
  const job = (await readJournal(namespace)).get(jobId);
  if (job === undefined)
    throw new UnknownJobError(`Unknown job: ${jobId}; fireforge job list shows what exists`);
  return job;
}

const OFFLINE_REASON = 'The supervisor is not running; job wait or job submit restarts it';

/** Reads a job without ever starting a supervisor: a poll cannot keep one alive. */
export async function readJob(namespace: string, jobId: string): Promise<JobView> {
  const endpoint = await liveEndpoint(namespace);
  if (endpoint !== undefined)
    return (await rpc(endpoint, { operation: 'status', jobId })) as JobView;
  const job = await offlineJob(namespace, jobId);
  return visibleJob(job, terminal(job.state) ? undefined : OFFLINE_REASON);
}

/** Lists every job, newest first, without their receipts. Starts nothing. */
export async function listJobs(namespace: string): Promise<JobView[]> {
  const endpoint = await liveEndpoint(namespace);
  const jobs =
    endpoint !== undefined
      ? ((await rpc(endpoint, { operation: 'list' })) as JobView[])
      : [...(await readJournal(namespace)).values()].map((job) => {
          const view = visibleJob(job, terminal(job.state) ? undefined : OFFLINE_REASON);
          delete view.receipt;
          delete view.partialReceipt;
          return view;
        });
  return jobs.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/**
 * Requests cancellation, recording who asked. A job another owner submitted is
 * refused unless `force` says the cancel is meant: sessions share one host, and
 * one session's cancel must not silently end another's work.
 *
 * @param namespace - Host coordinator namespace
 * @param jobId - The job to cancel
 * @param options - `force` cancels a job of a different owner; `owner` is the
 *   cancelling client's label, its own by default
 */
export async function cancelJob(
  namespace: string,
  jobId: string,
  options: { force?: boolean; owner?: string } = {}
): Promise<JobView> {
  const job = await readJob(namespace, jobId);
  if (terminal(job.state)) return job;
  return (await rpc(await ensureSupervisor(namespace), {
    operation: 'cancel',
    jobId,
    by: cancelAttribution(options.owner),
    ...(options.force === true ? { force: true } : {}),
  })) as JobView;
}

/**
 * Waiting is optional: the job remains owned by the supervisor if this client
 * exits. It reuses one endpoint and backs off, and restarts a supervisor only
 * when an unfinished job has none.
 *
 * @returns The job, whose state is not terminal when the wait timed out
 */
export async function waitForJob(
  namespace: string,
  jobId: string,
  timeoutMs = 60_000,
  onBlocked?: (reason: string) => void,
  onProgress?: (job: JobView) => void
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  let endpoint = await liveEndpoint(namespace);
  let blocked: string | undefined;
  // A status is one read of memory over a local socket, and a short job should not wait on its own poll.
  for (let pause = 50; ; pause = Math.min(pause * 1.5, 250)) {
    let job: JobView;
    if (endpoint === undefined) {
      job = visibleJob(await offlineJob(namespace, jobId));
      if (!terminal(job.state)) endpoint = await ensureSupervisor(namespace);
    } else {
      try {
        job = (await rpc(endpoint, { operation: 'status', jobId })) as JobView;
      } catch (error) {
        if (error instanceof CoordinatorRefusal) throw error;
        endpoint = undefined;
        continue;
      }
    }
    if (terminal(job.state) || Date.now() >= deadline) return job;
    if (job.blockedBy !== undefined && job.blockedBy !== blocked) onBlocked?.(job.blockedBy);
    blocked = job.blockedBy;
    onProgress?.(job);
    await sleep(Math.min(pause, Math.max(0, deadline - Date.now())));
  }
}

/** Read a bounded log range so long harness campaigns remain reconnectable. Starts nothing. */
export async function readJobLogs(
  namespace: string,
  jobId: string,
  offset = 0,
  limit = 262_144,
  selection?: LogSelection
): Promise<LogChunk> {
  return readLogRange(namespace, jobId, offset, limit, selection);
}

const WHOLE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_PREFIX_HEX = 8;

/**
 * The job a whole ID or a unique prefix of one names. A prefix needs 8 hex
 * characters, so it stays unique on a busy host. Starts nothing.
 *
 * @throws When the prefix is too short, names no job or names more than one
 */
export async function resolveJobId(namespace: string, given: string): Promise<string> {
  const wanted = given.toLowerCase();
  if (WHOLE_JOB_ID.test(wanted)) return wanted;
  if (!/^[0-9a-f-]+$/.test(wanted) || wanted.replaceAll('-', '').length < MIN_PREFIX_HEX)
    throw new UnknownJobError(
      `Unknown job: ${given}. Name a job by its ID or a prefix of at least ${String(MIN_PREFIX_HEX)} hex characters; fireforge job list shows them`
    );
  const matches = (await listJobs(namespace))
    .map((job) => job.id)
    .filter((id) => id.startsWith(wanted))
    .sort();
  const [only, ...others] = matches;
  if (only === undefined)
    throw new UnknownJobError(
      `Unknown job: no job ID starts with ${given}; fireforge job list shows what exists`
    );
  if (others.length > 0)
    throw new AmbiguousJobError(
      `Job prefix ${given} names ${String(matches.length)} jobs: ${matches.join(', ')}. Name more of the ID`
    );
  return only;
}

/**
 * Clears the host quarantine after a successful census. A running supervisor
 * does it, so this write and its own stay ordered.
 */
export async function clearHost(
  namespace: string,
  forget: readonly number[] = []
): Promise<{ cleared: string[] }> {
  const endpoint = await liveEndpoint(namespace);
  if (endpoint !== undefined)
    return (await rpc(endpoint, { operation: 'host-clear', forget: [...forget] })) as {
      cleared: string[];
    };
  return clearHostQuarantine(namespace, forget);
}
