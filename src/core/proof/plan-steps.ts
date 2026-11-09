// SPDX-License-Identifier: EUPL-1.2
import type { ProofLaneConfig } from '../../types/config.js';
import { digest } from '../authored/git.js';
import type { JobStep } from '../jobs/schema.js';

/**
 * The evidence key for a step: everything that decides what it did, and nothing about
 * where it ran. A keep-awake assertion is not in it: it holds the host's display on
 * and changes nothing a test reads, so a pass with one proves what a pass without one does.
 */
export function stepFingerprint(step: JobStep): string {
  return digest({
    command: step.command,
    args: step.args,
    files: [...(step.expected?.files ?? [])].sort(),
    assertions: [...(step.controlAssertions ?? [])].sort(),
    quiet: step.quiet ?? false,
    env: step.env ?? {},
    uploadDir: step.uploadDir ?? false,
    ...(step.holdFront === true ? { holdFront: true } : {}),
    ...(step.throttle === undefined ? {} : { throttle: step.throttle }),
    ...(step.validate === undefined ? {} : { validate: step.validate.command }),
  });
}

export type StepShape = Pick<
  ProofLaneConfig,
  | 'dispatch'
  | 'headed'
  | 'quiet'
  | 'args'
  | 'env'
  | 'uploadDir'
  | 'machArgs'
  | 'keepAwake'
  | 'holdFront'
  | 'throttle'
  | 'validate'
>;

/** What a declared shape adds to a step besides its arguments. */
export const declaredFields = (
  shape: Pick<StepShape, 'env' | 'uploadDir' | 'keepAwake' | 'holdFront' | 'throttle'>
): Pick<JobStep, 'env' | 'uploadDir' | 'keepAwake' | 'holdFront' | 'throttle'> => ({
  ...(shape.env === undefined ? {} : { env: shape.env }),
  ...(shape.uploadDir === undefined ? {} : { uploadDir: shape.uploadDir }),
  ...(shape.keepAwake === undefined ? {} : { keepAwake: shape.keepAwake }),
  ...(shape.holdFront === undefined ? {} : { holdFront: shape.holdFront }),
  ...(shape.throttle === undefined ? {} : { throttle: shape.throttle }),
});

/** A test step. A task's single file has the same fingerprint as `job run --test`, so either proves it. */
export function testStep(
  files: readonly string[],
  shape: StepShape = {},
  options: string[] = []
): JobStep {
  return {
    command: 'test',
    args: [
      ...(shape.headed === true ? [] : ['--headless']),
      '--auto-ports',
      ...(shape.dispatch === 'one-browser' ? ['--no-shard'] : []),
      ...(shape.dispatch === 'standalone' ? ['--restart-between-tests'] : []),
      ...(shape.machArgs ?? []).map((arg) => `--mach-arg=${arg}`),
      ...(shape.args ?? []),
      ...options,
      ...files,
    ],
    expected: { files: [...new Set(files)] },
    ...(shape.quiet === true ? { quiet: true } : {}),
    ...declaredFields(shape),
    ...(shape.validate === undefined ? {} : { validate: shape.validate }),
  };
}
