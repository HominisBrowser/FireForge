// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { captureAuthoredSnapshot } from '../core/authored/index.js';
import { isPathIgnored } from '../core/git.js';
import { CoordinatorRefusal, submitJob, waitForJob } from '../core/jobs/client.js';
import {
  assertKeptProfileOutside,
  assertKeptProfileShape,
  physicalPath,
  within,
} from '../core/jobs/kept-profile.js';
import { type JobStep, type JobView, normalizeRequest } from '../core/jobs/schema.js';
import { type StepShape, testStep } from '../core/proof/plan.js';
import { InvalidArgumentError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { followJob } from './job-follow.js';
import { pristineDonor, waitReporter } from './job-support.js';

/** An interactive browser session: the run step a person drives. */
export interface InteractiveRun {
  /** A kept profile's absolute directory. Absent, the run starts from a fresh one. */
  profile?: string;
  /** Arguments for the browser, after the profile ones. */
  browserArgs: readonly string[];
}

/**
 * A kept profile `--profile` may name: absolute, outside the coordinator
 * namespace and outside the checkout's tracked source (a path the checkout's
 * Git ignores is fine). The coordinator refuses one inside a slot, and the
 * source guard does before this runs. Created when missing.
 *
 * @returns The directory, as given
 */
export async function keptProfile(
  given: string,
  namespace: string,
  projectRoot: string
): Promise<string> {
  if (!isAbsolute(given))
    throw new InvalidArgumentError(
      `--profile takes an absolute directory outside the checkout, such as ~/fireforge-profiles/dev; ${given} is relative`,
      '--profile'
    );
  try {
    assertKeptProfileShape(given);
  } catch (error) {
    throw new InvalidArgumentError(
      toError(error).message.replace('Step profile', '--profile'),
      '--profile'
    );
  }
  await assertKeptProfileOutside(given, { 'the coordinator namespace': namespace });
  const root = await physicalPath(projectRoot);
  const physical = await physicalPath(given);
  if (within(root, physical)) {
    const offset = relative(root, physical);
    if (offset === '' || !(await isPathIgnored(root, offset)))
      throw new InvalidArgumentError(
        `--profile ${given} is inside this checkout's tracked source: name a directory outside it, or one its Git ignores`,
        '--profile'
      );
  }
  await mkdir(given, { recursive: true, mode: 0o700 });
  return given;
}

export interface RunJobOptions {
  namespace: string;
  projectRoot: string;
  check: boolean;
  /** Build and package the release recipe. */
  release?: boolean;
  build?: 'ui' | 'full' | 'none';
  tests: readonly string[];
  /** Open the browser on this checkout and stay attached until it closes. */
  run?: InteractiveRun;
  /** How the tests run: the same fields a gate lane declares, so a lane can be run by hand. */
  shape?: StepShape;
  /** Holds a display and idle assertion for every step. Undefined leaves each step's default. */
  keepAwake?: boolean;
  /** A slot's name, or `auto` to leave the choice to the scheduler. */
  slot: string;
  paths: readonly string[];
  /** Capture with changed files outside the selection left out. */
  allowDirtyRoot?: boolean;
  owner?: string;
  timeoutMs?: number;
}

/**
 * The steps a run asks for, cheapest first so a red stops early. A test needs a
 * package of the source it tests, so it brings a UI build unless told otherwise.
 * With nothing named, a run is the project's check.
 */
export function runSteps(
  options: Pick<
    RunJobOptions,
    'check' | 'release' | 'build' | 'tests' | 'run' | 'shape' | 'keepAwake'
  >
): JobStep[] {
  const { check, release, build, tests, run, shape, keepAwake } = options;
  if (release === true) return [{ command: 'package', args: ['--recipe', 'release'] }];
  const steps: JobStep[] = [];
  if (check || (build === undefined && tests.length === 0 && run === undefined))
    steps.push({ command: 'check', args: [] });
  const kind = build ?? (tests.length > 0 || run !== undefined ? 'ui' : 'none');
  if (kind !== 'none') steps.push({ command: 'build', args: kind === 'ui' ? ['--ui'] : [] });
  // Fixed harness ports belong to whichever checkout took them first: a job takes free ones.
  if (tests.length > 0) steps.push(testStep(tests, shape));
  if (run !== undefined) steps.push(interactiveStep(run));
  return keepAwake === undefined ? steps : steps.map((step) => ({ ...step, keepAwake }));
}

/** The run step a person drives, with a window, which no proof ever reads. */
function interactiveStep(run: InteractiveRun): JobStep {
  return {
    command: 'run',
    args: run.browserArgs.length === 0 ? [] : ['--', ...run.browserArgs],
    interactive: true,
    ...(run.profile === undefined ? {} : { profile: run.profile }),
  };
}

/** A test or run the host has no binary for: the one command that does both, and what it costs. */
function buildAndTestCommand(
  options: Pick<RunJobOptions, 'check' | 'slot' | 'tests' | 'run'>
): string {
  if (options.tests.length === 0 && options.run === undefined) return '';
  const check = options.check ? ' --check' : '';
  const tests = options.tests.length === 0 ? '' : ` --test ${options.tests.join(' ')}`;
  const run =
    options.run === undefined
      ? ''
      : ` --run${options.run.profile === undefined ? '' : ` --profile ${options.run.profile}`}`;
  const slot = options.slot === 'auto' ? '' : ` --slot ${options.slot}`;
  return `, or do both in one job, which takes hours on a real tree: fireforge job run${check} --build full${tests}${run}${slot}`;
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
    ...(options.allowDirtyRoot === true ? { allowDirtyRoot: true } : {}),
    onNotice: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
  const request = normalizeRequest(
    {
      steps: runSteps(options),
      ...namedSlot(options),
      // A session is never a repeat of another: each one opens its own window.
      ...(options.run === undefined ? {} : { key: `interactive-${randomUUID()}` }),
    },
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
  if (options.run !== undefined) return followJob(options.namespace, job.id);
  return waitForJob(
    options.namespace,
    job.id,
    options.timeoutMs ?? Number.POSITIVE_INFINITY,
    (reason) => {
      process.stderr.write(`Job ${job.id} waiting: ${reason}\n`);
    },
    waitReporter()
  );
}
