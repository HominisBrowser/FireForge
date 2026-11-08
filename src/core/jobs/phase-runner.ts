// SPDX-License-Identifier: EUPL-1.2
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { toError } from '../../utils/errors.js';
import { currentResources } from './admission.js';
import { executorFingerprint } from './evidence.js';
import { launchExecutor } from './executor.js';
import type { HeldGroup } from './host-quarantine.js';
import {
  blockedAtLaunch,
  goesOnPastRed,
  pastPhase,
  redVerdict,
  verdictSummary,
} from './phase-continue.js';
import type { PhaseHost, PhaseSession } from './phase-host.js';
import { phaseRuntimeIdentity } from './phase-identity.js';
import {
  defaultStepDeadline,
  judgePhaseEnd,
  type PhaseEnd,
  stepCause,
  withinDeadline,
} from './phase-outcome.js';
import {
  prepareJobSource,
  readyPhaseSlot,
  SLOT_WORK_DEADLINE_MS,
  SlotCannotServeError,
} from './phase-preparation.js';
import {
  judgeUnderLoad,
  recordStepOutput,
  sealPassedSteps,
  stampPhaseReport,
} from './phase-report.js';
import { abandonSessions, heldGroup, settleProcesses, tearDownLaunch } from './phase-settlement.js';
import { signalOwnedProcess } from './process.js';
import { OwnedProcessTracker } from './process-tracker.js';
import {
  type JobRecord,
  jobSlot,
  type JobState,
  type SealedReceipt,
  type StepVerdict,
  terminal,
} from './schema.js';
import { pendingControl } from './slot-audit.js';
import { SlotCondemnations, type SlotMark } from './slot-condemnation.js';
import { ClaimReplacedError } from './slot-lock.js';
import {
  acquireSlot,
  markSlotForAudit,
  readSlot,
  sealSlot,
  SlotIntegrityError,
  SlotPreparationError,
} from './slots.js';

export type { PhaseHost } from './phase-host.js';

const message = (error: unknown): string => toError(error).message;

/** The grace a cancelled executor gets between SIGTERM and SIGKILL. */
const CANCEL_GRACE_MS = 20_000;

/**
 * The work of a phase: everything slow, per job and outside the decision queue,
 * which each step re-enters only to record what happened.
 */
export class PhaseRunner {
  private readonly sessions = new Map<string, PhaseSession>();
  /** Marks on their way to a slot's disk. */
  readonly condemnations: SlotCondemnations;

  constructor(private readonly host: PhaseHost) {
    this.condemnations = new SlotCondemnations(host.namespace, host.logFault);
  }

  /** Jobs holding a slot right now, and slots whose lock waits for a write. */
  get activeCount(): number {
    return this.sessions.size + this.condemnations.size;
  }

  holdsSlot(job: JobRecord): boolean {
    return this.sessions.has(job.id);
  }

  /**
   * Takes the slot for a job's first phase. Runs in the decision queue, so
   * admission and the lock agree.
   *
   * @throws When a live process holds the slot, which leaves the job queued
   */
  async claimSlot(job: JobRecord, slot: string): Promise<void> {
    if (this.sessions.has(job.id)) return;
    const release = await acquireSlot(this.host.namespace, slot, { jobId: job.id });
    this.sessions.set(job.id, { release, prepared: false });
  }

  /** Starts an admitted phase, or seals a job whose phases are done. */
  async startPhase(job: JobRecord): Promise<void> {
    try {
      if (job.phase !== undefined && job.phase.index >= job.request.steps.length) {
        await this.seal(job);
        return;
      }
      await this.launchPhase(job);
    } catch (error) {
      if (blockedAtLaunch(job, error, this.sessions.get(job.id)?.child !== undefined)) {
        await this.advancePast(job, [
          { step: job.phase?.index ?? 0, state: 'blocked', reason: message(error) },
        ]);
        return;
      }
      await this.failStart(job, error);
    }
  }

  /**
   * Moves a job past its current phase to the next step that can run, recording
   * the verdicts this phase ends with and the steps they block. A cancel that
   * landed meanwhile ends the job instead.
   */
  private async advancePast(
    job: JobRecord,
    verdicts: readonly StepVerdict[],
    also?: (draft: JobRecord) => void
  ): Promise<void> {
    const { index, known, all } = pastPhase(job, verdicts);
    const keep =
      (list: readonly StepVerdict[]) =>
      (draft: JobRecord): void => {
        also?.(draft);
        if (list.length > 0) draft.stepVerdicts = [...list];
      };
    const next = { index, active: false, ticket: this.host.nextTicket() };
    const advanced = await this.host.decide(async () => {
      // Checked in the queue: a cancel either landed already, or will see this phase inactive.
      if (job.cancellationRequested) return false;
      await this.host.transition(job, (draft) => {
        keep(all)(draft);
        // The next phase queues with a fresh ticket and holds no CPU/build/browser resource.
        draft.phase = { ...next };
        delete draft.executionToken;
        delete draft.process;
      });
      return true;
    });
    if (advanced) this.host.requestSchedule();
    else
      await this.conclude(job, {
        state: 'cancelled',
        reason: 'Cancelled while running',
        also: keep(known),
      });
  }

  private session(job: JobRecord): PhaseSession {
    const session = this.sessions.get(job.id);
    if (session === undefined) throw new Error('Missing exclusive slot ownership');
    return session;
  }

  private slotId(job: JobRecord): string {
    const slot = jobSlot(job);
    if (slot === undefined) throw new Error('Admitted job has no assigned slot');
    return slot;
  }

  private async launchPhase(job: JobRecord): Promise<void> {
    const { namespace } = this.host;
    const phase = job.phase;
    if (phase === undefined) throw new Error('Admitted job has no phase');
    const session = this.session(job);
    const assertLive = (): void => {
      if (job.cancellationRequested) throw new Error('Cancelled before phase admission');
    };
    assertLive();
    if (
      job.executorToolsDigest !== this.host.executorDigest() ||
      (await executorFingerprint()) !== this.host.executorDigest()
    )
      throw new Error('Accepted job requires the original unchanged executor tool epoch');
    if (!session.prepared) {
      await prepareJobSource(namespace, job, this.slotId(job), (projectToolsDigest) =>
        this.host.decide(() =>
          this.host.transition(job, (draft) => {
            draft.projectToolsDigest = projectToolsDigest;
          })
        )
      );
      session.prepared = true;
    }
    const step = job.request.steps[phase.index];
    phase.nonce = randomUUID();
    const slot = await readyPhaseSlot(namespace, job, this.slotId(job), phase.nonce, assertLive);
    const executor = await launchExecutor(namespace, job, slot.root);
    const { child, identity, token } = executor;
    // Store the launched handle before any durable/runtime operation can reject.
    session.child = child;
    session.unsettled = true;
    if (executor.ownership) session.ownership = executor.ownership;
    this.watchExecutor(job, child);
    const seconds = step?.deadlineSeconds ?? (step ? defaultStepDeadline(step) : 3600);
    const deadlineAt = new Date(Date.now() + seconds * 1000).toISOString();
    await this.host.decide(() =>
      this.host.transition(job, (draft) => {
        draft.process = identity;
        draft.executionToken = token;
        if (draft.phase !== undefined) draft.phase.deadlineAt = deadlineAt;
        recordStepOutput(namespace, draft, phase.index);
      })
    );
    const runtime = await phaseRuntimeIdentity(namespace, slot);
    const tracker = new OwnedProcessTracker(
      join(namespace, 'artifacts', job.id, `step-${phase.index}-processes.json`),
      identity,
      slot.root,
      phase.nonce
    );
    session.tracker = tracker;
    try {
      await tracker.start();
    } catch (error) {
      session.ownershipError = message(error);
      session.stop ??= { since: Date.now() };
    }
    // A cancel that landed before this phase had a process to signal.
    if (job.cancellationRequested) session.stop ??= { since: Date.now() };
    if (session.stop !== undefined) await this.signalStop(job.id, session);
    await executor.start(runtime, currentResources(job).cpu);
    session.ownership?.dispose();
    delete session.ownership;
  }

  /** Ends the phase when its executor does. */
  private watchExecutor(job: JobRecord, child: ChildProcess): void {
    child.once('error', (error) => {
      this.host.task(job, () => this.finishPhase(job, { code: null, detail: String(error) }));
    });
    child.once('exit', (code, signal) => {
      this.host.task(job, () =>
        this.finishPhase(job, { code, ...(signal === null ? {} : { signal }) })
      );
    });
    // Exiting before these listeners existed sends no event: the phase still has to end.
    if (child.exitCode !== null || child.signalCode !== null)
      this.host.task(job, () =>
        this.finishPhase(job, {
          code: child.exitCode,
          ...(child.signalCode === null ? {} : { signal: child.signalCode }),
        })
      );
  }

  /**
   * A job that has not started anything goes back to waiting when the problem is
   * the slot's: another slot, a restore or a peer's build can still run it.
   *
   * @returns Whether it went back
   */
  private async requeueIfSlotsProblem(
    job: JobRecord,
    session: PhaseSession | undefined,
    error: unknown
  ): Promise<boolean> {
    if (job.cancellationRequested || job.state !== 'running' || job.phase?.index !== 0)
      return false;
    // A job that named no slot was only sent here by a view of the slot that has since moved.
    if (error instanceof SlotCannotServeError && job.request.slot === undefined) {
      await this.requeue(job);
      return true;
    }
    // The previous job's drift is not this job's failure.
    if (
      error instanceof SlotIntegrityError &&
      !(error instanceof SlotPreparationError) &&
      session?.prepared === false
    ) {
      await this.requeue(job, message(error));
      return true;
    }
    return false;
  }

  /** A phase that could not start: a refusal unless its executor's teardown says otherwise. */
  private async failStart(job: JobRecord, error: unknown): Promise<void> {
    const session = this.sessions.get(job.id);
    const child = session?.child;
    const killed = child !== undefined && child.signalCode !== null;
    const uncertain = session === undefined ? undefined : await tearDownLaunch(job, session);
    if (await this.requeueIfSlotsProblem(job, session, error)) return;
    const integrity = error instanceof SlotIntegrityError || uncertain !== undefined;
    const partial = integrity ? undefined : await sealPassedSteps(this.host.namespace, job);
    const sealing = (job.phase?.index ?? 0) >= job.request.steps.length;
    await this.conclude(job, {
      state: job.cancellationRequested ? 'cancelled' : killed ? 'interrupted' : 'failed',
      reason: killed
        ? `Executor stopped from outside during launch: ${message(error)}`
        : message(error),
      holds: uncertain !== undefined && child?.pid !== undefined ? [heldGroup(job, child.pid)] : [],
      ...(integrity ? { quarantine: uncertain ?? message(error) } : {}),
      ...(partial === undefined ? {} : { partial }),
      ...(child === undefined && !integrity && !sealing
        ? {
            also: (draft: JobRecord) => {
              draft.refused = true;
            },
          }
        : {}),
    });
  }

  /**
   * Returns a job that never ran to the queue, its slot quarantined when this
   * reports what the slot itself did. A mark that cannot land keeps the lock, so
   * the job goes back to waiting either way.
   */
  private async requeue(job: JobRecord, quarantine?: string): Promise<void> {
    await this.host.decide(async () => {
      if (quarantine === undefined || (await this.mark(job, { quarantine })))
        await this.releaseLock(job);
      await this.host.settle(job, (draft) => {
        draft.state = 'queued';
        if (draft.phase !== undefined) draft.phase.active = false;
        if (draft.request.slot === undefined) delete draft.slot;
      });
    });
    this.host.requestSchedule();
  }

  /** An executor exited: census outside the queue, then record the phase's outcome. */
  private async finishPhase(job: JobRecord, end: PhaseEnd): Promise<void> {
    const session = this.sessions.get(job.id);
    if (session?.child === undefined || job.phase === undefined) return;
    delete session.child;
    const settled = await settleProcesses(job, session);
    session.unsettled = settled.uncertain !== undefined;
    const cause =
      end.code === 0
        ? undefined
        : await stepCause(join(this.host.namespace, 'logs', `${job.id}.log`));
    const verdict = judgePhaseEnd(job, {
      ...end,
      ...(cause === undefined ? {} : { cause }),
      ...(settled.uncertain === undefined ? {} : { uncertain: settled.uncertain }),
    });
    const recorded = (draft: JobRecord): void => {
      draft.exitCode = end.code ?? -1;
      if (settled.detached !== undefined)
        draft.detached = [...(draft.detached ?? []), ...settled.detached];
    };
    if (!verdict.advance) {
      const { judged, peak, hostState } = await judgeUnderLoad(this.host.namespace, job, verdict);
      const host = (draft: JobRecord): void => {
        recorded(draft);
        if (peak !== undefined) draft.hostLoadPeak = peak;
        if (hostState !== undefined) draft.hostState = hostState;
      };
      if (await goesOnPastRed(this.host.namespace, job, judged, settled)) {
        await this.advancePast(job, [redVerdict(job, judged.reason, peak, hostState)], host);
        return;
      }
      const clean = judged.state === 'failed' && judged.quarantine === undefined;
      const partial = clean ? await sealPassedSteps(this.host.namespace, job) : undefined;
      await this.conclude(job, {
        ...judged,
        also: host,
        holds: settled.holds,
        ...(partial === undefined ? {} : { partial }),
      });
      return;
    }
    // Left running with no foothold, so it stands. It can still act later, so the next job looks first.
    if (settled.detached !== undefined)
      await markSlotForAudit(this.host.namespace, this.slotId(job)).catch(() => undefined);
    const step = job.request.steps[job.phase.index];
    if (step === undefined) throw new Error('Missing completed adapter step');
    try {
      await stampPhaseReport(this.host.namespace, job, step);
    } catch (error) {
      await this.conclude(job, {
        state: job.cancellationRequested ? 'cancelled' : 'failed',
        reason: message(error),
        also: recorded,
      });
      return;
    }
    await this.advancePast(job, [], recorded);
  }

  /** Receipt first, then the journal row that makes it count, then the lock. */
  private async seal(job: JobRecord): Promise<void> {
    const { namespace } = this.host;
    const verdicts = job.stepVerdicts ?? [];
    // A job that went on past a red ends failed, with evidence for the steps that passed.
    if (verdicts.length > 0) {
      const partial = await sealPassedSteps(namespace, job);
      await this.conclude(job, {
        state: 'failed',
        reason: verdictSummary(job, verdicts),
        ...(partial === undefined ? {} : { partial }),
      });
      return;
    }
    const receiptPath = join(namespace, 'receipts', `${job.id}.json`);
    const slot = await readSlot(namespace, this.slotId(job));
    const receipt = await withinDeadline(
      sealSlot(namespace, slot, job),
      SLOT_WORK_DEADLINE_MS,
      () =>
        new SlotIntegrityError(
          `Sealing did not finish within ${String(SLOT_WORK_DEADLINE_MS / 60_000)} minutes`
        )
    );
    await this.host
      .decide(async () => {
        // A cancel marks the job before it enters this queue, so this check cannot miss one it acknowledges.
        if (job.cancellationRequested) throw new Error('Cancellation prevents sealing');
        try {
          await this.host.transition(job, (draft) => {
            draft.receipt = receipt;
            draft.state = 'passed';
            delete draft.executionToken;
            if (draft.phase !== undefined) draft.phase.active = false;
          });
        } catch (error) {
          await rm(receiptPath, { force: true });
          throw error;
        }
        await this.releaseLock(job);
      })
      .catch(async (error: unknown) => {
        await rm(receiptPath, { force: true });
        throw error;
      });
    this.host.requestSchedule();
  }

  /** Lets go of a slot, or keeps retrying that when it cannot yet. */
  private async releaseLock(job: JobRecord): Promise<void> {
    const session = this.sessions.get(job.id);
    this.sessions.delete(job.id);
    if (session === undefined) return;
    const slot = jobSlot(job);
    try {
      await session.release();
    } catch (error) {
      if (slot !== undefined && !(error instanceof ClaimReplacedError))
        this.condemnations.keepLock(slot, session.release);
    }
  }

  /**
   * Records what a job leaves on its slot. If that does not reach the disk, the
   * lock stays held along with the memory of why, until the heartbeat gets it through.
   *
   * @returns Whether it reached the disk, so that the caller may let go of the lock
   */
  private async mark(job: JobRecord, mark: SlotMark): Promise<boolean> {
    const slot = jobSlot(job);
    const session = this.sessions.get(job.id);
    if (slot === undefined || session === undefined) return true;
    if (await this.condemnations.record(slot, mark)) return true;
    this.sessions.delete(job.id);
    this.condemnations.keepLock(slot, session.release);
    return false;
  }

  /**
   * Sends a stopping phase the signal it is due, and keeps sending it: a failed
   * probe sends nothing and says nothing, so one attempt is not enough.
   */
  private async signalStop(jobId: string, session: PhaseSession): Promise<void> {
    const identity = this.host.liveProcess(jobId);
    if (session.stop === undefined || session.child === undefined || identity === undefined) return;
    const due: NodeJS.Signals =
      Date.now() - session.stop.since >= CANCEL_GRACE_MS ? 'SIGKILL' : 'SIGTERM';
    if (session.stop.sent === due) return;
    if (await signalOwnedProcess(identity, due)) session.stop.sent = due;
  }

  /** Escalates every phase that has been asked to stop. */
  async retryStops(): Promise<void> {
    for (const [id, session] of this.sessions) await this.signalStop(id, session);
  }

  /**
   * Ends a job. Slot metadata first, so a crash cannot leave a condemned slot
   * looking healthy; then the journal; then the lock. A failure in one step
   * never skips the next.
   */
  private async conclude(
    job: JobRecord,
    outcome: {
      state: JobState;
      reason?: string;
      quarantine?: string;
      also?: (draft: JobRecord) => void;
      /** Evidence for the steps before a red one. */
      partial?: SealedReceipt;
      /** Process groups the phase left. */
      holds?: readonly HeldGroup[];
    }
  ): Promise<void> {
    if (terminal(job.state)) return;
    const { namespace } = this.host;
    const held = this.sessions.get(job.id);
    const slot = jobSlot(job);
    let quarantine = outcome.quarantine;
    if (held !== undefined && slot !== undefined && quarantine === undefined) {
      const root = (await readSlot(namespace, slot).catch(() => undefined))?.root;
      if (root !== undefined && (await pendingControl(root).catch(() => true)))
        quarantine = 'Negative control restoration remains pending';
    }
    await this.host.decide(async () => {
      const reason = job.reason ?? outcome.reason;
      const ended = (draft: JobRecord): void => {
        draft.state = outcome.state;
        if (reason !== undefined && reason !== '') draft.reason = reason;
        delete draft.executionToken;
        delete draft.receipt;
        if (outcome.partial !== undefined) draft.partialReceipt = outcome.partial;
        if (draft.phase !== undefined) draft.phase.active = false;
        outcome.also?.(draft);
      };
      // Written before the row: a crash in between finds a running job and quarantines its slot.
      const landed = await this.mark(job, {
        holds: outcome.holds ?? [],
        ...(quarantine === undefined ? {} : { quarantine }),
      });
      if (landed) {
        await this.host.settle(job, ended);
        await this.releaseLock(job);
      } else this.host.settleLater(job, ended);
    });
    await rm(join(namespace, 'receipts', `${job.id}.json`), { force: true });
    this.host.requestSchedule();
  }

  /**
   * Stops a job. Runs in the decision queue. A job that is doing nothing ends
   * here; a job with an executor is signalled and ends when it exits. `reason`
   * is recorded when this, rather than a client, stopped the job.
   */
  async cancel(job: JobRecord, reason?: string): Promise<void> {
    if (terminal(job.state)) return;
    job.cancellationRequested = true;
    const session = this.sessions.get(job.id);
    if (session === undefined) {
      await this.host.transition(job, (draft) => {
        draft.cancellationRequested = true;
        draft.state = 'cancelled';
        draft.reason = reason ?? 'Cancelled before admission';
      });
      return;
    }
    await this.host.transition(job, (draft) => {
      draft.cancellationRequested = true;
      if (reason !== undefined) draft.reason = reason;
    });
    if (job.phase?.active === false) {
      this.host.task(job, () =>
        this.conclude(job, { state: 'cancelled', reason: 'Cancelled between admitted phases' })
      );
      return;
    }
    session.stop ??= { since: Date.now() };
    await this.signalStop(job.id, session);
  }

  /**
   * Stops every running executor because the namespace recording them is gone.
   * Nothing can be journaled any more; what remains is not to leave them running.
   */
  abandon(): void {
    abandonSessions(this.sessions, this.host.liveProcess, CANCEL_GRACE_MS);
  }

  /** Records background work that failed for a job, ending it however that is still possible. */
  async recordFailure(job: JobRecord, error: unknown): Promise<void> {
    if (terminal(job.state)) return;
    const reason = `Supervisor task failed: ${message(error)}`;
    // Anything that went wrong before settlement finished leaves what is still running unknown.
    const unsettled = this.sessions.get(job.id)?.unsettled === true;
    await this.conclude(job, {
      state: job.cancellationRequested ? 'cancelled' : 'failed',
      reason,
      ...(unsettled && job.process !== undefined
        ? { holds: [heldGroup(job, job.process.pid)] }
        : {}),
      ...(error instanceof SlotIntegrityError || unsettled ? { quarantine: reason } : {}),
    });
  }
}
