// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';

import { JobCannotRunError, UnknownJobError } from '../../errors/job.js';
import { toError } from '../../utils/errors.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { planAdmission, whyNoSlotCanRun } from './admission.js';
import {
  atDecision,
  observeAdmission,
  type ObservedAdmission,
  readCoordinatorConfig,
  slotViews,
} from './admission-context.js';
import { type Election, electSupervisor } from './election.js';
import { executorFingerprint } from './evidence.js';
import { clearHostQuarantine } from './host-quarantine.js';
import { visibleJob } from './job-view.js';
import { assertCleanupReport, authorizeExecution } from './phase-capability.js';
import { PhaseRunner } from './phase-runner.js';
import { type Endpoint, publishedEndpoint, type RpcRequest, socketDirectory } from './protocol.js';
import { recoverJobJournal } from './recovery.js';
import { compactJobHistory } from './retention.js';
import {
  type CoordinatorConfig,
  type JobRecord,
  type JobRequest,
  jobSlot,
  type JobView,
  terminal,
} from './schema.js';
import { finishTrash } from './slot-template.js';
import { SlotBusyError } from './slots.js';
import {
  appendTransition,
  damagedJournalPath,
  ensurePrivateNamespace,
  namespaceGone,
  writeDurable,
} from './store.js';
import {
  assertRequestShape,
  findDuplicate,
  repeatStillStands,
  validateSubmission,
} from './submission.js';
import { serveConnection } from './supervisor-rpc.js';

const unknownJob = (jobId: string): UnknownJobError =>
  new UnknownJobError(`Unknown job: ${jobId}; fireforge job list shows what exists`);

/** How often an unfinished host re-checks what blocks it: deadlines, slots, disk, quarantine. */
const HEARTBEAT_MS = 1_000;

/**
 * Same-user local coordinator. Its serial queue holds only decisions and journal
 * appends; everything slow runs as per-job tasks that re-enter the queue to
 * record results. Reads are served from memory, so no job's work can make
 * another job's status or authorization time out.
 */
export class LocalSupervisor {
  /** Live records, which tasks and decisions change. */
  private readonly jobs = new Map<string, JobRecord>();
  /** Each job as last journaled: what every client read sees. */
  private readonly durable = new Map<string, JobRecord>();
  /** Why each waiting job is not running, rebuilt on every scheduling pass. */
  private blocked = new Map<string, string>();
  private readonly submissions = new Map<string, Promise<JobView>>();
  private readonly taskTails = new Map<string, Promise<void>>();
  private readonly unjournaled = new Set<string>();
  private readonly runner: PhaseRunner;
  private serial: Promise<void> = Promise.resolve();
  private retained: Promise<unknown> = Promise.resolve();
  private server: Server | undefined;
  private closing = false;
  private idle: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private schedulePending = false;
  private endpoint: Endpoint | undefined;
  private ticket = 1;
  private executorDigest = '';
  private journalFault: string | undefined;

  private constructor(
    private readonly namespace: string,
    private config: CoordinatorConfig,
    private readonly election: Election
  ) {
    this.runner = new PhaseRunner({
      namespace,
      executorDigest: () => this.executorDigest,
      decide: (work) => this.decide(work),
      transition: (job, mutate) => this.transition(job, mutate),
      settle: (job, mutate) => this.settle(job, mutate),
      settleLater: (job, mutate) => {
        this.settleLater(job, mutate);
      },
      logFault: (context, error) => {
        this.logFault(context, error);
      },
      task: (job, work) => {
        this.task(job, work);
      },
      nextTicket: () => this.ticket++,
      requestSchedule: () => {
        this.requestSchedule();
      },
      liveProcess: (jobId) => this.jobs.get(jobId)?.process,
    });
  }

  /** Election and crash reconciliation finish before publishing a usable endpoint. */
  static async start(namespace: string): Promise<LocalSupervisor> {
    const election = await electSupervisor(namespace);
    try {
      const supervisor = new LocalSupervisor(
        namespace,
        await readCoordinatorConfig(namespace),
        election
      );
      supervisor.executorDigest = await executorFingerprint();
      await supervisor.recover();
      await supervisor.listen();
      return supervisor;
    } catch (error) {
      await election.release();
      throw error;
    }
  }

  /** Serialize admission, cancellation and terminal recording. Holds nothing slow. */
  private decide<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Runs work for a job after its earlier work. It can fail but never crash the process. */
  private task(job: JobRecord, work: () => Promise<void>): void {
    const tail = (this.taskTails.get(job.id) ?? Promise.resolve())
      .then(work)
      .catch(async (error: unknown) => {
        this.logFault(`Task for job ${job.id} failed`, error);
        try {
          await this.runner.recordFailure(job, error);
        } catch (recording) {
          this.logFault(`Could not record the failure of job ${job.id}`, recording);
        }
      });
    this.taskTails.set(job.id, tail);
  }

  private logFault(context: string, error: unknown): void {
    process.stderr.write(`${context}: ${toError(error).message}\n`);
  }

  /** Journals a change, then applies it: no reader sees a state a crash could still undo. */
  private async transition(job: JobRecord, mutate: (draft: JobRecord) => void): Promise<void> {
    const draft = structuredClone(job);
    mutate(draft);
    draft.updatedAt = new Date().toISOString();
    draft.epoch = this.election.epoch;
    await appendTransition(this.namespace, draft);
    mutate(job);
    job.updatedAt = draft.updatedAt;
    job.epoch = draft.epoch;
    this.durable.set(job.id, draft);
  }

  /**
   * A transition for a job that has to end even with an unwritable journal. It
   * ends in memory, admission pauses, and the heartbeat keeps retrying the row.
   * A crash before that succeeds replays the job as interrupted.
   */
  private async settle(job: JobRecord, mutate: (draft: JobRecord) => void): Promise<void> {
    try {
      await this.transition(job, mutate);
    } catch (error) {
      mutate(job);
      this.durable.set(job.id, structuredClone(job));
      this.unjournaled.add(job.id);
      this.journalFault = `The coordinator journal cannot be written: ${toError(error).message}`;
      this.logFault(`Journal write failed for job ${job.id}`, error);
    }
  }

  /** A job's end whose row waits for the mark on its slot, so a crash first still reads as running. */
  private settleLater(job: JobRecord, mutate: (draft: JobRecord) => void): void {
    mutate(job);
    this.durable.set(job.id, structuredClone(job));
    this.unjournaled.add(job.id);
  }

  /** Retries rows {@link settle} could not write. A row whose slot mark has not landed keeps waiting. */
  private async flushJournal(): Promise<void> {
    for (const id of [...this.unjournaled]) {
      const job = this.jobs.get(id);
      if (job === undefined || this.runner.condemnations.isPending(jobSlot(job))) continue;
      await appendTransition(this.namespace, job);
      this.unjournaled.delete(id);
    }
    this.journalFault = undefined;
  }

  private async recover(): Promise<void> {
    const recovered = await recoverJobJournal(this.namespace, this.election.epoch);
    // Housekeeping: a host short of disk still has to start.
    await compactJobHistory(this.namespace, recovered.jobs).catch((error: unknown) => {
      this.logFault('Could not compact job history', error);
    });
    for (const [id, job] of recovered.jobs) {
      this.jobs.set(id, job);
      this.durable.set(id, structuredClone(job));
    }
    if (recovered.damaged > 0)
      this.logFault('Damaged journal rows moved aside', damagedJournalPath(this.namespace));
    for (const { job, slot, quarantine, holds } of recovered.marks) {
      this.unjournaled.add(job);
      await this.runner.condemnations.record(slot, { quarantine, holds });
    }
    await this.flushJournal();
    this.ticket = recovered.nextTicket;
    // A removal a crash interrupted; nothing waits on it and the next start finishes what this cannot.
    void finishTrash(this.namespace).catch((error: unknown) => {
      this.logFault('Could not finish removing a slot', error);
    });
  }

  private async listen(): Promise<void> {
    const directory = socketDirectory(this.namespace);
    await ensurePrivateNamespace(directory);
    const socket = join(directory, `${this.election.epoch}.sock`);
    await rm(socket, { force: true });
    this.endpoint = publishedEndpoint(socket, this.election, this.executorDigest);
    this.server = createServer({ allowHalfOpen: true }, (connection) => {
      serveConnection(connection, (request) => this.dispatch(request));
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(socket, () => {
        resolve();
      });
    });
    await writeDurable(join(this.namespace, 'endpoint.json'), this.endpoint);
    this.requestSchedule();
    this.armHeartbeat();
    this.armIdle();
  }

  /**
   * Answers one request. Reads never enter the decision queue and never count as
   * activity, so polling can neither stall nor keep alive an idle supervisor.
   */
  private async dispatch(request: RpcRequest): Promise<unknown> {
    switch (request.operation) {
      case 'status':
        return this.view(request.jobId);
      case 'list':
        return [...this.durable.values()].map((job) => {
          const view = visibleJob(job, this.blocked.get(job.id));
          delete view.receipt;
          delete view.partialReceipt;
          return view;
        });
      case 'authorize':
        return authorizeExecution(this.namespace, this.durable.get(request.jobId), request);
      case 'cleanup-uncertain': {
        const job = this.durable.get(request.jobId);
        assertCleanupReport(job, request);
        // A CLI's census can miss under load. The phase's own final census decides what it means.
        this.logFault(`Job ${job.id} reported an uncertain teardown`, request.reason);
        return { noted: true };
      }
      case 'cancel':
        return this.cancel(request.jobId);
      case 'submit':
        return this.submit(request.request, request.snapshot, request.owner ?? 'unknown');
      case 'host-clear': {
        const cleared = await this.decide(() =>
          clearHostQuarantine(this.namespace, request.forget ?? [])
        );
        this.requestSchedule();
        return cleared;
      }
    }
  }

  private view(jobId: string): JobView {
    const job = this.durable.get(jobId);
    if (job === undefined) throw unknownJob(jobId);
    return visibleJob(job, this.blocked.get(jobId));
  }

  private async cancel(jobId: string): Promise<JobView> {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw unknownJob(jobId);
    // Set here, before the queue: a seal already recording its result must see it.
    if (!terminal(job.state)) job.cancellationRequested = true;
    this.disarmIdle();
    await this.decide(() => this.runner.cancel(job));
    this.requestSchedule();
    this.armIdle();
    return this.view(jobId);
  }

  /** Acknowledges after the durable journal row. Equal keys share one submission in flight. */
  private submit(request: JobRequest, snapshot: AuthoredSnapshot, owner: string): Promise<JobView> {
    if (this.closing) throw new Error('Coordinator closing; retry idempotent submission');
    const running = this.submissions.get(request.key);
    if (running !== undefined) return running;
    this.disarmIdle();
    const submission = this.attachOrAdmit(request, snapshot, owner).finally(() => {
      this.submissions.delete(request.key);
      this.armIdle();
    });
    this.submissions.set(request.key, submission);
    return submission;
  }

  private async attachOrAdmit(
    request: JobRequest,
    snapshot: AuthoredSnapshot,
    owner: string
  ): Promise<JobView> {
    // `host init` may have just changed it, and what it told someone to run comes next.
    this.config = await readCoordinatorConfig(this.namespace);
    assertRequestShape(request, snapshot, this.config);
    const duplicate = findDuplicate(this.jobs.values(), request);
    if (duplicate === undefined || !(await repeatStillStands(this.namespace, duplicate)))
      return this.admit(request, snapshot, owner);
    if (JSON.stringify(duplicate.request) !== JSON.stringify(request))
      throw new Error(`Idempotency key ${request.key} was used for a different request`);
    return this.view(duplicate.id);
  }

  private async admit(
    request: JobRequest,
    captured: AuthoredSnapshot,
    owner: string
  ): Promise<JobView> {
    const { snapshot, stepResources, compiledDigest } = await this.retainInOrder(() =>
      validateSubmission({
        namespace: this.namespace,
        config: this.config,
        request,
        snapshot: captured,
        executorDigest: this.executorDigest,
      })
    );
    const unrunnable = whyNoSlotCanRun(
      { id: '', request, compiledDigest, pin: snapshot.pin.commit },
      await slotViews(this.namespace),
      [...this.jobs.values()]
    );
    if (unrunnable !== undefined) throw new JobCannotRunError(unrunnable);
    await writeDurable(join(this.namespace, 'snapshots', `${snapshot.id}.json`), snapshot);
    const now = new Date().toISOString();
    const job: JobRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      owner,
      request,
      state: 'queued',
      epoch: this.election.epoch,
      submittedAt: now,
      updatedAt: now,
      cancellationRequested: false,
      executorToolsDigest: this.executorDigest,
      pin: snapshot.pin.commit,
      compiledDigest,
      stepResources,
      ...(request.slot === undefined ? {} : { slot: request.slot }),
    };
    await this.decide(async () => {
      job.phase = { index: 0, active: false, ticket: this.ticket++ };
      await appendTransition(this.namespace, job);
      this.jobs.set(job.id, job);
      this.durable.set(job.id, structuredClone(job));
    });
    this.requestSchedule();
    return this.view(job.id);
  }

  /** One retention at a time: they share a repository whose creation must not race. */
  private retainInOrder<T>(work: () => Promise<T>): Promise<T> {
    const result = this.retained.then(work, work);
    this.retained = result.catch(() => undefined);
    return result;
  }

  /** Asks for one scheduling pass. Passes coalesce, and a failed one costs only a later retry. */
  private requestSchedule(): void {
    if (this.schedulePending || this.closing) return;
    this.schedulePending = true;
    void observeAdmission(this.namespace, this.journalFault)
      .then((context) => {
        this.config = context.config;
        return context;
      })
      .catch((error: unknown) => {
        return {
          config: this.config,
          blocked: `Host state could not be read: ${toError(error).message}`,
        };
      })
      .then((context) =>
        this.decide(async () => {
          this.schedulePending = false;
          await this.schedule(context);
        })
      )
      .catch((error: unknown) => {
        this.schedulePending = false;
        this.logFault('Scheduling pass failed', error);
      });
  }

  /** Admits what fits. Each admission is journaled here; its work runs as a task. */
  private async schedule(context: ObservedAdmission): Promise<void> {
    if (this.closing) return;
    const plan = planAdmission([...this.jobs.values()], {
      ...(await atDecision(this.namespace, context)),
      ...(context.slots === undefined
        ? {}
        : { slots: this.runner.condemnations.overlay(context.slots) }),
    });
    this.blocked = plan.blocked;
    // Nothing started, so this records nothing against the job's steps.
    for (const [job, reason] of [...plan.refuse, ...plan.interrupt])
      await this.settle(job, (draft) => {
        draft.state = plan.refuse.has(job) ? 'failed' : 'interrupted';
        draft.reason = reason;
        if (plan.refuse.has(job)) draft.refused = true;
      });
    for (const { job, slot } of plan.admit) {
      try {
        if (slot !== undefined) await this.runner.claimSlot(job, slot);
        await this.transition(job, (draft) => {
          if (slot !== undefined) draft.slot = slot;
          const done = (draft.phase?.index ?? 0) >= draft.request.steps.length;
          draft.state = done ? 'sealing' : 'running';
          if (draft.phase !== undefined) draft.phase.active = true;
        });
        this.task(job, () => this.runner.startPhase(job));
      } catch (error) {
        if (error instanceof SlotBusyError) this.blocked.set(job.id, error.message);
        else {
          this.logFault(`Could not admit job ${job.id}`, error);
          this.blocked.set(job.id, `Could not admit: ${String(error)}`);
        }
      }
    }
  }

  /** Stops what overran its deadline, retries what could not be written, re-checks what blocks. */
  private armHeartbeat(): void {
    if (this.heartbeat !== undefined || this.closing) return;
    this.heartbeat = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private async beat(): Promise<void> {
    try {
      if (await namespaceGone(this.namespace)) {
        this.abandon();
        return;
      }
      if (this.runner.condemnations.size > 0 || this.unjournaled.size > 0)
        await this.decide(async () => {
          await this.runner.condemnations.retry();
          await this.flushJournal();
        });
      await this.runner.retryStops();
      const now = Date.now();
      for (const job of this.jobs.values()) {
        const deadline = job.phase?.deadlineAt;
        if (
          deadline === undefined ||
          terminal(job.state) ||
          job.phase?.active !== true ||
          job.cancellationRequested ||
          Date.parse(deadline) > now
        )
          continue;
        const step = job.request.steps[job.phase.index];
        await this.decide(() =>
          this.runner.cancel(
            job,
            `Step ${job.phase?.index ?? 0} (${step?.command ?? 'seal'}) exceeded its deadline`
          )
        );
      }
    } catch (error) {
      this.logFault('Heartbeat failed', error);
    }
    if ([...this.jobs.values()].some((job) => !terminal(job.state))) this.requestSchedule();
    else this.armIdle();
  }

  /**
   * Stops serving a namespace that was deleted. Nothing can be recorded or
   * recovered any more, and staying up would strand this process forever.
   */
  private abandon(): void {
    this.logFault('Coordinator namespace is gone; stopping', this.namespace);
    this.closing = true;
    this.disarmIdle();
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.runner.abandon();
    this.server?.close();
    if (this.endpoint !== undefined) {
      const { socket } = this.endpoint;
      void rm(socket, { force: true })
        .then(() => rmdir(dirname(socket)))
        .catch(() => undefined);
    }
  }

  private disarmIdle(): void {
    if (this.idle !== undefined) clearTimeout(this.idle);
    this.idle = undefined;
  }

  private idleEligible(): boolean {
    return (
      !this.closing &&
      this.submissions.size === 0 &&
      this.runner.activeCount === 0 &&
      this.unjournaled.size === 0 &&
      [...this.jobs.values()].every((job) => terminal(job.state))
    );
  }

  private armIdle(): void {
    if (this.idle !== undefined || !this.idleEligible()) return;
    this.idle = setTimeout(() => {
      this.idle = undefined;
      void this.decide(async () => {
        if (this.idleEligible()) await this.close();
      }).catch((error: unknown) => {
        this.logFault('Idle shutdown failed', error);
      });
    }, this.config.idleMs);
  }

  /** Close so that any submission either persisted or is told to retry. */
  async close(): Promise<void> {
    if (this.runner.activeCount > 0) throw new Error('Cannot close supervisor with active jobs');
    this.closing = true;
    this.disarmIdle();
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.server?.close();
    if (this.endpoint !== undefined) {
      await rm(this.endpoint.socket, { force: true });
      // Empty once this socket is gone, and a fixed per-user directory should not accumulate.
      await rmdir(dirname(this.endpoint.socket)).catch(() => undefined);
    }
    await rm(join(this.namespace, 'endpoint.json'), { force: true });
    await this.election.release();
  }
}
