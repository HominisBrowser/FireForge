// SPDX-License-Identifier: EUPL-1.2
import type { JobRecord } from './schema.js';
import { stepTraits } from './step-traits.js';

/**
 * How a quiet phase holds the host. `exclusive`: nothing else runs, for a step
 * that samples performance (`test --perf-samples`) and for every step of a
 * request that set `quiet` itself rather than on its steps. `shared`: static
 * checks may run beside it while the host's load stays under the quiet limit.
 */
export type QuietMode = 'exclusive' | 'shared';

/** The current phase's quiet mode, or undefined when the phase is not quiet. */
export function quietMode(job: Pick<JobRecord, 'request' | 'phase'>): QuietMode | undefined {
  const step = job.request.steps[job.phase?.index ?? 0];
  if (!(step?.quiet ?? job.request.quiet)) return undefined;
  return step?.quiet === undefined || stepTraits(step).perfSampling ? 'exclusive' : 'shared';
}

/**
 * Whether the job's current phase may run beside a shared quiet phase: a static
 * check that is not quiet itself, so it opens no browser, runs no build and
 * claims no lane.
 */
export function joinsQuiet(job: Pick<JobRecord, 'request' | 'phase'>): boolean {
  const step = job.request.steps[job.phase?.index ?? 0];
  return step !== undefined && quietMode(job) === undefined && stepTraits(step).light;
}
