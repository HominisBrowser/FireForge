// SPDX-License-Identifier: EUPL-1.2
/**
 * Filters an object to only include keys whose values are not undefined.
 * Designed for use with exactOptionalPropertyTypes — the result can be
 * spread into typed option objects without assigning undefined to optional
 * properties.
 *
 * Constrained to `object`, not `Record<string, unknown>`: a named interface
 * has no index signature, so the narrower constraint rejects exactly the
 * annotations this helper is most useful with. Nothing in the body needs the
 * index signature — the key walk goes through `Object.keys`.
 *
 * @param obj - Object to filter
 * @returns The same object with every `undefined`-valued key removed
 */
export function pickDefined<T extends object>(
  obj: T
): { [K in keyof T]+?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as { [K in keyof T]+?: Exclude<T[K], undefined> };
}

import type { Command } from 'commander';
import { InvalidArgumentError as CommanderInvalidArgumentError } from 'commander';

import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { toError } from './errors.js';

/**
 * Wraps an option-argument parser so its failures surface through
 * commander's own invalid-argument channel.
 *
 * Commander only treats errors whose `code` is `'commander.invalidArgument'`
 * as argument-validation failures; anything else re-throws out of
 * `parseAsync`, BYPASSING `withErrorHandling` entirely and landing in the
 * bin's `main().catch` as an unformatted `Fatal error: …` dump with exit 1.
 * That covers a plain Error, a `GeneralError`, and even a FireForge
 * `InvalidArgumentError`, whose `code` is a numeric ExitCode. Every
 * `.argParser()`/option-parser callback must be wrapped with this helper (or
 * throw commander's InvalidArgumentError directly).
 */
export function commanderArgParser<T>(parse: (raw: string) => T): (raw: string) => T {
  return (raw: string): T => {
    try {
      return parse(raw);
    } catch (error: unknown) {
      throw new CommanderInvalidArgumentError(toError(error).message);
    }
  };
}

/**
 * Commander plumbing for a repeatable string option, as a spreadable
 * `[accumulator, default]` pair:
 *
 * ```ts
 * .option('--mach-arg <arg>', 'Repeatable.', ...stringListOption())
 * ```
 *
 * Commander types the default slot as `unknown`, so every open-coded copy
 * carries an `[] as string[]` cast, and it is easy to mutate the accumulator
 * in place instead of returning a new array. Returning a fresh array per
 * call also means the default cannot be shared between two `.option()`
 * registrations.
 */
export function stringListOption(): [(value: string, previous: string[]) => string[], string[]] {
  return [(value: string, previous: string[]): string[] => [...previous, value], []];
}

/** Wait budget applied when `--wait-lock` is passed without a value. */
const DEFAULT_WAIT_LOCK_SECONDS = 60;

/** Environment variable naming a standing wait budget for the whole session. */
export const WAIT_LOCK_ENV_VAR = 'FIREFORGE_WAIT_LOCK';

/** Bounds shared by the flag and the environment variable. */
const MIN_WAIT_LOCK_SECONDS = 1;
const MAX_WAIT_LOCK_SECONDS = 3600;

/**
 * Parses a wait budget from text, or undefined when it is not an integer in
 * range. Shared by the flag and {@link WAIT_LOCK_ENV_VAR} so the two cannot
 * drift on what they accept.
 */
function parseWaitLockSeconds(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_WAIT_LOCK_SECONDS || n > MAX_WAIT_LOCK_SECONDS) {
    return undefined;
  }
  return n;
}

/**
 * The standing wait budget from {@link WAIT_LOCK_ENV_VAR}, or undefined when
 * it is unset or empty.
 *
 * Exists because a wait budget is a property of the SESSION, not of the
 * invocation: a checkout worked by several concurrent agent sessions has a
 * held lock as its normal state, and an unattended loop would otherwise have
 * to thread `--wait-lock` through every command it issues — the one place
 * it is easiest to forget, and the failure only shows up once the loop has
 * already produced a tail of refusals.
 *
 * An unusable value is a usage error rather than a silent fall-back to
 * fail-fast: the operator set it precisely because they did not want to
 * discover the budget at refusal time.
 */
function waitLockSecondsFromEnv(): number | undefined {
  const raw = process.env[WAIT_LOCK_ENV_VAR]?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const parsed = parseWaitLockSeconds(raw);
  if (parsed === undefined) {
    throw new InvalidArgumentError(
      `${WAIT_LOCK_ENV_VAR} must be an integer in ${String(MIN_WAIT_LOCK_SECONDS)}..${String(MAX_WAIT_LOCK_SECONDS)} (got "${raw}")`,
      WAIT_LOCK_ENV_VAR
    );
  }
  return parsed;
}

/**
 * Resolves the parsed `--wait-lock [seconds]` option value into a wait budget
 * in seconds for `withEngineSessionLock`:
 * - absent (`undefined`) → {@link WAIT_LOCK_ENV_VAR} if set, else `undefined`
 *   (the ~1 s fail-fast),
 * - bare flag (`true`) → {@link DEFAULT_WAIT_LOCK_SECONDS},
 * - explicit value → integer validated into 1..3600.
 *
 * The flag always wins over the environment: the environment expresses a
 * default for a session, and an invocation that names a budget has said
 * something more specific than the session did.
 *
 * Accepts the raw string too, so it doubles as the option's arg parser (wrap
 * with {@link commanderArgParser} so failures surface through commander's
 * invalid-argument channel). In that role the value is never `undefined`, so
 * the environment fallback cannot leak into flag PARSING — only into flag
 * ABSENCE, which is where it belongs.
 */
export function resolveWaitLockSeconds(
  value: string | number | boolean | undefined
): number | undefined {
  if (value === undefined || value === false) {
    return waitLockSecondsFromEnv();
  }
  if (value === true) {
    return DEFAULT_WAIT_LOCK_SECONDS;
  }
  if (typeof value === 'number') {
    return value;
  }
  const parsed = parseWaitLockSeconds(value);
  if (parsed === undefined) {
    throw new GeneralError(
      `--wait-lock must be an integer in ${String(MIN_WAIT_LOCK_SECONDS)}..${String(MAX_WAIT_LOCK_SECONDS)} (got "${value}")`
    );
  }
  return parsed;
}

/**
 * Registers `--wait-lock [seconds]` on a command that takes NO lock, so a
 * scripted sequence can blanket-append the flag without hitting a usage
 * error — a command that rejects it with "unknown option" kills the whole
 * sequence with a usage error instead of a lock message.
 *
 * The flag is accepted and ignored here — never silently repurposed — and
 * the help text says so, so nobody reads its presence as evidence that this
 * command waits for anything.
 *
 * The value is parsed and validated exactly as the honoring variant does:
 * `--wait-lock nonsense` must still be a usage error everywhere, or the
 * uniformity would be a lie.
 */
function addAcceptedWaitLockOption(command: Command): Command {
  return command.option(
    '--wait-lock [seconds]',
    'Accepted for scripting uniformity and ignored: this command takes no FireForge lock',
    commanderArgParser((raw: string) => resolveWaitLockSeconds(raw))
  );
}

/**
 * True when `command` already declares `--wait-lock` itself. Used by the
 * CLI wiring to add the accept-and-ignore variant only where the honoring
 * one is absent.
 */
export function hasWaitLockOption(command: Command): boolean {
  return command.options.some((option) => option.long === '--wait-lock');
}

/**
 * Recursively gives every command in the tree a `--wait-lock` flag: the
 * honoring registration where one already exists, the accept-and-ignore
 * one everywhere else.
 */
export function ensureWaitLockOptionEverywhere(command: Command): void {
  for (const sub of command.commands) {
    if (!hasWaitLockOption(sub)) addAcceptedWaitLockOption(sub);
    ensureWaitLockOptionEverywhere(sub);
  }
}

/**
 * Registers the shared `--wait-lock [seconds]` flag on a lock-taking
 * command (the engine session lock for engine-mutating commands, the patch
 * directory lock for queue-mutating ones). The parsed option value is `true`
 * for the bare flag or a validated integer; feed it through
 * {@link resolveWaitLockSeconds} at the call site to obtain the
 * `waitLockSeconds` for `withEngineSessionLock`/`withPatchDirectoryLock`.
 */
export function addWaitLockOption(command: Command): Command {
  return command.option(
    '--wait-lock [seconds]',
    `Wait up to this many seconds (default 60) for another FireForge command to release the contended lock, instead of failing on the default budget. Set ${WAIT_LOCK_ENV_VAR} to apply a budget to every command in a session`,
    commanderArgParser((raw: string) => resolveWaitLockSeconds(raw))
  );
}
