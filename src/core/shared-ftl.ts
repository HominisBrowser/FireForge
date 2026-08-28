// SPDX-License-Identifier: EUPL-1.2
/**
 * Structural rules for the `sharedFtl` field on a custom component.
 *
 * Both the `--shared-ftl` CLI flag path (`furnace create`) and the
 * furnace.json parser apply the same rules — extracting them here
 * avoids drift between the two entry points and lets the `.mjs`
 * template generator assume the value is safe to interpolate verbatim.
 */

/**
 * Characters that must not appear in `sharedFtl`.
 *
 * A POLICY rule about what a sensible FTL path looks like, not the safety
 * boundary for the generated `.mjs`: the scaffold escapes the value at its
 * sink with `JSON.stringify` (`commands/furnace/create-templates.ts`), which
 * is what actually makes interpolation safe and what covers the two inputs
 * this rule never catches — a `"` and a raw newline.
 *
 * Kept because each remains a real sign of a malformed path:
 *  - `\` is a path-escape we do not want to interpret.
 *  - Backticks and `${` are inert in the current double-quoted sink, but a
 *    template-literal sink is one refactor away and they are not valid in a
 *    chrome:// FTL path regardless.
 */
const UNSAFE_CHARS = /[`\\]|\$\{/;

/**
 * Outcome of {@link validateSharedFtl}. `ok: true` carries the trimmed
 * (operator-safe) value; `ok: false` carries a human-readable message
 * suitable for throwing as a `FurnaceError` or `InvalidArgumentError`.
 */
export type SharedFtlValidation = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Validates a candidate `sharedFtl` value. Returns the trimmed value
 * when well-formed, or a structured reason when not. Callers throw the
 * error type appropriate to their context (CLI vs config parser).
 */
export function validateSharedFtl(
  raw: unknown,
  context: { localized: boolean }
): SharedFtlValidation {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'must be a string when set' };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, reason: 'must not be empty' };
  }
  if (UNSAFE_CHARS.test(value)) {
    return {
      ok: false,
      reason: 'must not contain backticks, backslashes, or ${ (would break the generated .mjs)',
    };
  }
  if (!context.localized) {
    return { ok: false, reason: 'requires localized to be true' };
  }
  return { ok: true, value };
}
