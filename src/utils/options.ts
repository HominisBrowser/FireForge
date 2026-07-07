// SPDX-License-Identifier: EUPL-1.2
/**
 * Filters an object to only include keys whose values are not undefined.
 * Designed for use with exactOptionalPropertyTypes — the result can be
 * spread into typed option objects without assigning undefined to optional properties.
 */
export function pickDefined<T extends Record<string, unknown>>(
  obj: T
): { [K in keyof T]+?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result as { [K in keyof T]+?: Exclude<T[K], undefined> };
}

import { InvalidArgumentError as CommanderInvalidArgumentError } from 'commander';

/**
 * Wraps an option-argument parser so its failures surface through
 * commander's own invalid-argument channel.
 *
 * Commander only treats errors whose `code` is `'commander.invalidArgument'`
 * as argument-validation failures; anything else re-throws out of
 * `parseAsync`, BYPASSING `withErrorHandling` entirely and landing in the
 * bin's `main().catch` as an unformatted `Fatal error: …` dump with exit 1.
 * That was the observed behavior for `run --smoke-exit abc` (plain Error),
 * `test --harness-retries 99` (GeneralError), and `export --order 0`
 * (FireForge InvalidArgumentError, whose `code` is a numeric ExitCode).
 * Every `.argParser()`/option-parser callback must be wrapped with this
 * helper (or throw commander's InvalidArgumentError directly).
 */
export function commanderArgParser<T>(parse: (raw: string) => T): (raw: string) => T {
  return (raw: string): T => {
    try {
      return parse(raw);
    } catch (error: unknown) {
      throw new CommanderInvalidArgumentError(
        error instanceof Error ? error.message : String(error)
      );
    }
  };
}
