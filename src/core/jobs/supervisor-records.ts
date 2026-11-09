// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { visibleJob } from './job-view.js';
import { type CancelAttribution, type JobRecord, type JobView, terminal } from './schema.js';

/**
 * Every job as a list shows it: without receipts, which only a status read carries.
 *
 * @param jobs - The durable job records
 * @param blocked - Why each waiting job waits
 * @returns One view per job
 */
export function listedViews(
  jobs: Iterable<JobRecord>,
  blocked: ReadonlyMap<string, string>
): JobView[] {
  return [...jobs].map((job) => {
    const view = visibleJob(job, blocked.get(job.id));
    delete view.receipt;
    delete view.partialReceipt;
    return view;
  });
}

/**
 * Refuses a cancel of another owner's unfinished job unless it is forced.
 *
 * @param job - The job to cancel
 * @param by - Who asks, when the client said
 * @param force - Whether the caller passed --force
 * @throws {Error} When the job belongs to another owner and nothing forces it
 */
export function assertMayCancel(
  job: JobRecord,
  by: CancelAttribution | undefined,
  force: boolean
): void {
  if (terminal(job.state) || force || by === undefined || by.owner === job.owner) return;
  throw new Error(
    `Job ${job.id} belongs to ${job.owner}, and this is ${by.owner} (${by.cwd}): cancelling it would stop another session's work. Pass --force to cancel it anyway`
  );
}

/**
 * A newly submitted job, queued at its first step.
 *
 * @param fields - What the submission decided
 * @returns The job record, not yet journaled
 */
export function queuedJob(
  fields: Pick<
    JobRecord,
    | 'owner'
    | 'request'
    | 'epoch'
    | 'executorToolsDigest'
    | 'pin'
    | 'compiledDigest'
    | 'stepResources'
  >
): JobRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    state: 'queued',
    submittedAt: now,
    updatedAt: now,
    cancellationRequested: false,
    ...fields,
    ...(fields.request.slot === undefined ? {} : { slot: fields.request.slot }),
  };
}

/**
 * The running steps past their deadline, each with the reason it is stopped.
 *
 * @param jobs - The supervisor's jobs
 * @param now - The clock, in epoch milliseconds
 * @returns Each overdue job and why it stops
 */
export function overdueSteps(jobs: Iterable<JobRecord>, now: number): [JobRecord, string][] {
  const overdue: [JobRecord, string][] = [];
  for (const job of jobs) {
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
    overdue.push([
      job,
      `Step ${String(job.phase.index)} (${step?.command ?? 'seal'}) exceeded its deadline`,
    ]);
  }
  return overdue;
}

/**
 * Ends a job that never started a step: refused outright, or interrupted before it could.
 *
 * @param draft - The job record being settled
 * @param reason - Why it ends
 * @param refused - Whether nothing on this host could ever run it
 */
export function endUnstarted(draft: JobRecord, reason: string, refused: boolean): void {
  draft.state = refused ? 'failed' : 'interrupted';
  draft.reason = reason;
  if (refused) draft.refused = true;
}

/**
 * Removes a supervisor socket and its directory in the background, best effort.
 *
 * @param socket - The socket path
 */
export function removeSocket(socket: string): void {
  void rm(socket, { force: true })
    .then(() => rmdir(dirname(socket)))
    .catch(() => undefined);
}
