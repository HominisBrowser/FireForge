// SPDX-License-Identifier: EUPL-1.2
import { captureAuthoredSnapshot } from '../core/authored/index.js';
import { CoordinatorRefusal, submitJob, waitForJob } from '../core/jobs/client.js';
import { type JobStep, type JobView, normalizeRequest } from '../core/jobs/schema.js';
import { type StepShape, testStep } from '../core/proof/plan.js';
import { pristineDonor } from './job-support.js';

export interface RunJobOptions {
  namespace: string;
  projectRoot: string;
  check: boolean;
  /** Build and package the release recipe. */
  release?: boolean;
  build?: 'ui' | 'full' | 'none';
  tests: readonly string[];
  /** How the tests run: the same fields a gate lane declares, so a lane can be run by hand. */
  shape?: StepShape;
  /** Holds a display and idle assertion for every step. Undefined leaves each step's default. */
  keepAwake?: boolean;
  /** A slot's name, or `auto` to leave the choice to the scheduler. */
  slot: string;
  paths: readonly string[];
  owner?: string;
  timeoutMs?: number;
}

/**
 * The steps a run asks for, cheapest first so a red stops early. A test needs a
 * package of the source it tests, so it brings a UI build unless told otherwise.
 * With nothing named, a run is the project's check.
 */
function runSteps(
  options: Pick<RunJobOptions, 'check' | 'release' | 'build' | 'tests' | 'shape' | 'keepAwake'>
): JobStep[] {
  const { check, release, build, tests, shape, keepAwake } = options;
  if (release === true) return [{ command: 'package', args: ['--recipe', 'release'] }];
  const steps: JobStep[] = [];
  if (check || (build === undefined && tests.length === 0))
    steps.push({ command: 'check', args: [] });
  const kind = build ?? (tests.length > 0 ? 'ui' : 'none');
  if (kind !== 'none') steps.push({ command: 'build', args: kind === 'ui' ? ['--ui'] : [] });
  // Fixed harness ports belong to whichever checkout took them first: a job takes free ones.
  if (tests.length > 0) steps.push(testStep(tests, shape));
  return keepAwake === undefined ? steps : steps.map((step) => ({ ...step, keepAwake }));
}

/** A test the host has no binary for: the one command that does both, and what it costs. */
function buildAndTestCommand(options: Pick<RunJobOptions, 'check' | 'slot' | 'tests'>): string {
  if (options.tests.length === 0) return '';
  const check = options.check ? ' --check' : '';
  const slot = options.slot === 'auto' ? '' : ` --slot ${options.slot}`;
  return `, or do both in one job, which takes hours on a real tree: fireforge job run${check} --build full --test ${options.tests.join(' ')}${slot}`;
}

const namedSlot = (options: Pick<RunJobOptions, 'slot'>): { slot?: string } =>
  options.slot === 'auto' ? {} : { slot: options.slot };

/**
 * Captures this checkout, submits it and waits. The submission is durable, so
 * losing this process loses nothing: the job ID goes to stderr at once and
 * `job wait` picks it up.
 *
 * @returns The job, whose state is not terminal when the wait timed out
 */
export async function runJob(options: RunJobOptions): Promise<JobView> {
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: options.projectRoot,
    intendedPaths: [...options.paths],
    pristineRepository: await pristineDonor(options.namespace, options.projectRoot),
  });
  const request = normalizeRequest(
    { steps: runSteps(options), ...namedSlot(options) },
    snapshot.id
  );
  const job = await submitJob(
    options.namespace,
    request,
    snapshot,
    ...(options.owner === undefined ? [] : [options.owner])
  ).catch((error: unknown) => {
    throw error instanceof CoordinatorRefusal &&
      error.refusedAs === 'JobCannotRunError' &&
      options.build === undefined
      ? new CoordinatorRefusal(`${error.message}${buildAndTestCommand(options)}`, error.refusedAs)
      : error;
  });
  process.stderr.write(`Job ${job.id} submitted\n`);
  return waitForJob(
    options.namespace,
    job.id,
    options.timeoutMs ?? Number.POSITIVE_INFINITY,
    (reason) => {
      process.stderr.write(`Job ${job.id} waiting: ${reason}\n`);
    }
  );
}
