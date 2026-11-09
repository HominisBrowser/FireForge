// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
import { ExitCode } from './codes.js';

/**
 * A refusal from the job or slot layer, whose message already says what to do.
 * It keeps the operator's view to that one message instead of a stack trace.
 */
export class JobError extends FireForgeError {
  readonly code = ExitCode.GENERAL_ERROR;
}

/** No job has that ID. */
export class UnknownJobError extends JobError {}

/** A job ID prefix that more than one job's ID starts with. */
export class AmbiguousJobError extends JobError {}

/** No slot has that name. */
export class UnknownSlotError extends JobError {}

/** A log range outside what `job logs` serves. */
export class InvalidLogRangeError extends JobError {}

/** Nothing on this host can run the job, and nothing under way will change that. */
export class JobCannotRunError extends JobError {}

/** The running supervisor runs other FireForge bytes than this client, so nothing it ran would count here. */
export class ExecutorMismatchError extends JobError {}

/** Turns a refusal that crossed the coordinator's socket back into its own kind. */
export function jobRefusal(name: string | undefined, message: string, cause?: unknown): JobError {
  switch (name) {
    case 'UnknownJobError':
      return new UnknownJobError(message, cause);
    case 'UnknownSlotError':
      return new UnknownSlotError(message, cause);
    case 'InvalidLogRangeError':
      return new InvalidLogRangeError(message, cause);
    case 'JobCannotRunError':
      return new JobCannotRunError(message, cause);
    default:
      return new JobError(message, cause);
  }
}
