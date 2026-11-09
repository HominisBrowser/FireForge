// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { toError } from '../../utils/errors.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { buildNeed, slotServes, type SlotView } from './admission.js';
import {
  type CoordinatorConfig,
  DEFAULT_REPLICATE_DEPTH,
  type JobRecord,
  type JobRequest,
  jobSlot,
  terminal,
} from './schema.js';
import { SlotBusyError } from './slot-lock.js';
import {
  abandonReplication,
  clearReplicationMarker,
  readReplicationMarker,
  replicateSlotBuild,
  ReplicationDeclined,
  type ReplicationMarker,
  replicationText,
  writeReplicationMarker,
} from './slot-replication.js';
import { readJson, slotDirectory } from './store.js';

export interface ReplicationChoice {
  from: string;
  to: string;
  /** Jobs waiting for the build, which is why it is copied. */
  waiting: number;
}

/** Destinations whose loss costs least: no build at all, then one that needs a full build anyway. */
const cost = (slot: SlotView): number =>
  slot.anchorDigest === undefined ? 0 : slot.requiresFullBuild === true ? 1 : 2;

/**
 * Which idle slot's build to copy into which other idle slot, if any. A build
 * is worth copying when the jobs waiting for it number at least `depth` per slot
 * that holds it. Only a build a UI build extends is copied: a copied package
 * still holds the source slot's paths, so a job that only reads one waits for
 * the slot that built it. The destination is an idle slot on the same pin that
 * no queued job could take now or names, so no build anyone queued for is lost.
 */
export function planReplication(
  jobs: readonly JobRecord[],
  slots: ReadonlyMap<string, SlotView>,
  depth: number,
  declined: (from: string, to: string, anchor: string) => boolean = () => false
): ReplicationChoice | undefined {
  if (depth <= 0) return undefined;
  const occupied = new Set(
    jobs
      .filter((job) => job.state === 'running' || job.state === 'sealing')
      .map((job) => jobSlot(job))
  );
  const waiting = jobs.filter((job) => job.state === 'queued' && !job.cancellationRequested);
  const onPin = (job: JobRecord, slot: SlotView): boolean =>
    job.pin === undefined || job.pin === slot.pin;
  const idle = [...slots.values()].filter(
    (slot) => slot.quarantined === null && slot.replicating === undefined && !occupied.has(slot.id)
  );
  for (const source of idle) {
    const anchor = source.anchorDigest;
    if (anchor === undefined) continue;
    const waiters = waiting.filter(
      (job) =>
        jobSlot(job) === undefined &&
        onPin(job, source) &&
        buildNeed(job) === 'anchor' &&
        slotServes(source, job)
    );
    const first = waiters[0];
    if (first === undefined) continue;
    const holders = [...slots.values()].filter(
      (slot) => slot.quarantined === null && onPin(first, slot) && slotServes(slot, first)
    );
    if (waiters.length < depth * holders.length) continue;
    const destination = idle
      .filter(
        (slot) =>
          slot.id !== source.id &&
          slot.pin === source.pin &&
          !declined(source.id, slot.id, anchor) &&
          !waiting.some(
            (job) =>
              jobSlot(job) === slot.id ||
              (jobSlot(job) === undefined && onPin(job, slot) && slotServes(slot, job))
          )
      )
      .sort((a, b) => cost(a) - cost(b) || a.id.localeCompare(b.id))[0];
    if (destination !== undefined)
      return { from: source.id, to: destination.id, waiting: waiters.length };
  }
  return undefined;
}

/** What the supervisor lends a replicator. */
export interface ReplicatorHost {
  namespace: string;
  /** Submits a job as the supervisor's own. */
  submit: (
    request: JobRequest,
    snapshot: AuthoredSnapshot,
    owner: string
  ) => Promise<{ id: string }>;
  requestSchedule: () => void;
  logFault: (context: string, error: unknown) => void;
}

/**
 * The supervisor's build replication, one at a time. Each scheduling pass hands
 * it the jobs and slots, inside the decision queue; it settles replications that
 * ended, starts one where a queue warrants it, and returns the slots as
 * admission must see them: a source being copied and a destination being
 * copied into or relocated serve no job meanwhile, except the relocation itself.
 * The copy runs outside the queue, holding both slots' locks.
 */
export class SlotReplicator {
  private active: { from: string; to: string; anchor: string } | undefined;
  /** Destinations whose abandonment is under way, so a pass does not start it twice. */
  private readonly settling = new Set<string>();
  /** Pairs that cannot work for this build, so a pass does not try them every second. */
  private readonly declined = new Set<string>();

  constructor(private readonly host: ReplicatorHost) {}

  /** A copy is running, which keeps the supervisor up. */
  get busy(): boolean {
    return this.active !== undefined || this.settling.size > 0;
  }

  async pass(
    jobs: readonly JobRecord[],
    slots: ReadonlyMap<string, SlotView>,
    config: Pick<CoordinatorConfig, 'replicateDepth'>
  ): Promise<Map<string, SlotView>> {
    const views = new Map([...slots].map(([id, view]) => [id, { ...view }]));
    for (const view of views.values()) {
      const marker = await readReplicationMarker(this.host.namespace, view.id).catch(
        (error: unknown) => {
          // Unreadable, it could be anything: the slot serves nothing until it reads again.
          view.replicating = `unable to read a replication into slot ${view.id}: ${toError(error).message}`;
          return undefined;
        }
      );
      if (marker === undefined) continue;
      view.replicating = replicationText(marker.from, view.id);
      if (marker.job !== undefined) view.replicationJob = marker.job;
      if (this.active?.to !== view.id) this.settle(view.id, marker, jobs);
    }
    if (this.active !== undefined) this.withhold(views, this.active.from, this.active.to);
    if (this.active === undefined) {
      const choice = planReplication(
        jobs,
        views,
        config.replicateDepth ?? DEFAULT_REPLICATE_DEPTH,
        (from, to, anchor) => this.declined.has(`${from}>${to}@${anchor}`)
      );
      const anchor = choice === undefined ? undefined : views.get(choice.from)?.anchorDigest;
      if (choice !== undefined && anchor !== undefined) {
        this.active = { from: choice.from, to: choice.to, anchor };
        this.withhold(views, choice.from, choice.to);
        void this.run(choice.from, choice.to, anchor);
      }
    }
    return views;
  }

  private withhold(views: Map<string, SlotView>, from: string, to: string): void {
    for (const id of [from, to]) {
      const view = views.get(id);
      if (view !== undefined) view.replicating = replicationText(from, to);
    }
  }

  /** Ends a replication whose relocation finished, or which no live task carries on. */
  private settle(id: string, marker: ReplicationMarker, jobs: readonly JobRecord[]): void {
    if (this.settling.has(id)) return;
    const job =
      marker.job === undefined ? undefined : jobs.find((entry) => entry.id === marker.job);
    if (job !== undefined && !terminal(job.state)) return;
    if (job?.state === 'passed') {
      this.settling.add(id);
      void clearReplicationMarker(this.host.namespace, id)
        .catch((error: unknown) => {
          this.host.logFault(`Could not finish replicating into slot ${id}`, error);
        })
        .finally(() => {
          this.settling.delete(id);
          this.host.requestSchedule();
        });
      return;
    }
    const reason =
      job === undefined
        ? 'the replication was interrupted'
        : `relocating job ${job.id} ended ${job.state}${job.reason === undefined ? '' : `: ${job.reason}`}`;
    this.settling.add(id);
    void abandonReplication(this.host.namespace, id, marker, reason)
      .then(() => {
        this.host.logFault(`Replicating slot ${marker.from}'s build into ${id} failed`, reason);
      })
      .catch((error: unknown) => {
        if (!(error instanceof SlotBusyError))
          this.host.logFault(`Could not settle the replication into slot ${id}`, error);
      })
      .finally(() => {
        this.settling.delete(id);
        this.host.requestSchedule();
      });
  }

  /** Copies, then submits the qualification that relocates the copy, as the supervisor's own job. */
  private async run(from: string, to: string, anchor: string): Promise<void> {
    try {
      await replicateSlotBuild(this.host.namespace, from, to);
      const snapshot = await readJson<AuthoredSnapshot>(
        join(slotDirectory(this.host.namespace, to), 'snapshot.json')
      );
      const job = await this.host.submit(
        {
          schemaVersion: 1,
          key: `replicate-${to}-${randomUUID()}`,
          slot: to,
          sourceId: snapshot.id,
          steps: [{ command: 'qualify-native', args: [] }],
          quiet: false,
        },
        snapshot,
        'fireforge replication'
      );
      const marker = await readReplicationMarker(this.host.namespace, to);
      if (marker !== undefined)
        await writeReplicationMarker(this.host.namespace, to, { ...marker, job: job.id });
    } catch (error) {
      const retry = error instanceof ReplicationDeclined && error.retry;
      if (error instanceof ReplicationDeclined && !retry)
        this.declined.add(`${from}>${to}@${anchor}`);
      // A lock or a process in the way is tried again next pass, without a line every second.
      if (!retry)
        this.host.logFault(
          `Replicating slot ${from}'s build into ${to} did not run`,
          toError(error)
        );
    } finally {
      this.active = undefined;
      this.host.requestSchedule();
    }
  }
}
