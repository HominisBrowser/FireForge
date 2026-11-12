// SPDX-License-Identifier: EUPL-1.2
/**
 * Positive ownership of a spawned process tree.
 *
 * A sampler learns the tree from one asynchronous process snapshot per tick.
 * Two facts make a process owned:
 *
 *  - Ancestry: its parent is an owned process, shown alive by the same snapshot.
 *  - Group membership: it is in the leader's process group. A detached leader
 *    starts its own session, and only that session's processes can join the
 *    group, so every member descends from the leader. The kernel does not
 *    reuse a pid while a group with that id exists, so the group stays the
 *    same group as long as it is seen non-empty at intervals far shorter than
 *    a pid wrap. Once it is seen empty, or unseen for too long, group
 *    authority ends for good.
 *
 * A descendant that left the group on purpose may be meant to outlive the
 * command (a cache daemon), so it is signalled only when its own command line
 * names a directory this run owns, and is reported otherwise.
 */
import type { ChildProcess } from 'node:child_process';

import { sleep } from '../time.js';
import {
  isAliveIn,
  listProcesses,
  type ProcessObservation,
  type ProcessSnapshot,
  signalIfAlive,
  snapshotProcesses,
} from './identity.js';
import { commandNamesRoot } from './listing.js';

/** First sampling gap: short commands fork most of their tree right away. */
const INITIAL_INTERVAL_MS = 100;
/** Sampling gap after a tick that learned something. */
const ACTIVE_INTERVAL_MS = 250;
/** Sampling gap once the tree is quiet. */
const QUIET_INTERVAL_MS = 2_000;
/**
 * How long group authority survives without seeing a member. Far below a pid
 * wrap and above the quiet interval plus one slow `ps`, so a stalled host
 * loses authority rather than keeping stale authority.
 */
const GROUP_CONTINUITY_MS = 5_000;
/** Attempts at the snapshot that a teardown decision depends on. */
const DECISION_ATTEMPTS = 3;
const DECISION_RETRY_MS = 200;
/** Poll gap while waiting for signalled processes to exit. */
const EXIT_POLL_MS = 100;
/** How long a SIGKILLed process gets to disappear from the snapshot. */
const KILL_SETTLE_MS = 500;

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
 * Authority over a spawned tree. It is this object and the births it
 * observed, never a reusable numeric group id.
 */
export interface ProcessOwnership {
  /** The leader's pid, which is also the group id. */
  readonly pid: number;
  /** Signals the live group, or the owned survivors once the leader is gone. */
  signal(signal: NodeJS.Signals): void;
  /**
   * Names directories this run owns, so a self-detached descendant whose
   * command line names one of them may be signalled.
   */
  anchorTo(roots: readonly string[]): void;
  /** Whether a fresh snapshot shows `pid` in the owned tree. */
  owns(pid: number): Promise<boolean>;
  /**
   * SIGTERM, grace, SIGKILL, for every owned survivor. Runs once: later calls
   * return the same result. Never rejects.
   */
  finish(graceMs: number): Promise<ProcessTeardown>;
}

/** Follows one leader's tree. Holds live processes only. */
class TreeSampler {
  private readonly known = new Map<number, ProcessObservation>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<ProcessSnapshot | undefined> | undefined;
  private intervalMs = INITIAL_INTERVAL_MS;
  private groupSeenAt: number | undefined = Date.now();
  private leaderSeen = false;

  constructor(
    private readonly leaderPid: number,
    private readonly isLeaderRunning: () => boolean
  ) {}

  /** Takes the first sample and starts ticking. */
  async start(): Promise<void> {
    await this.sample();
    this.schedule();
  }

  /** Stops ticking. `sample` stays usable for a final decision. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  /** Takes one snapshot that started no earlier than this call and absorbs it. Never rejects. */
  async sample(): Promise<ProcessSnapshot | undefined> {
    while (this.running !== undefined) await this.running;
    this.running = this.takeSample();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  /** {@link sample}, retrying a transient failure, for a decision that signals. */
  async sampleForDecision(): Promise<ProcessSnapshot | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = await this.sample();
      if (snapshot !== undefined || attempt >= DECISION_ATTEMPTS) return snapshot;
      await sleep(DECISION_RETRY_MS);
    }
  }

  /** The processes known alive as of the last sample. */
  owned(): ProcessObservation[] {
    return [...this.known.values()];
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sample().then(() => {
        this.schedule();
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  private async takeSample(): Promise<ProcessSnapshot | undefined> {
    const startedAt = Date.now();
    const leaderRunning = this.isLeaderRunning();
    const snapshot = await snapshotProcesses().catch(() => undefined);
    if (snapshot === undefined) return undefined;
    const learned = this.absorb(snapshot, startedAt, leaderRunning);
    this.intervalMs = learned
      ? Math.min(this.intervalMs, ACTIVE_INTERVAL_MS)
      : Math.min(this.intervalMs * 2, QUIET_INTERVAL_MS);
    return snapshot;
  }

  /** @returns Whether the snapshot showed a process this sampler did not know. */
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
    const members = [...snapshot.values()].filter((entry) => entry.group === this.leaderPid);
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
 * Splits a live tree by signalling authority: group members are owned, and a
 * process outside the group only when its command line names an owned root.
 *
 * @param group - The leader's group id
 * @param known - The live tree
 * @param roots - Absolute directories this run owns
 */
async function partitionByAuthority<T extends { pid: number; group: number }>(
  group: number,
  known: readonly T[],
  roots: readonly string[]
): Promise<{ owned: T[]; detached: DetachedProcess[] }> {
  const owned = known.filter((entry) => entry.group === group || entry.pid === group);
  const others = known.filter((entry) => entry.group !== group && entry.pid !== group);
  if (others.length === 0) return { owned, detached: [] };
  const rows = await listProcesses(['pid', 'command'], { pids: others.map((entry) => entry.pid) });
  const commands = new Map(rows.map((row) => [row.pid, row.command]));
  const detached: DetachedProcess[] = [];
  for (const entry of others) {
    const command = commands.get(entry.pid);
    if (command !== undefined && roots.some((root) => commandNamesRoot(command, root))) {
      owned.push(entry);
    } else {
      detached.push({
        pid: entry.pid,
        group: entry.group,
        ...(command === undefined ? {} : { command }),
      });
    }
  }
  return { owned, detached };
}

/** A direct child that can still take a signal. A failed spawn has no pid to signal. */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (
    child.pid === undefined ||
    child.pid <= 1 ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return false;
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * Starts observing a spawned detached group leader.
 *
 * @param child - The spawned leader
 * @returns The ownership token, or undefined where there is no group or no pid
 */
export function ownProcessTree(child: ChildProcess): ProcessOwnership | undefined {
  const pid = child.pid;
  if (pid === undefined || process.platform === 'win32') return undefined;
  const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;
  const sampler = new TreeSampler(pid, isRunning);
  const roots: string[] = [];
  const partition = (): ReturnType<typeof partitionByAuthority<ProcessObservation>> =>
    partitionByAuthority(pid, sampler.owned(), roots);

  const signalOwned = (
    snapshot: ProcessSnapshot | undefined,
    owned: readonly ProcessObservation[],
    signal: NodeJS.Signals,
    signalled?: Map<number, ProcessObservation>
  ): void => {
    if (snapshot === undefined) return;
    for (const entry of owned) {
      if (signalIfAlive(snapshot, entry, signal) && entry.pid !== pid) {
        signalled?.set(entry.pid, entry);
      }
    }
  };

  const waitForExit = async (budgetMs: number): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const { owned } = await partition();
      const remaining = deadline - Date.now();
      if (owned.length === 0 || remaining <= 0) return;
      await sleep(Math.min(EXIT_POLL_MS, remaining));
      await sampler.sample();
    }
  };

  const teardown = async (graceMs: number): Promise<ProcessTeardown> => {
    sampler.stop();
    const signalled = new Map<number, ProcessObservation>();
    const first = await sampler.sampleForDecision();
    if (first !== undefined) {
      const { owned } = await partition();
      if (owned.length > 0) {
        signalOwned(first, owned, 'SIGTERM', signalled);
        await waitForExit(graceMs);
        const afterGrace = await sampler.sampleForDecision();
        const remaining = await partition();
        signalOwned(afterGrace, remaining.owned, 'SIGKILL', signalled);
        if (remaining.owned.length > 0) await waitForExit(KILL_SETTLE_MS);
      }
    }
    const last = first === undefined ? undefined : await sampler.sampleForDecision();
    const { owned, detached } = await partition();
    const base = { signalled: [...signalled.values()], detached };
    if (last === undefined) {
      return { ...base, stillAlive: [], uncertain: 'the process table could not be read' };
    }
    const stranded = [...last.values()].filter(
      (entry) => entry.group === pid && !owned.some((known) => known.pid === entry.pid)
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
  void sampler.start();
  return {
    pid,
    signal(signal) {
      // An unreaped leader keeps its pid, so a handle that has not seen the
      // exit proves the group is this one. Afterwards only exact births may
      // be signalled, which takes a fresh snapshot.
      if (isRunning()) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          if (signalChild(child, signal)) return;
        }
      }
      void sampler.sample().then(async (snapshot) => {
        signalOwned(snapshot, (await partition()).owned, signal);
      });
    },
    anchorTo(extra) {
      roots.push(...extra);
    },
    async owns(candidate) {
      await sampler.sample();
      return sampler.owned().some((entry) => entry.pid === candidate);
    },
    finish(graceMs) {
      finished ??= teardown(graceMs);
      return finished;
    },
  };
}
