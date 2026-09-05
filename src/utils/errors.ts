// SPDX-License-Identifier: EUPL-1.2
/**
 * Throwable normalisation primitives.
 *
 * This module must import nothing. It sits at the very bottom of the
 * dependency graph (81 modules across `core/`, `commands/`, `utils/` and
 * `bin/` reach it), so it is the one place a shared helper can live and be
 * provably cycle-immune. Adding an import here makes that whole subtree
 * reachable from every util, and any future `src/errors/*` module wanting a
 * util back (`errors/git.ts` already carries a mirrored index-lock heuristic
 * that would like `getNodeErrorCode`) then closes the loop and fails the
 * `dpdm --exit-code circular:1` release gate. A helper that needs an import
 * belongs in a sibling leaf module, not here.
 */

/** Normalizes unknown throwables into an Error instance. */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message, { cause: error });
  }

  return new Error(typeof error === 'string' ? error : String(error), { cause: error });
}

/**
 * Extracts a Node errno string (`ENOENT`, `EACCES`, `EPERM`, …) from an
 * unknown throwable, or `undefined` when the value carries no string `code`.
 *
 * The check is structural rather than `error instanceof Error`: a plain
 * object carrying `.code` (exactly the shape {@link toError} exists to
 * normalise) reaches errno consumers through rejected promises and
 * cross-realm throws, and an `instanceof Error` gate misclassifies it as "no
 * code".
 */
export function getNodeErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

/**
 * Checks whether a process with the given PID is still running, using
 * `kill(pid, 0)`: no signal is sent, only the existence check is performed.
 *
 * Only `ESRCH` ("no such process") means dead. `EPERM` means alive: the
 * process exists but is owned by another uid, which happens routinely with
 * root-owned builds, `sudo`, shared CI runners and container UID mismatches.
 * Reading EPERM as dead in a predicate that gates a recursive delete removes
 * a live build's tree clone or a live furnace lock out from under its owner.
 * Any other errno is treated as "unknown, assume alive", the safe direction
 * for every caller: it refuses rather than destroys.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return getNodeErrorCode(error) !== 'ESRCH';
  }
}
