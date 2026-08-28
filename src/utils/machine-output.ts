// SPDX-License-Identifier: EUPL-1.2
/**
 * The `--json` envelope contract, in one place.
 *
 * Without a single owner, machine-readable output drifts into unrelated
 * shapes: two commands sharing a `schemaVersion: 1` envelope can still
 * disagree on failure, so a scripted consumer gets a parseable refusal from
 * one and a bare non-zero exit from the other.
 *
 * The contract, documented in `docs/machine-output.md`:
 *   1. Success writes exactly one JSON document to stdout.
 *   2. Failure writes exactly one `{ schemaVersion, error, code }` document
 *      to stdout, then exits non-zero.
 *   3. Machine mode is engaged BEFORE any output, so every diagnostic —
 *      including one rendered later by `withErrorHandling` — routes to
 *      stderr and cannot corrupt the payload.
 */
import { CommandError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';

/** Current envelope version. Bump only with a documented migration. */
export const MACHINE_OUTPUT_SCHEMA_VERSION = 1;

/**
 * Writes the machine-readable error envelope to stdout and throws the
 * sentinel that carries the exit code to the entrypoint. Never returns.
 *
 * @param code - Stable machine-readable reason tag, e.g. `engine-missing`
 * @param message - Human-readable explanation, identical to the non-JSON text
 * @param exitCode - Exit code to terminate with
 */
export function emitMachineError(
  code: string,
  message: string,
  exitCode: ExitCode = ExitCode.GENERAL_ERROR
): never {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION, error: message, code })}\n`
  );
  throw new CommandError(exitCode);
}
