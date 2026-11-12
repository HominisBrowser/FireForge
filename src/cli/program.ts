// SPDX-License-Identifier: EUPL-1.2
/**
 * Turns command declarations into a running program: parsing, help, the
 * global flags, and the one place a thrown error becomes output and an exit
 * code. Nothing here ends the process; {@link runProgram} returns the code.
 */
import { Argument, Command as Commander, CommanderError, Option } from 'commander';

import { CancelledError, ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import * as log from '../kernel/log.js';
import {
  type Command,
  kebabCase,
  type RawInvocation,
  resolveInvocation,
  usageError,
} from './command.js';
import type { CommandContext } from './context.js';
import { Output } from './output.js';

/** What the program is. */
export interface ProgramSpec {
  name: string;
  description: string;
  /** The string `--version` prints. */
  version: () => string | Promise<string>;
  /** Top-level commands, in help order. */
  commands: readonly Command[];
  /** Where to send bug reports, shown with an internal error. */
  issuesUrl?: () => Promise<string | undefined>;
}

/** The world one invocation runs in. Injected, so a test can run the program in-process. */
export interface ProgramIo {
  /** Arguments after the program name. */
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Receives stdout text. */
  stdout: (text: string) => void;
  /** Receives stderr text. Unset means the process's own stderr, with live progress indicators. */
  stderr?: (text: string) => void;
  interactive: boolean;
}

interface Invocation {
  command: Command;
  run: NonNullable<Command['run']>;
  raw: RawInvocation;
  /** `--json` was given to a command that offers it. */
  json: boolean;
  /** `--verbose` was given, before or after the command name. */
  verbose: boolean;
}

/** The tokens before `--`: everything after it belongs to the program being run. */
function ownTokens(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
}

function optionFlags(key: string, spec: Command['options'][string]): string {
  const long = `--${kebabCase(key)}`;
  const short = spec.short === undefined ? '' : `-${spec.short}, `;
  return spec.kind === 'flag' ? `${short}${long}` : `${short}${long} <${spec.valueName}>`;
}

/** Reads an option's value from its environment variable, in the form the parser would give it. */
function fromEnvironment(
  spec: Command['options'][string],
  io: ProgramIo
): string | boolean | undefined {
  const value = spec.env === undefined ? undefined : io.env[spec.env]?.trim();
  if (value === undefined || value === '') return undefined;
  return spec.kind === 'flag' ? !['0', 'false', 'no'].includes(value.toLowerCase()) : value;
}

function declare(
  parent: Commander,
  command: Command,
  io: ProgramIo,
  onInvoke: (invocation: Invocation) => void
): void {
  const node = parent.command(command.name, { hidden: command.hidden }).summary(command.summary);
  node.description(command.description ?? command.summary);
  if (command.group !== undefined) node.helpGroup(`${command.group}:`);
  for (const [key, spec] of Object.entries(command.args)) {
    const name = `${kebabCase(key)}${spec.variadic ? '...' : ''}`;
    // Every argument is optional to the parser: the declaration decides what
    // is required, so the refusal is worded the same as every other one.
    node.addArgument(new Argument(`[${name}]`, spec.description));
  }
  for (const [key, spec] of Object.entries(command.options)) {
    const notes = [spec.note, spec.env === undefined ? undefined : `env: ${spec.env}`]
      .filter((note) => note !== undefined)
      .join('; ');
    const option = new Option(
      optionFlags(key, spec),
      notes === '' ? spec.description : `${spec.description} (${notes})`
    );
    if (spec.kind === 'list') {
      option.argParser((value: string, previous: unknown) => [
        ...(Array.isArray(previous) ? (previous as string[]) : []),
        value,
      ]);
    }
    if (spec.hidden) option.hideHelp();
    node.addOption(option);
    if (spec.negatable) {
      node.addOption(new Option(`--no-${kebabCase(key)}`, `Turn off --${kebabCase(key)}`));
    }
  }
  for (const child of command.subcommands) declare(node, child, io, onInvoke);
  const run = command.run;
  if (run === undefined) {
    // A command group run without a subcommand answers with its help.
    node.action(() => {
      node.outputHelp();
    });
    return;
  }
  if (command.json) node.option('--json', 'Write the result as one JSON document on stdout');
  node.option('-v, --verbose', 'Show debug output');
  node.action((...received: unknown[]) => {
    const parsed = node.opts<Record<string, string | boolean | string[] | undefined>>();
    const options: Record<string, string | boolean | readonly string[] | undefined> = {};
    const given = new Set<string>();
    for (const [key, spec] of Object.entries(command.options)) {
      const value =
        node.getOptionValueSource(key) === 'cli' ? parsed[key] : fromEnvironment(spec, io);
      if (value === undefined) continue;
      options[key] = value;
      given.add(key);
    }
    onInvoke({
      command,
      run,
      json: parsed['json'] === true,
      verbose: node.optsWithGlobals<{ verbose?: boolean }>().verbose === true,
      raw: {
        args: Object.fromEntries(
          Object.keys(command.args).map((key, index) => [
            key,
            received[index] as string | string[] | undefined,
          ])
        ),
        options,
        given: (key) => given.has(key),
      },
    });
  });
}

function build(
  spec: ProgramSpec,
  io: ProgramIo,
  onInvoke: (invocation: Invocation) => void
): Commander {
  const stderr = io.stderr ?? ((text: string): boolean => process.stderr.write(text));
  const program = new Commander(spec.name)
    .description(spec.description)
    // Without this the parser ends the process itself, with its own exit code.
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: stderr,
      // The parser's own refusals take the form every other failure has.
      outputError: (text, write) => {
        write(text.replace(/^error: /, `error[${usageError('').code}]: `));
      },
    })
    // Root options are read only before the command name, so a command may
    // declare a `--version` of its own.
    .enablePositionalOptions()
    .showSuggestionAfterError()
    .option('-v, --verbose', 'Show debug output')
    .option('-V, --version', 'Print the version');
  for (const command of spec.commands) declare(program, command, io, onInvoke);
  return program;
}

async function reportError(
  error: unknown,
  spec: ProgramSpec
): Promise<{ code: string; message: string; exitCode: number; hint?: string }> {
  if (error instanceof CancelledError) {
    log.info(error.message);
    return { code: error.code, message: error.message, exitCode: error.exitCode };
  }
  if (!(error instanceof FireForgeError)) {
    const unexpected = toError(error);
    log.failure('unexpected-error', `Unexpected error: ${unexpected.message}`);
    if (unexpected.stack !== undefined) log.info(unexpected.stack);
    return {
      code: 'unexpected-error',
      message: unexpected.message,
      exitCode: ExitCode.GENERAL_ERROR,
    };
  }
  if (error.exitCode === ExitCode.INTERNAL_ERROR) {
    const issues = await spec.issuesUrl?.().catch(() => undefined);
    log.failure(
      error.code,
      `Internal error: ${error.message}\n` +
        'This is a bug in FireForge, not a problem with your project. It stopped at the first ' +
        'inconsistency instead of continuing to write.' +
        (issues === undefined ? '' : `\nPlease report it, with this output, at ${issues}`)
    );
    if (error.stack !== undefined) log.info(error.stack);
  } else {
    log.failure(error.code, error.message, error.hint);
  }
  // The underlying git output, errno or parse failure, for whoever asks.
  let cause: unknown = error.cause;
  for (
    let depth = 0;
    log.isVerbose() && cause !== undefined && cause !== null && depth < 8;
    depth++
  ) {
    const inner = toError(cause);
    log.verbose(`Caused by: ${inner.stack ?? inner.message}`);
    cause = inner.cause;
  }
  return {
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

async function execute(
  invocation: Invocation,
  spec: ProgramSpec,
  io: ProgramIo,
  out: Output
): Promise<number> {
  const { command, run, raw } = invocation;
  try {
    const { args, opts } = resolveInvocation(command, raw, io.cwd);
    const context: CommandContext = { cwd: io.cwd, env: io.env, out, interactive: io.interactive };
    if (command.verdict) out.expectVerdict();
    await run(context, args, opts);
    return ExitCode.SUCCESS;
  } catch (error: unknown) {
    const failure = await reportError(error, spec);
    out.fail(failure);
    return failure.exitCode;
  } finally {
    out.close();
  }
}

/**
 * Runs one invocation of the program.
 *
 * @param spec - The program: its name, version and commands
 * @param io - Arguments, working directory, environment and output sinks
 * @returns The exit code. The caller ends the process
 */
export async function runProgram(spec: ProgramSpec, io: ProgramIo): Promise<number> {
  const own = ownTokens(io.argv);
  const logConfig = io.stderr === undefined ? {} : { write: io.stderr };
  const previousLog = log.configureLog(logConfig);
  try {
    const hasCommand = own.some((token) => !token.startsWith('-'));
    if (!hasCommand && (own.includes('--version') || own.includes('-V'))) {
      io.stdout(`${await spec.version()}\n`);
      return ExitCode.SUCCESS;
    }
    let invocation: Invocation | undefined;
    const program = build(spec, io, (next) => {
      invocation = next;
    });
    try {
      await program.parseAsync([...io.argv], { from: 'user' });
    } catch (error: unknown) {
      if (!(error instanceof CommanderError)) throw error;
      // Help, and a command group run without a subcommand, are answers, not errors.
      if (error.exitCode === 0 || error.code === 'commander.help') return ExitCode.SUCCESS;
      // The parser has already written its message to stderr. A command line
      // that did not parse cannot say whether --json was an option's value, so
      // the token decides: a script asking for JSON gets the failure as JSON.
      const usage = usageError(error.message.replace(/^error:\s*/, ''));
      new Output(io.stdout, own.includes('--json')).fail({
        message: usage.message,
        code: usage.code,
      });
      return usage.exitCode;
    }
    if (invocation === undefined) return ExitCode.SUCCESS;
    log.configureLog({ ...logConfig, verbose: invocation.verbose });
    return await execute(invocation, spec, io, new Output(io.stdout, invocation.json));
  } finally {
    log.configureLog(previousLog);
  }
}
