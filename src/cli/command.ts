// SPDX-License-Identifier: EUPL-1.2
/**
 * Declaring a command. One `defineCommand` call is the whole description of a
 * command: its name and help, its arguments and options, which combinations
 * are valid, and `run`. The types `run` receives are inferred from the
 * declarations, so no flag is ever described twice.
 *
 *     export const build = defineCommand({
 *       name: 'build',
 *       summary: 'Build the browser',
 *       args: { paths: arg.list('Directories to rebuild') },
 *       options: {
 *         ui: opt.flag('Rebuild front-end files only'),
 *         jobs: opt.integer('Parallel compile jobs', { short: 'j', min: 1 }),
 *         ...lockOptions,
 *       },
 *       constraints: { exclusive: [['ui', 'paths']] },
 *       run: async (ctx, args, opts) => { ... },  // opts.jobs: number | undefined
 *     });
 *
 * An option's flag is its key in kebab case: `waitLock` is `--wait-lock`.
 */
import { resolve } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { COMMAND_WAIT_MS } from '../kernel/lock.js';
import type { CommandContext } from './context.js';

/**
 * A refusal of the command line itself: exit code 8, code `invalid-argument`.
 *
 * @param message - What is wrong with the invocation
 * @param hint - What to pass instead
 */
export function usageError(message: string, hint?: string): FireForgeError {
  return new FireForgeError('invalid-argument', message, {
    exitCode: ExitCode.INVALID_ARGUMENT,
    ...(hint === undefined ? {} : { hint }),
  });
}

/** What the parser hands a declaration: nothing, a flag, one value, or repeated values. */
type Raw = string | boolean | readonly string[] | undefined;

/** One declared option. `T` is the type `run` receives. */
export interface OptionSpec<T> {
  readonly description: string;
  readonly kind: 'flag' | 'value' | 'list';
  readonly short?: string | undefined;
  /** Placeholder in help: `--jobs <n>`. */
  readonly valueName: string;
  /** Also declare `--no-<flag>`. */
  readonly negatable: boolean;
  /** Environment variable that supplies the value when the flag is absent. */
  readonly env?: string | undefined;
  readonly hidden: boolean;
  /** Suffix for help, such as the default or the accepted values. */
  readonly note?: string | undefined;
  /** Turns the raw command-line value into the typed one, or throws a usage error. */
  convert(raw: Raw, flag: string, cwd: string): T;
}

/** One declared positional argument. `T` is the type `run` receives. */
export interface ArgSpec<T> {
  readonly description: string;
  readonly required: boolean;
  readonly variadic: boolean;
  convert(raw: Raw, name: string, cwd: string): T;
}

interface Common {
  /** One-letter alias: `j` for `-j`. `v` and `V` are taken by the program. */
  short?: string;
  /** Environment variable that supplies the value when the flag is absent. */
  env?: string;
  /** Leave the option out of help. */
  hidden?: boolean;
}

interface ValueConfig<T> extends Common {
  /** Placeholder in help. */
  valueName?: string;
  /** Value when the option is not given. */
  default?: T;
  /** Refuse an invocation without the option. */
  required?: boolean;
}

/** `T` when the declaration guarantees a value, otherwise `T | undefined`. */
type Given<T, C> = C extends { default: T } | { required: true } ? T : T | undefined;

function single(raw: Raw): string | undefined {
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw as string[]).at(-1) : undefined;
}

function valueOption<T, C extends ValueConfig<T>>(
  description: string,
  config: C | undefined,
  defaults: { valueName: string; note?: string },
  parse: (text: string, flag: string, cwd: string) => T
): OptionSpec<Given<T, C>> {
  const notes = [
    defaults.note,
    config?.default === undefined ? undefined : `default ${String(config.default)}`,
  ];
  return {
    description,
    kind: 'value',
    short: config?.short,
    valueName: config?.valueName ?? defaults.valueName,
    negatable: false,
    env: config?.env,
    hidden: config?.hidden ?? false,
    note: notes.filter((note) => note !== undefined).join('; ') || undefined,
    convert(raw, flag, cwd) {
      const text = single(raw);
      if (text !== undefined) return parse(text, flag, cwd);
      if (config?.required === true) throw usageError(`${flag} is required`);
      return config?.default as Given<T, C>;
    },
  };
}

function parseNumber(
  noun: string,
  accepts: (value: number) => boolean,
  bounds: { min?: number; max?: number }
): (text: string, flag: string) => number {
  const range =
    bounds.min !== undefined && bounds.max !== undefined
      ? ` between ${bounds.min} and ${bounds.max}`
      : bounds.min !== undefined
        ? ` of at least ${bounds.min}`
        : bounds.max !== undefined
          ? ` of at most ${bounds.max}`
          : '';
  return (text, flag) => {
    const value = text.trim() === '' ? NaN : Number(text);
    const inRange = value >= (bounds.min ?? -Infinity) && value <= (bounds.max ?? Infinity);
    if (!accepts(value) || !inRange) {
      throw usageError(`${flag} must be ${noun}${range} (got "${text}")`);
    }
    return value;
  };
}

function parseChoice<V extends string>(values: readonly V[]): (text: string, flag: string) => V {
  return (text, flag) => {
    const match = values.find((value) => value === text);
    if (match === undefined) {
      throw usageError(`${flag} must be one of: ${values.join(', ')} (got "${text}")`);
    }
    return match;
  };
}

/** Option declarations. */
export const opt = {
  /**
   * A switch: present or absent. With `negatable`, `--no-<flag>` turns a
   * default-on switch off, and help says the switch is on by default.
   */
  flag(
    description: string,
    config: Common & { negatable?: boolean; default?: boolean } = {}
  ): OptionSpec<boolean> {
    return {
      description,
      kind: 'flag',
      short: config.short,
      valueName: '',
      negatable: config.negatable ?? false,
      env: config.env,
      hidden: config.hidden ?? false,
      note: config.default === true ? 'on by default' : undefined,
      convert: (raw) => (typeof raw === 'boolean' ? raw : (config.default ?? false)),
    };
  },
  /** Free text. */
  string<const C extends ValueConfig<string>>(description: string, config?: C) {
    return valueOption<string, C>(description, config, { valueName: 'value' }, (text) => text);
  },
  /** A whole number within optional bounds. */
  integer<const C extends ValueConfig<number> & { min?: number; max?: number }>(
    description: string,
    config?: C
  ) {
    const parse = parseNumber('an integer', Number.isSafeInteger, config ?? {});
    return valueOption<number, C>(description, config, { valueName: 'n' }, parse);
  },
  /** A number within optional bounds. */
  number<const C extends ValueConfig<number> & { min?: number; max?: number }>(
    description: string,
    config?: C
  ) {
    const parse = parseNumber('a number', Number.isFinite, config ?? {});
    return valueOption<number, C>(description, config, { valueName: 'n' }, parse);
  },
  /** One of a fixed set of words. */
  enum<const V extends readonly [string, ...string[]], const C extends ValueConfig<V[number]>>(
    values: V,
    description: string,
    config?: C
  ) {
    const defaults = { valueName: 'choice', note: `one of: ${values.join(', ')}` };
    return valueOption<V[number], C>(description, config, defaults, parseChoice(values));
  },
  /** A filesystem path, resolved against the working directory to an absolute path. */
  path<const C extends ValueConfig<string>>(description: string, config?: C) {
    return valueOption<string, C>(description, config, { valueName: 'path' }, (text, _flag, cwd) =>
      resolve(cwd, text)
    );
  },
  /** A repeatable option: `--only a --only b` gives `['a', 'b']`. Absent gives `[]`. */
  list(description: string, config: Common & { valueName?: string } = {}): OptionSpec<string[]> {
    return {
      description,
      kind: 'list',
      short: config.short,
      valueName: config.valueName ?? 'value',
      negatable: false,
      env: config.env,
      hidden: config.hidden ?? false,
      convert: (raw) =>
        Array.isArray(raw) ? [...(raw as string[])] : typeof raw === 'string' ? [raw] : [],
    };
  },
};

type Presence<T, C> = C extends { optional: true } ? T | undefined : T;

function positional<T, C extends { optional?: boolean }>(
  description: string,
  config: C | undefined,
  parse: (text: string, name: string, cwd: string) => T
): ArgSpec<Presence<T, C>> {
  return {
    description,
    required: config?.optional !== true,
    variadic: false,
    convert(raw, name, cwd) {
      const text = single(raw);
      return (text === undefined ? undefined : parse(text, name, cwd)) as Presence<T, C>;
    },
  };
}

/** Positional argument declarations, in the order the keys are written. */
export const arg = {
  /** Free text. Required unless `optional`. */
  string<const C extends { optional?: boolean }>(description: string, config?: C) {
    return positional<string, C>(description, config, (text) => text);
  },
  /** One of a fixed set of words. */
  enum<const V extends readonly [string, ...string[]], const C extends { optional?: boolean }>(
    values: V,
    description: string,
    config?: C
  ) {
    return positional<V[number], C>(description, config, parseChoice(values));
  },
  /** A filesystem path, resolved against the working directory to an absolute path. */
  path<const C extends { optional?: boolean }>(description: string, config?: C) {
    return positional<string, C>(description, config, (text, _name, cwd) => resolve(cwd, text));
  },
  /** Every remaining argument, including whatever follows `--`. Must be declared last. */
  list(description: string, config: { required?: boolean } = {}): ArgSpec<string[]> {
    return {
      description,
      required: config.required ?? false,
      variadic: true,
      convert: (raw) => (Array.isArray(raw) ? [...(raw as string[])] : []),
    };
  },
};

type OptionSpecs = Readonly<Record<string, OptionSpec<unknown>>>;
type ArgSpecs = Readonly<Record<string, ArgSpec<unknown>>>;
type Values<S extends Readonly<Record<string, { convert(...args: never[]): unknown }>>> = {
  -readonly [K in keyof S]: ReturnType<S[K]['convert']>;
};

/**
 * Which combinations of arguments and options are valid. Keys name options or
 * arguments. A key counts as given when it appeared on the command line (or
 * came from its environment variable), not when it merely has a default.
 */
export interface Constraints<K extends string> {
  /** At most one key of each group may be given. */
  exclusive?: readonly (readonly K[])[];
  /** Exactly one key of each group must be given: "takes either X or Y". */
  oneOf?: readonly (readonly K[])[];
  /** Giving the key requires every key listed for it. */
  requires?: Readonly<Partial<Record<K, readonly K[]>>>;
}

/** The declaration {@link defineCommand} takes. */
export interface CommandSpec<A extends ArgSpecs, O extends OptionSpecs> {
  /** The word typed after `fireforge` (or after the parent command). */
  name: string;
  /** One line for command lists. */
  summary: string;
  /** Longer help shown by `<command> --help`. */
  description?: string;
  /** Heading the command is listed under in the root help. */
  group?: string;
  args?: A;
  options?: O;
  constraints?: Constraints<Extract<keyof A | keyof O, string>>;
  /** The command accepts `--json` and writes its result with `ctx.out.json`. */
  json?: boolean;
  /** The command's stdout ends with a verdict line written by `ctx.out.verdict`. */
  verdict?: boolean;
  /** Leave the command out of help. */
  hidden?: boolean;
  /** Nested commands. A command with subcommands and no `run` prints its help. */
  subcommands?: readonly Command[];
  /** Does the work, by calling one feature function. Returns nothing or throws. */
  run?: (ctx: CommandContext, args: Values<A>, opts: Values<O>) => Promise<void> | void;
}

/** The converted values of one invocation, keyed like the declarations they came from. */
export interface InvocationValues {
  [key: string]: unknown;
}

/** A declared command, as the program consumes it. */
export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly description: string | undefined;
  readonly group: string | undefined;
  readonly args: ArgSpecs;
  readonly options: OptionSpecs;
  readonly constraints: Constraints<string>;
  readonly json: boolean;
  readonly verdict: boolean;
  readonly hidden: boolean;
  readonly subcommands: readonly Command[];
  readonly run:
    | ((ctx: CommandContext, args: InvocationValues, opts: InvocationValues) => Promise<void>)
    | undefined;
}

/**
 * Declares a command.
 *
 * @param spec - See {@link CommandSpec}
 */
export function defineCommand<
  const A extends ArgSpecs = Record<string, never>,
  const O extends OptionSpecs = Record<string, never>,
>(spec: CommandSpec<A, O>): Command {
  const run = spec.run;
  return {
    name: spec.name,
    summary: spec.summary,
    description: spec.description,
    group: spec.group,
    args: spec.args ?? {},
    options: spec.options ?? {},
    constraints: spec.constraints ?? {},
    json: spec.json ?? false,
    verdict: spec.verdict ?? false,
    hidden: spec.hidden ?? false,
    subcommands: spec.subcommands ?? [],
    run:
      run === undefined
        ? undefined
        : async (ctx, args, opts) => {
            await run(ctx, args as Values<A>, opts as Values<O>);
          },
  };
}

/**
 * The flag spelling of an option key: `waitLock` is `--wait-lock`.
 *
 * @param key - The key in the command's `options` or `args`
 */
export function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** What the parser collected for one invocation, before conversion. */
export interface RawInvocation {
  args: Readonly<Record<string, Raw>>;
  options: Readonly<Record<string, Raw>>;
  /** Whether an option was given on the command line or by its environment variable. */
  given(optionKey: string): boolean;
}

/**
 * Converts and validates a parsed invocation: every value through its
 * declaration, then the command's constraints.
 *
 * @param command - The command being run
 * @param raw - What the parser collected
 * @param cwd - Directory that relative paths resolve against
 * @returns The typed `args` and `opts` for `run`
 * @throws A usage error naming the flag or argument at fault
 */
export function resolveInvocation(
  command: Command,
  raw: RawInvocation,
  cwd: string
): { args: InvocationValues; opts: InvocationValues } {
  const args: InvocationValues = {};
  const opts: InvocationValues = {};
  const display = new Map<string, string>();
  const given = new Set<string>();
  for (const [key, spec] of Object.entries(command.args)) {
    const name = `<${kebabCase(key)}>`;
    display.set(key, name);
    const value = spec.convert(raw.args[key], name, cwd);
    args[key] = value;
    if (Array.isArray(value) ? value.length > 0 : value !== undefined) given.add(key);
    else if (spec.required) throw usageError(`${name} is required`);
  }
  for (const [key, spec] of Object.entries(command.options)) {
    const flag = `--${kebabCase(key)}`;
    display.set(key, flag);
    opts[key] = spec.convert(raw.options[key], flag, cwd);
    if (raw.given(key)) given.add(key);
  }
  const shown = (keys: readonly string[]): string =>
    keys.map((key) => display.get(key) ?? key).join(', ');
  for (const group of command.constraints.exclusive ?? []) {
    const present = group.filter((key) => given.has(key));
    if (present.length > 1) throw usageError(`${shown(present)} cannot be used together`);
  }
  for (const group of command.constraints.oneOf ?? []) {
    const present = group.filter((key) => given.has(key));
    if (present.length === 0) throw usageError(`One of ${shown(group)} is required`);
    if (present.length > 1) throw usageError(`${shown(present)} cannot be used together`);
  }
  for (const [key, needed] of Object.entries(command.constraints.requires ?? {})) {
    const missing = (needed ?? []).filter((other) => !given.has(other));
    if (given.has(key) && missing.length > 0) {
      throw usageError(`${shown([key])} requires ${shown(missing)}`);
    }
  }
  return { args, opts };
}

/** Options for a command that takes a lock another FireForge command may hold. */
export const lockOptions = {
  waitLock: opt.integer(
    `Wait up to this many seconds for what another FireForge command holds, with a progress ` +
      `line each minute naming the holder; 0 does not wait (default: ${COMMAND_WAIT_MS / 1000})`,
    { valueName: 'seconds', min: 0, max: 86_400, env: 'FIREFORGE_WAIT_LOCK' }
  ),
};

/**
 * `--wait-lock` as the milliseconds the lock functions take.
 *
 * @param seconds - The option's value
 * @returns The wait; {@link COMMAND_WAIT_MS} when the option was not given
 */
export function lockWaitMs(seconds: number | undefined): number {
  return seconds === undefined ? COMMAND_WAIT_MS : seconds * 1000;
}

/** Options for a command that asks before a destructive change. */
export const confirmOptions = {
  yes: opt.flag('Proceed without the confirmation prompt', { short: 'y' }),
};
