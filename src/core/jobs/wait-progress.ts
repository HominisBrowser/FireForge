// SPDX-License-Identifier: EUPL-1.2
import { progressLine } from './job-progress.js';
import type { JobView } from './schema.js';

/**
 * What a waiting client says as a job moves: a line when a step finishes
 * (`step 5/11 check: red`) and one when the job enters another step or the
 * current one is admitted. A step already finished when the wait began is
 * counted in the next line, not repeated, and nothing is said while nothing
 * changed. A step still queued behind a blocked reason is left to that reason.
 *
 * @returns A function to call with each status read
 */
export function waitProgress(say: (line: string) => void): (job: JobView) => void {
  let reported: number | undefined;
  let position: string | undefined;
  return (job) => {
    const { progress } = job;
    if (progress === undefined) return;
    const total = String(progress.steps);
    const seen = reported ?? progress.results.length;
    for (const result of progress.results.slice(seen))
      say(`step ${String(result.step + 1)}/${total} ${result.label}: ${result.state}`);
    reported = progress.results.length;
    if (job.blockedBy !== undefined && !progress.running) return;
    const where = `${String(progress.step)}:${String(progress.running)}`;
    if (where === position) return;
    position = where;
    say(progressLine(progress));
  };
}
