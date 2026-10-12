// SPDX-License-Identifier: EUPL-1.2
import type { Command } from 'commander';
import { InvalidArgumentError as CommanderInvalidArgumentError } from 'commander';

import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { toError } from './errors.js';

/**
 * Filters an object to only include keys whose values are not undefined.
 * Designed for use with exactOptionalPropertyTypes: the result can be
 * spread into typed option objects without assigning undefined to optional
 * properties.
 *
 * Constrained to `object`, not `Record<string, unknown>`: a named interface
 * has no index signature, so the narrower constraint rejects exactly the
 * annotations this helper is most useful with. Nothing in the body needs the
 * index signature, since the key walk goes through `Object.keys`.
 *
 * @param obj - Object to filter
 * @returns The same object with every `undefined`-valued key removed
 */
export function pickDefined<T extends object>(obj: T): DefinedProps<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as DefinedProps<T>;
}

/** `T` with every property optional and `undefined` removed: what {@link pickDefined} returns. */
export type DefinedProps<T> = { [K in keyof T]+?: Exclude<T[K], undefined> };

/**
 * Wraps an option-argument parser so its failures surface through
 * commander's own invalid-argument channel.
 *
 * Commander only treats errors whose `code` is `'commander.invalidArgument'`
 * as argument-validation failures. Anything else re-throws out of
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
 * Exists because a wait budget is a property of the session, not of the
 * invocation: a checkout worked by several concurrent agent sessions has a
 * held lock as its normal state, and an unattended loop would otherwise have
 * to thread `--wait-lock` through every command it issues. That is the one
 * place it is easiest to forget, and the failure only shows up once the loop
 * has already produced a tail of refusals.
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
      `${WAIT_LOCK_ENV_VAR} must be an integer in ${MIN_WAIT_LOCK_SECONDS}..${MAX_WAIT_LOCK_SECONDS} (got "${raw}")`,
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
 * the environment fallback cannot leak into flag parsing, only into flag
 * absence, which is where it belongs.
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
      `--wait-lock must be an integer in ${MIN_WAIT_LOCK_SECONDS}..${MAX_WAIT_LOCK_SECONDS} (got "${value}")`
    );
  }
  return parsed;
}

/**
 * The session-wide wait budget in milliseconds, or undefined when none is
 * set. Sourced from {@link WAIT_LOCK_ENV_VAR} only.
 *
 * Exists for the secondary locks a command takes after the one its
 * `--wait-lock` flag was threaded to. A furnace mutation takes the engine
 * session lock and then `.fireforge/furnace.lock`. Only the first had a
 * budget, so a contended deploy died on the file lock's fixed 30 s while
 * its operator believed a much larger budget was in force. Every furnace
 * leaf that takes the furnace lock threads its own `--wait-lock` into it;
 * this is the fallback when the flag is absent, and the only budget for
 * callers that do not thread one (doctor's furnace repair, the
 * pre-build apply).
 *
 * Env-only: a flag belongs to one invocation and is passed
 * explicitly where it applies, while the environment is exactly the place a
 * session-wide default is expressed. An explicit budget at a call site
 * always wins over this.
 *
 * @returns The session budget in milliseconds, or undefined
 */
export function sessionWaitLockMs(): number | undefined {
  const seconds = waitLockSecondsFromEnv();
  return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Registers `--wait-lock [seconds]` on a command that takes no lock, so a
 * scripted sequence can blanket-append the flag without hitting a usage
 * error. A command that rejects it with "unknown option" kills the whole
 * sequence with a usage error instead of a lock message.
 *
 * The flag is accepted and ignored here, never silently repurposed, and
 * the help text says so, so nobody reads its presence as evidence that this
 * command waits for anything.
 *
 * The value is parsed and validated exactly as the honoring variant does:
 * `--wait-lock nonsense` must still be a usage error everywhere, or the
 * uniformity would be a lie.
 */
export function addAcceptedWaitLockOption(command: Command): Command {
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
function hasWaitLockOption(command: Command): boolean {
  return command.options.some((option) => option.long === '--wait-lock');
}

/**
 * Recursively gives every leaf command in the tree a `--wait-lock` flag: the
 * honoring registration where one already exists, the accept-and-ignore
 * one everywhere else.
 */
export function ensureWaitLockOptionEverywhere(command: Command): void {
  for (const sub of command.commands) {
    // Commander groups otherwise capture a trailing leaf option before the
    // action can see it. Register the uniform flag only on actionable leaves.
    if (sub.commands.length === 0 && !hasWaitLockOption(sub)) addAcceptedWaitLockOption(sub);
    releasePathShapedOptionalValues(sub);
    ensureWaitLockOptionEverywhere(sub);
  }
}

/**
 * Optional-value flags whose value is a number and therefore never a path.
 * `--canary [path]` is the counter-example that must stay out: its value IS
 * a path.
 */
const NUMERIC_OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--wait-lock',
  '--wait-browser',
  '--wait-port',
  '--shuffle',
]);

/**
 * True for a token that reads as a path rather than a number: it has a
 * path separator or a file extension, or is `.`/`..`. A bare word such as
 * `nonsense` is not path-shaped, so `--wait-lock nonsense` stays the usage
 * error it always was.
 */
export function isPathShapedArgument(token: string): boolean {
  if (/^\d+(?:\.\d+)?$/.test(token)) return false;
  return token === '.' || token === '..' || /[\\/]/.test(token) || /\.[A-Za-z][\w-]*$/.test(token);
}

/**
 * Rewrites a command's option tokens so a path-shaped argument after a
 * numeric optional-value flag is an operand, and the flag takes its
 * default.
 *
 * Commander binds the next non-dash token to an optional value, so
 * `fireforge test --build --wait-lock browser_x.js` failed with
 * "--wait-lock must be an integer in 1..3600 (got "browser_x.js")": the
 * help says the value is optional, and the obvious spelling refused. The
 * released flag moves to the end of the option section (before any `--`),
 * where nothing follows it, so commander reads it bare. Operands keep their
 * relative order. The value of a required-value option (`--mach-arg
 * --wait-lock`) is never mistaken for a flag.
 *
 * @param argv - The tokens commander passes to `parseOptions`
 * @param requiredValueFlags - This command's flags that always take a value
 * @returns The rewritten tokens
 */
export function releasePathShapedValues(
  argv: readonly string[],
  requiredValueFlags: ReadonlySet<string>
): string[] {
  const kept: string[] = [];
  const released: string[] = [];
  let index = 0;
  for (; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    const next = argv[index + 1];
    if (requiredValueFlags.has(token) && next !== undefined) {
      kept.push(token, next);
      index += 1;
      continue;
    }
    if (
      NUMERIC_OPTIONAL_VALUE_FLAGS.has(token) &&
      next !== undefined &&
      !next.startsWith('-') &&
      isPathShapedArgument(next)
    ) {
      released.push(token);
      continue;
    }
    kept.push(token);
  }
  return [...kept, ...released, ...argv.slice(index)];
}

/**
 * Installs {@link releasePathShapedValues} on `command` when it registers
 * any numeric optional-value flag.
 */
function releasePathShapedOptionalValues(command: Command): void {
  const flags = command.options.filter(
    (option) => option.long !== undefined && NUMERIC_OPTIONAL_VALUE_FLAGS.has(option.long)
  );
  if (flags.length === 0) return;
  const requiredValueFlags = new Set(
    command.options
      .filter((option) => option.required)
      .flatMap((option) => [option.long, option.short])
      .filter((flag): flag is string => flag !== undefined)
  );
  const parseOptions = command.parseOptions.bind(command);
  command.parseOptions = (argv: string[]) =>
    parseOptions(releasePathShapedValues(argv, requiredValueFlags));
}

/**
 * Registers the shared `--wait-lock [seconds]` flag on a lock-taking
 * command (the engine session lock for engine-mutating commands, the patch
 * directory lock for queue-mutating ones). The parsed option value is `true`
 * for the bare flag or a validated integer. Feed it through
 * {@link resolveWaitLockSeconds} at the call site to obtain the
 * `waitLockSeconds` for `withEngineSessionLock`/`withPatchDirectoryLock`.
 *
 * A command can take more than one lock (a furnace mutation takes the
 * engine session lock and then `.fireforge/furnace.lock`) and the budget
 * has to reach all of them or the flag is a half-truth. The secondary locks
 * read the session budget through {@link sessionWaitLockMs} rather than
 * having it threaded to every call site.
 */
export function addWaitLockOption(command: Command): Command {
  return command.option(
    '--wait-lock [seconds]',
    `Wait up to this many seconds (default 60) for another FireForge command to release EVERY lock this command takes, instead of failing on the default budget. Set ${WAIT_LOCK_ENV_VAR} to apply a budget to every command in a session`,
    commanderArgParser((raw: string) => resolveWaitLockSeconds(raw))
  );
}
