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

import type { Command } from 'commander';
import { InvalidArgumentError as CommanderInvalidArgumentError } from 'commander';

import { GeneralError } from '../errors/base.js';

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

/** Wait budget applied when `--wait-lock` is passed without a value. */
const DEFAULT_WAIT_LOCK_SECONDS = 60;

/**
 * Resolves the parsed `--wait-lock [seconds]` option value into a wait budget
 * in seconds for `withEngineSessionLock`:
 * - absent (`undefined`) → `undefined` (legacy ~1 s fail-fast),
 * - bare flag (`true`) → {@link DEFAULT_WAIT_LOCK_SECONDS},
 * - explicit value → integer validated into 1..3600.
 *
 * Accepts the raw string too, so it doubles as the option's arg parser (wrap
 * with {@link commanderArgParser} so failures surface through commander's
 * invalid-argument channel).
 */
export function resolveWaitLockSeconds(
  value: string | number | boolean | undefined
): number | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (value === true) {
    return DEFAULT_WAIT_LOCK_SECONDS;
  }
  if (typeof value === 'number') {
    return value;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 3600) {
    throw new GeneralError(`--wait-lock must be an integer in 1..3600 (got "${value}")`);
  }
  return n;
}

/**
 * Registers the shared `--wait-lock [seconds]` flag on an engine-mutating
 * command. The parsed option value is `true` for the bare flag or a validated
 * integer; feed it through {@link resolveWaitLockSeconds} at the call site to
 * obtain the `waitLockSeconds` for `withEngineSessionLock`.
 */
export function addWaitLockOption(command: Command): Command {
  return command.option(
    '--wait-lock [seconds]',
    'Wait up to this many seconds (default 60) for another FireForge engine-mutating command to release the engine lock, instead of failing immediately',
    commanderArgParser((raw: string) => resolveWaitLockSeconds(raw))
  );
}
