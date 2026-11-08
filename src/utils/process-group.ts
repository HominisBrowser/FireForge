// SPDX-License-Identifier: EUPL-1.2
/**
 * Positive ownership of a process tree.
 *
 * {@link ProcessTreeSampler} learns the tree from one asynchronous process
 * snapshot per tick. Two facts make a process owned:
 *
 *  - Ancestry: its parent is an owned process, shown alive by the same
 *    snapshot.
 *  - Group membership: it is in the leader's process group. A detached leader
 *    starts its own session, and only that session's processes can join the
 *    group, so every member descends from the leader. The kernel does not
 *    reuse a PID while a group with that id exists, so the group stays the
 *    same group as long as it is seen non-empty at intervals far shorter than
 *    a PID wrap. Once it is seen empty, or unseen for too long, group authority
 *    ends for good.
 *
 * A descendant that left the group on purpose is different. It may be meant to
 * outlive the command (a cache daemon, the job supervisor), so it is signalled
 * only when its own command line names a root this run owns, and is reported
 * otherwise.
 */
import type { ChildProcess } from 'node:child_process';

import { signalDirectChild } from './child-process.js';
import {
  groupMembers,
  isAliveIn,
  type ProcessObservation,
  type ProcessSnapshot,
  readProcessCommands,
  signalIfAlive,
  snapshotProcesses,
} from './process-birth.js';
import { commandNamesRoot } from './process-listing.js';
import { sleep } from './sleep.js';

/** First sampling gap: short commands fork most of their tree right away. */
const INITIAL_INTERVAL_MS = 100;

/** Sampling gap after a tick that learned something. */
const ACTIVE_INTERVAL_MS = 250;

/** Sampling gap once the tree is quiet. */
const QUIET_INTERVAL_MS = 2_000;

/**
 * How long group authority survives without seeing a member. Far below a PID
 * wrap (about 100,000 forks on macOS) and above the quiet interval plus one
 * slow `ps`, so a stalled host loses authority rather than keeping stale
 * authority.
 */
const GROUP_CONTINUITY_MS = 5_000;

/** Consecutive failed samples after which the tree counts as unobserved. */
const BLIND_AFTER_FAILURES = 10;

/** Attempts at the census that a teardown decision depends on. */
const CENSUS_ATTEMPTS = 3;

const CENSUS_RETRY_MS = 200;

/** Poll gap while waiting for signalled processes to exit. */
const EXIT_POLL_MS = 100;

/** How long a SIGKILLed process gets to disappear from the census. */
const KILL_SETTLE_MS = 500;

const DEFAULT_GRACE_MS = 1_500;

/** The durable job supervisor's entry point, in any checkout or install. */
const SUPERVISOR_COMMAND = /[/\\]supervisor-main\.(?:js|ts)(?:\s|$)/;

/**
 * Whether a command line is the job supervisor, which serves every agent on
 * the host and is never a run's to stop. A false match only leaves a process
 * alive, so the command line is enough.
 *
 * @param command - A process command line
 */
export function isSupervisorCommand(command: string): boolean {
  return SUPERVISOR_COMMAND.test(command);
}

/** Options for {@link ProcessTreeSampler}. */
export interface ProcessTreeSamplerOptions {
  /** The leader's exact identity when already known. */
  leader?: ProcessObservation;
  /**
   * Whether the leader is certainly still the spawned process: a Node handle
   * that has not seen the exit cannot be a reused PID, since an unreaped child
   * keeps its PID.
   */
  isLeaderRunning?: () => boolean;
  /** Durable ledger: awaited with the live tree whenever a tick learned a process. */
  onLearned?: (known: readonly ProcessObservation[]) => Promise<void>;
  /** Overrides the first sampling gap, for fixtures that need a frozen sampler. */
  initialIntervalMs?: number;
}

/**
 * One sampler per owned tree, with an optional durable ledger. Holds live
 * processes only, so cost follows what is alive now and not what ever ran.
 */
export class ProcessTreeSampler {
  private readonly known = new Map<number, ProcessObservation>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<ProcessSnapshot | undefined> | undefined;
  private intervalMs: number;
  private readonly quietIntervalMs: number;
  private groupSeenAt: number | undefined = Date.now();
  private leaderSeen = false;
  private failures = 0;
  private ledgerFailure: string | undefined;

  constructor(
    private readonly leaderPid: number,
    private readonly options: ProcessTreeSamplerOptions = {}
  ) {
    this.intervalMs = options.initialIntervalMs ?? INITIAL_INTERVAL_MS;
    this.quietIntervalMs = Math.max(this.intervalMs, QUIET_INTERVAL_MS);
    if (options.leader !== undefined) {
      this.known.set(leaderPid, options.leader);
      this.leaderSeen = true;
    }
  }

  /**
   * Takes the first sample and starts ticking.
   *
   * @returns Once the first sample has been absorbed
   */
  async start(): Promise<void> {
    await this.sample();
    this.schedule();
  }

  /** Stops ticking. {@link sample} stays usable for a final decision. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  /**
   * Takes one snapshot that started no earlier than this call and absorbs it.
   * Never rejects and never blocks the event loop.
   *
   * @returns The snapshot, or undefined when the census failed
   */
  async sample(): Promise<ProcessSnapshot | undefined> {
    while (this.running !== undefined) await this.running;
    this.running = this.takeSample();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  /** The processes known alive as of the last sample, leader first. */
  owned(): ProcessObservation[] {
    return [...this.known.values()];
  }

  /** Why the tree cannot be trusted as observed, when it cannot. */
  failure(): string | undefined {
    if (this.ledgerFailure !== undefined) return this.ledgerFailure;
    return this.failures >= BLIND_AFTER_FAILURES
      ? `Process census failed ${this.failures} times in a row`
      : undefined;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    await this.sample();
    this.schedule();
  }

  private async takeSample(): Promise<ProcessSnapshot | undefined> {
    const startedAt = Date.now();
    const leaderRunning = this.options.isLeaderRunning?.() ?? false;
    let snapshot: ProcessSnapshot | undefined;
    try {
      snapshot = await snapshotProcesses();
    } catch {
      snapshot = undefined;
    }
    if (snapshot === undefined) {
      this.failures += 1;
      return undefined;
    }
    this.failures = 0;
    const learned = this.absorb(snapshot, startedAt, leaderRunning);
    this.intervalMs = learned
      ? Math.min(this.intervalMs, ACTIVE_INTERVAL_MS)
      : Math.min(this.intervalMs * 2, this.quietIntervalMs);
    if (learned && this.options.onLearned !== undefined) {
      try {
        await this.options.onLearned(this.owned());
      } catch (error: unknown) {
        this.ledgerFailure = `Process ledger write failed: ${String(error)}`;
      }
    }
    return snapshot;
  }

  /** @returns Whether the snapshot taught this sampler a process it did not know. */
  private absorb(snapshot: ProcessSnapshot, startedAt: number, leaderRunning: boolean): boolean {
    for (const [pid, entry] of this.known) {
      const row = snapshot.get(pid);
      if (row?.start === entry.start) this.known.set(pid, row);
      else this.known.delete(pid);
    }
    let learned = false;
    const adopt = (row: ProcessObservation): void => {
      if (this.known.has(row.pid) || row.pid === process.pid) return;
      this.known.set(row.pid, row);
      learned = true;
    };
    if (!this.leaderSeen && leaderRunning) {
      const leader = snapshot.get(this.leaderPid);
      if (leader !== undefined) {
        adopt(leader);
        this.leaderSeen = true;
      }
    }
    for (const member of this.continuousGroupMembers(snapshot, startedAt, leaderRunning)) {
      adopt(member);
    }
    const children = new Map<number, ProcessObservation[]>();
    for (const row of snapshot.values()) {
      const siblings = children.get(row.parent);
      if (siblings) siblings.push(row);
      else children.set(row.parent, [row]);
    }
    const frontier = [...this.known.keys()];
    for (let pid = frontier.pop(); pid !== undefined; pid = frontier.pop()) {
      for (const child of children.get(pid) ?? []) {
        if (this.known.has(child.pid)) continue;
        adopt(child);
        frontier.push(child.pid);
      }
    }
    return learned;
  }

  private continuousGroupMembers(
    snapshot: ProcessSnapshot,
    startedAt: number,
    leaderRunning: boolean
  ): ProcessObservation[] {
    if (this.groupSeenAt === undefined) return [];
    const members = groupMembers(snapshot, this.leaderPid);
    if (
      leaderRunning ||
      (members.length > 0 && startedAt - this.groupSeenAt <= GROUP_CONTINUITY_MS)
    ) {
      this.groupSeenAt = Date.now();
      return members;
    }
    this.groupSeenAt = undefined;
    return [];
  }
}

/**
 * Takes a snapshot for a decision, retrying a transient failure.
 *
 * @returns The snapshot, or undefined when the census stayed unavailable
 */
async function sampleForDecision(
  sampler: ProcessTreeSampler
): Promise<ProcessSnapshot | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    const snapshot = await sampler.sample();
    if (snapshot !== undefined || attempt >= CENSUS_ATTEMPTS) return snapshot;
    await sleep(CENSUS_RETRY_MS);
  }
}

/** A descendant that left the group and was left alone. */
export interface DetachedProcess {
  pid: number;
  group: number;
  /** Its command line, when it could be read. */
  command?: string;
}

/** What a teardown did. Diagnostics, never a command's result. */
export interface ProcessTeardown {
  /** Owned processes other than the leader that outlived it and were signalled. */
  signalled: ProcessObservation[];
  /** Self-detached descendants this run cannot claim, left running. */
  detached: DetachedProcess[];
  /** Owned processes still alive after SIGKILL. */
  stillAlive: ProcessObservation[];
  /** Why the teardown could not be established, when it could not. */
  uncertain?: string;
}

/**
 * Splits the live tree by signalling authority.
 *
 * @param group - The leader's group id
 * @param known - The live tree
 * @param roots - Absolute directories this run owns
 * @returns `owned` may be signalled; `detached` may not
 */
export async function partitionByAuthority<T extends { pid: number; group: number }>(
  group: number,
  known: readonly T[],
  roots: readonly string[]
): Promise<{ owned: T[]; detached: DetachedProcess[] }> {
  const owned = known.filter((entry) => entry.group === group || entry.pid === group);
  const others = known.filter((entry) => entry.group !== group && entry.pid !== group);
  if (others.length === 0) return { owned, detached: [] };
  const commands = await readProcessCommands(others.map((entry) => entry.pid));
  const detached: DetachedProcess[] = [];
  for (const entry of others) {
    const command = commands.get(entry.pid);
    const anchored =
      command !== undefined &&
      !isSupervisorCommand(command) &&
      roots.some((root) => commandNamesRoot(command, root));
    if (anchored) owned.push(entry);
    else {
      detached.push({
        pid: entry.pid,
        group: entry.group,
        ...(command === undefined ? {} : { command }),
      });
    }
  }
  return { owned, detached };
}

/**
 * Authority over a spawned tree. It is this object and its observed births,
 * never a reusable numeric PGID.
 */
export interface ProcessOwnership {
  readonly pid: number;
  /** Signals the live group, or the owned survivors once the leader is gone. */
  signal: (signal: NodeJS.Signals) => void;
  /**
   * Names the directories this run owns, so a self-detached descendant whose
   * command line names one of them may be signalled.
   */
  anchorTo: (roots: readonly string[]) => void;
  /** Whether a fresh census shows `pid` in the owned tree. */
  owns: (pid: number) => Promise<boolean>;
  /**
   * SIGTERM, grace, SIGKILL, in that order, for every owned survivor. Runs
   * once: later calls return the same result. Never rejects.
   */
  finish: (graceMs?: number) => Promise<ProcessTeardown>;
  /** Stops observing without signalling anything. */
  dispose: () => void;
}

/**
 * Starts observing a spawned detached leader.
 *
 * @param child - The spawned leader
 * @returns The ownership token, or undefined where there is no group or no PID
 */
export function ownProcessTree(child: ChildProcess): ProcessOwnership | undefined {
  const pid = child.pid;
  if (pid === undefined || process.platform === 'win32') return undefined;
  const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;
  const sampler = new ProcessTreeSampler(pid, { isLeaderRunning: isRunning });
  const roots: string[] = [];

  const signalOwnedSurvivors = async (signal: NodeJS.Signals): Promise<void> => {
    const snapshot = await sampler.sample();
    if (snapshot === undefined) return;
    const { owned } = await partitionByAuthority(pid, sampler.owned(), roots);
    for (const entry of owned) signalIfAlive(snapshot, entry, signal);
  };

  const partition = (): ReturnType<typeof partitionByAuthority<ProcessObservation>> =>
    partitionByAuthority(pid, sampler.owned(), roots);

  const signalAll = (
    snapshot: ProcessSnapshot | undefined,
    owned: readonly ProcessObservation[],
    value: NodeJS.Signals,
    signalled: Map<number, ProcessObservation>
  ): void => {
    if (snapshot === undefined) return;
    for (const entry of owned) {
      if (signalIfAlive(snapshot, entry, value) && entry.pid !== pid)
        signalled.set(entry.pid, entry);
    }
  };

  const teardown = async (graceMs: number): Promise<ProcessTeardown> => {
    sampler.stop();
    const signalled = new Map<number, ProcessObservation>();
    const first = await sampleForDecision(sampler);
    if (first !== undefined) {
      const { owned } = await partition();
      if (owned.length > 0) {
        signalAll(first, owned, 'SIGTERM', signalled);
        await waitForExit(sampler, pid, roots, graceMs);
        const afterGrace = await sampleForDecision(sampler);
        const remaining = await partition();
        signalAll(afterGrace, remaining.owned, 'SIGKILL', signalled);
        if (remaining.owned.length > 0) await waitForExit(sampler, pid, roots, KILL_SETTLE_MS);
      }
    }
    const last = first === undefined ? undefined : await sampleForDecision(sampler);
    const { owned, detached } = await partition();
    const base = { signalled: [...signalled.values()], detached };
    if (last === undefined) {
      return { ...base, stillAlive: [], uncertain: 'process census unavailable' };
    }
    const stranded = groupMembers(last, pid).filter(
      (member) => !owned.some((entry) => entry.pid === member.pid)
    );
    return {
      ...base,
      stillAlive: owned.filter((entry) => isAliveIn(last, entry)),
      ...(stranded.length === 0
        ? {}
        : {
            uncertain: `group ${pid} still has members it can no longer claim: PID ${stranded.map((entry) => entry.pid).join(', ')}`,
          }),
    };
  };

  let finished: Promise<ProcessTeardown> | undefined;
  const controller: ProcessOwnership = {
    pid,
    signal(signal) {
      // An unreaped leader keeps its PID, so a handle that has not seen the
      // exit proves the group is this one. Afterwards only exact births may be
      // signalled, which takes a fresh census.
      if (isRunning()) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          if (signalDirectChild(child, signal)) return;
        }
      }
      void signalOwnedSurvivors(signal);
    },
    anchorTo(extra) {
      roots.push(...extra);
    },
    async owns(candidate) {
      await sampler.sample();
      return sampler.owned().some((entry) => entry.pid === candidate);
    },
    finish(graceMs = DEFAULT_GRACE_MS) {
      finished ??= teardown(graceMs);
      return finished;
    },
    dispose() {
      sampler.stop();
    },
  };
  void sampler.start();
  return controller;
}

/** Waits up to `budgetMs` for the owned tree to empty. */
async function waitForExit(
  sampler: ProcessTreeSampler,
  group: number,
  roots: readonly string[],
  budgetMs: number
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { owned } = await partitionByAuthority(group, sampler.owned(), roots);
    const remaining = deadline - Date.now();
    if (owned.length === 0 || remaining <= 0) return;
    await sleep(Math.min(EXIT_POLL_MS, remaining));
    await sampler.sample();
  }
}
