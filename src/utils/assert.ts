// SPDX-License-Identifier: EUPL-1.2
/**
 * Runtime assertions for FireForge's own internal invariants.
 *
 * These check state that FireForge itself established — a journal was
 * registered before the first mutation, a lock is held before a write,
 * manifest ordering is contiguous after a renumber. They are NOT input
 * validation: anything derived from user input, the filesystem, or a
 * subprocess belongs in a typed error from `src/errors/` with a
 * `userMessage` that tells the operator what to do. An assertion failure
 * says the opposite — that nothing the operator could have done would
 * have prevented it.
 *
 * Every check routes through a helper here rather than being open-coded
 * as `if (!condition) throw`. That is deliberate: an inline throw adds a
 * permanently-uncovered branch to every function it appears in, and the
 * per-module coverage floors in `scripts/check-coverage-thresholds.mjs`
 * would pay for it in ~40 places. Routed through a call, the branch lives
 * here once and is covered here once, and the `complexity` ceiling in
 * `eslint.config.js` does not see it at all.
 *
 * This module is a leaf: it imports the error class and nothing else, per
 * the dependency-direction note in `src/utils/errors.ts`.
 */
import { InternalInvariantError } from '../errors/base.js';

/**
 * A failure description, or a thunk producing one.
 *
 * The thunk form exists so a hot call site pays nothing on the passing
 * path — `assert(ok, () => \`bad state: ${JSON.stringify(x)}\`)` builds
 * the string only when the assertion actually fails, where a plain
 * template literal would build it on every call.
 */
type AssertionMessage = string | (() => string);

/**
 * Resolves an {@link AssertionMessage} at failure time.
 * @param message - Literal description, or a thunk producing one
 * @returns The description text
 */
function resolveMessage(message: AssertionMessage): string {
  return typeof message === 'function' ? message() : message;
}

/**
 * Asserts that an internal invariant holds.
 *
 * @param condition - The invariant. Falsy means it was violated.
 * @param message - What was supposed to be true, phrased as the invariant
 *   rather than the symptom (e.g. "rollback journal registered before
 *   first mutation", not "journal is undefined"). Pass a thunk on a hot
 *   path.
 * @throws {@link InternalInvariantError} when `condition` is falsy.
 */
export function assert(condition: unknown, message: AssertionMessage): asserts condition {
  if (!condition) {
    throw new InternalInvariantError(resolveMessage(message));
  }
}

/**
 * Returns a value that must be present, throwing if it is not.
 *
 * Checks and returns in one step, so an indexed read can be asserted inline
 * (`push({ content: expectDefined(lines[k], …) })`) without first binding
 * it to a local.
 *
 * @param value - The value that should be present
 * @param message - What was supposed to be present, and why
 * @returns `value`, narrowed to exclude `null` and `undefined`
 * @throws {@link InternalInvariantError} when `value` is `null` or `undefined`.
 */
export function expectDefined<T>(value: T, message: AssertionMessage): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new InternalInvariantError(resolveMessage(message));
  }
  return value;
}
