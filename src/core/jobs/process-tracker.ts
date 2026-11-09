// SPDX-License-Identifier: EUPL-1.2
/**
 * Durable process ownership for one job phase: the shared tree sampler with a
 * ledger on disk, so a restarted supervisor can finish what a crashed one owned.
 */
import { realpath } from 'node:fs/promises';

import { getNodeErrorCode } from '../../utils/errors.js';
import {
  isAliveIn,
  type ProcessObservation,
  type ProcessSnapshot,
  signalIfAlive,
  snapshotProcesses,
} from '../../utils/process-birth.js';
import {
  type DetachedProcess,
  isSupervisorCommand,
  partitionByAuthority,
  ProcessTreeSampler,
} from '../../utils/process-group.js';
import { listProcesses } from '../../utils/process-list.js';
import { sleep } from '../../utils/sleep.js';
import type { ProcessIdentity } from './schema.js';
import { slotFootholds } from './slot-holders.js';
import { readJson, writeDurable } from './store.js';

/** One ledger entry. The leader is always the first entry of a ledger. */
export interface OwnedProcess {
  identity: ProcessIdentity;
  group: number;
}

/** Result of finishing a phase's process tree. */
export interface ProcessCleanup {
  clean: boolean;
  /** Live processes that keep this phase's cleanup from being established. */
  unknown: { pid: number; group: number }[];
  /** Self-detached descendants with no foothold in the slot, left running and reported. */
  detached?: DetachedProcess[];
}

/** Grace between SIGTERM and SIGKILL for what outlived the executor. */
const CLEANUP_GRACE_MS = 500;

/**
 * The most a SIGKILLed process gets to disappear from the census. The wait polls
 * and ends as soon as every process is gone, so this caps a loaded host's teardown
 * rather than delaying a quiet one; a survivor past it quarantines the slot.
 */
const KILL_SETTLE_MS = 2_000;

const POLL_MS = 50;

const CENSUS_ATTEMPTS = 3;

const CENSUS_RETRY_MS = 200;

function toLedgerEntry(entry: ProcessObservation): OwnedProcess {
  return { identity: { pid: entry.pid, start: entry.start }, group: entry.group };
}

/**
 * Observes positive ancestry while it exists. A later path or PPID 1 match is
 * never authority to signal.
 */
export class OwnedProcessTracker {
  private readonly sampler: ProcessTreeSampler;
  private readonly leader: OwnedProcess;

  /**
   * @param ledger - Where the durable ledger lives
   * @param leader - The executor's exact identity
   * @param root - The slot root this phase owns
   * @param phase - The phase's per-run marker, present in its environment
   * @param options - `initialIntervalMs` overrides the first sampling gap, for fixtures
   */
  constructor(
    private readonly ledger: string,
    leader: ProcessIdentity,
    private readonly root: string,
    private readonly phase?: string,
    options: { initialIntervalMs?: number } = {}
  ) {
    const leaderEntry: OwnedProcess = { identity: leader, group: leader.pid };
    this.leader = leaderEntry;
    this.sampler = new ProcessTreeSampler(leader.pid, {
      leader: { ...leader, parent: 0, group: leader.pid },
      onLearned: (known) =>
        writeDurable(ledger, [
          leaderEntry,
          ...known.filter((entry) => entry.pid !== leader.pid).map(toLedgerEntry),
        ]),
      ...(options.initialIntervalMs === undefined
        ? {}
        : { initialIntervalMs: options.initialIntervalMs }),
    });
  }

  /** Writes the scope and the first ledger before the phase may start. */
  async start(): Promise<void> {
    if (this.phase) await writeDurable(`${this.ledger}.scope.json`, { phase: this.phase });
    await writeDurable(this.ledger, [this.leader]);
    await this.sampler.start();
  }

  /**
   * Stops sampling and finishes the tree.
   *
   * @throws When the tree went unobserved or the ledger could not be written
   */
  async finish(): Promise<ProcessCleanup> {
    this.sampler.stop();
    await this.sampler.sample();
    const failure = this.sampler.failure();
    const result = await finishOwnedProcesses(
      this.ledger,
      this.root,
      this.leader.identity.pid,
      this.phase
    );
    if (failure !== undefined) throw new Error(`Process ownership sampling failed: ${failure}`);
    return result;
  }
}

async function census(): Promise<ProcessSnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    const snapshot = await snapshotProcesses();
    if (snapshot !== undefined) return snapshot;
    if (attempt >= CENSUS_ATTEMPTS) throw new Error('Process census unavailable');
    await sleep(CENSUS_RETRY_MS);
  }
}

/** The processes a phase's ledger recorded. Absent, it recorded none. */
export async function readProcessLedger(ledger: string): Promise<OwnedProcess[]> {
  try {
    return await readJson<OwnedProcess[]>(ledger);
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    return [];
  }
}

async function readPhase(ledger: string, phase: string | undefined): Promise<string | undefined> {
  if (phase !== undefined) return phase;
  try {
    return (await readJson<{ phase: string }>(`${ledger}.scope.json`)).phase;
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    return undefined;
  }
}

/**
 * Processes carrying this phase's marker in their environment.
 *
 * The marker alone is detection, never authority to signal. macOS hides the
 * environment of Apple platform binaries (`/bin/sh`, `/usr/bin/python3`) from
 * `ps eww`, so one of those that detached before it was sampled escapes this
 * census; the ledger and the group check still cover everything sampled.
 */
export async function phaseMarkedProcesses(
  phase: string
): Promise<{ pid: number; group: number }[]> {
  const marker = `FIREFORGE_JOB_PHASE=${phase}`;
  const rows = await listProcesses(['pid', 'pgid', 'command'], { includeEnvironment: true });
  return rows
    .filter(
      (row) =>
        row.pid !== process.pid &&
        row.command.split(/\s+/).includes(marker) &&
        !isSupervisorCommand(row.command)
    )
    .map((row) => ({ pid: row.pid, group: row.pgid }));
}

type LiveEntry = OwnedProcess & { pid: number };

/**
 * Marked processes the ledger never recorded, with their births from `snapshot`:
 * a helper that detached and was reparented between two samples, as the xpcshell
 * harness's HTTP/2 server is when the harness exits without stopping it.
 */
async function unrecordedMarked(
  phase: string | undefined,
  snapshot: ProcessSnapshot,
  leaderPid: number,
  recorded: readonly LiveEntry[]
): Promise<LiveEntry[]> {
  if (phase === undefined) return [];
  return (await phaseMarkedProcesses(phase)).flatMap((row) => {
    const seen = snapshot.get(row.pid);
    if (
      seen === undefined ||
      row.pid === leaderPid ||
      recorded.some((entry) => entry.pid === row.pid)
    )
      return [];
    return [{ identity: { pid: row.pid, start: seen.start }, group: seen.group, pid: row.pid }];
  });
}

async function waitUntilGone(owned: readonly OwnedProcess[], budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const snapshot = await census();
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !owned.some((entry) => isAliveIn(snapshot, entry.identity))) return;
    await sleep(Math.min(POLL_MS, remaining));
  }
}

/**
 * Signals only what the phase can claim, then vetoes acceptance if a process it
 * cannot account for survives. It can claim a recorded birth in its group, and a
 * self-detached one whose command line names the slot root; a process carrying
 * the phase marker that the ledger never recorded is claimed on the same terms,
 * since the marker shows it descends from the phase and the command line ties it
 * to the slot. Any other self-detached process is left running. Holding the slot
 * open vetoes like any other survivor, since it can still change what a later job
 * reads. With no foothold in the slot it is reported and the phase stands: that
 * is how a cache daemon looks, and it owns nothing this phase produced. A marked
 * process that appears only after the phase's processes were signalled vetoes.
 *
 * @param ledger - Path of the phase's ledger
 * @param root - The slot root this phase owned
 * @param leaderPid - The executor, which its owner handles; 0 when it is unknown
 * @param phase - The phase marker, or undefined to read the ledger's scope file
 * @throws When the process census stays unavailable
 */
export async function finishOwnedProcesses(
  ledger: string,
  root: string,
  leaderPid: number,
  phase?: string
): Promise<ProcessCleanup> {
  const known = await readProcessLedger(ledger);
  const group = leaderPid > 0 ? leaderPid : (known[0]?.identity.pid ?? 0);
  const first = await census();
  const live: LiveEntry[] = known
    .filter((entry) => entry.identity.pid !== leaderPid && isAliveIn(first, entry.identity))
    .map((entry) => ({ ...entry, pid: entry.identity.pid }));
  const roots = await slotRoots(root);
  const resolvedPhase = await readPhase(ledger, phase);
  const strays = await unrecordedMarked(resolvedPhase, first, leaderPid, live);
  const { owned, detached } = await partitionByAuthority(group, [...live, ...strays], roots);
  for (const entry of owned) signalIfAlive(first, entry.identity, 'SIGTERM');
  if (owned.length > 0) {
    await waitUntilGone(owned, CLEANUP_GRACE_MS);
    const afterGrace = await census();
    for (const entry of owned) signalIfAlive(afterGrace, entry.identity, 'SIGKILL');
    await waitUntilGone(owned, KILL_SETTLE_MS);
  }
  const marked =
    resolvedPhase === undefined
      ? []
      : (await phaseMarkedProcesses(resolvedPhase)).filter((row) => row.pid !== leaderPid);
  const last = await census();
  const surviving = owned
    .filter((entry) => isAliveIn(last, entry.identity))
    .map((entry) => ({ pid: entry.pid, group: entry.group }));
  const footholds =
    detached.length === 0
      ? new Set<number>()
      : await slotFootholds(
          detached.map((entry) => entry.pid),
          roots
        );
  // Each carries its birth, so whoever remembers it later never mistakes a reused pid for it.
  const births = new Map([...live, ...strays].map((entry) => [entry.pid, entry.identity.start]));
  const daemons = detached
    .filter((entry) => !footholds.has(entry.pid))
    .map((entry) => {
      const start = births.get(entry.pid);
      return start === undefined ? entry : { ...entry, start };
    });
  const anchored = detached
    .filter((entry) => footholds.has(entry.pid) && last.has(entry.pid))
    .map((entry) => ({ pid: entry.pid, group: entry.group }));
  const judged = new Set([...owned, ...detached].map((entry) => entry.pid));
  const unaccounted = marked.filter((row) => last.has(row.pid) && !judged.has(row.pid));
  const unknown = [...unaccounted, ...surviving, ...anchored];
  return {
    clean: unknown.length === 0,
    unknown,
    ...(daemons.length === 0 ? {} : { detached: daemons }),
  };
}

/** A slot root by the path it was given and by its real path. */
async function slotRoots(root: string): Promise<string[]> {
  try {
    return [root, await realpath(root)];
  } catch {
    return [root];
  }
}
