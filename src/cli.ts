// SPDX-License-Identifier: EUPL-1.2
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Command, Help } from 'commander';

import { COMMAND_MANIFEST, type CommandManifestEntry } from './commands/manifest.js';
import { runTreeGuardHook } from './core/tree-guard.js';
import { CancellationError, CommandError, FireForgeError } from './errors/base.js';
import { ExitCode } from './errors/codes.js';
import { ConfigNotFoundError } from './errors/config.js';
import type { CommandContext } from './types/cli.js';
import { getCliVersion } from './utils/build-info.js';
import { toError } from './utils/errors.js';
import {
  cancel,
  error as logError,
  setMachineOutputMode,
  setStdoutSealed,
  setVerbose,
} from './utils/logger.js';

const brokenPipeInstalledKey = Symbol.for('fireforge.cli.brokenPipeHandlerInstalled');
const brokenPipeListenerKey = Symbol.for('fireforge.cli.brokenPipeHandlerListener');

type FireForgeProcess = NodeJS.Process & {
  [brokenPipeInstalledKey]?: boolean | undefined;
  [brokenPipeListenerKey]?: ((error: NodeJS.ErrnoException) => void) | undefined;
};

function getProcessState(): FireForgeProcess {
  return process;
}

function getBrokenPipeHandler(state: FireForgeProcess): (error: NodeJS.ErrnoException) => void {
  const existingHandler = state[brokenPipeListenerKey];
  if (existingHandler) {
    return existingHandler;
  }

  const handler = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') {
      process.exitCode = 0;
      return;
    }

    throw error;
  };

  state[brokenPipeListenerKey] = handler;
  return handler;
}

/**
 * Installs a handler for broken-pipe (EPIPE) errors on stdout/stderr.
 * This is a process-level concern: when output is piped to a process that
 * closes early (e.g. `fireforge status | head`), Node emits EPIPE.
 * We treat this as a clean exit.
 */
export function installBrokenPipeHandler(): void {
  const state = getProcessState();
  if (state[brokenPipeInstalledKey]) {
    return;
  }

  const handleStreamError = getBrokenPipeHandler(state);
  process.stdout.on('error', handleStreamError);
  process.stderr.on('error', handleStreamError);
  state[brokenPipeInstalledKey] = true;
}

/** Removes the broken-pipe handler installed for CLI tests. */
export function resetBrokenPipeHandlerForTests(): void {
  const state = getProcessState();
  const handleStreamError = state[brokenPipeListenerKey];

  if (handleStreamError) {
    process.stdout.off('error', handleStreamError);
    process.stderr.off('error', handleStreamError);
  }

  state[brokenPipeInstalledKey] = undefined;
  state[brokenPipeListenerKey] = undefined;
}

/**
 * Maximum number of directory levels to walk when searching for
 * `fireforge.json`. `dirname()` walking is pure string manipulation and
 * cannot cycle (the `parent === current` check already terminates at the
 * root); this cap only bounds the cost on pathologically deep paths.
 */
const MAX_PROJECT_ROOT_WALK_DEPTH = 50;

/**
 * Gets the project root directory.
 * Walks up from the current working directory until a fireforge.json is found.
 * Throws a {@link ConfigNotFoundError} (code: CONFIG_ERROR) when no
 * fireforge.json is found within the walk depth limit — the error is
 * user-facing so `withErrorHandling` can print the guidance without
 * the stack dump that a plain `Error` would trigger.
 */
export function getProjectRoot(): string {
  const start = resolve(process.cwd());
  let current = start;

  for (let depth = 0; depth < MAX_PROJECT_ROOT_WALK_DEPTH; depth++) {
    if (existsSync(join(current, 'fireforge.json'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) break;

    current = parent;
  }

  throw new ConfigNotFoundError('fireforge.json');
}

/**
 * Wraps a command handler with error handling.
 *
 * Logs the user-visible error message and throws a {@link CommandError}
 * carrying the appropriate exit code. The actual `process.exit()` call
 * lives in the CLI entrypoint (`bin/fireforge.ts`), keeping shared library
 * code free of process-terminating side effects.
 */
export function withErrorHandling<T extends unknown[]>(
  handler: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await handler(...args);
    } catch (error: unknown) {
      // Sentinel errors have already been rendered by the command. Passing
      // them through prevents machine-readable refusal paths from acquiring
      // an "Unexpected error" banner and stack trace on stderr.
      if (error instanceof CommandError) {
        throw error;
      }

      if (error instanceof CancellationError) {
        cancel('Operation cancelled');
        // 130 (128+SIGINT) is the conventional "user interrupted" code —
        // scripts/CI can distinguish a deliberate prompt cancellation from
        // a real failure (which exits 1).
        throw new CommandError(ExitCode.USER_CANCELLED);
      }

      if (error instanceof FireForgeError) {
        logError(error.userMessage);
        throw new CommandError(error.code);
      }

      const normalizedError = toError(error);
      logError(`Unexpected error: ${normalizedError.message}`);
      if (normalizedError.stack) {
        console.error(normalizedError.stack);
      }
      throw new CommandError(ExitCode.GENERAL_ERROR);
    } finally {
      // Central machine-mode and stdout-seal reset. Commands leave both
      // ENGAGED while an error propagates (a mid-throw restore would route
      // the styled error to stdout, corrupting the `--json`/`--raw` payload
      // stream or displacing the FIREFORGE-VERDICT line); the reset happens
      // here, after logError has picked its stream, so no state leaks into
      // a subsequent in-process invocation.
      setMachineOutputMode(false);
      setStdoutSealed(false);
    }
  };
}

/** Human-readable labels for command groups, in display order. */
const GROUP_LABELS: ReadonlyMap<CommandManifestEntry['group'], string> = new Map([
  ['project', 'Project'],
  ['engine', 'Engine'],
  ['workflow', 'Workflow'],
  ['components', 'Components'],
  ['diagnostics', 'Diagnostics'],
]);

/**
 * Builds a grouped help formatter that replaces Commander's flat command
 * list with sections labelled by manifest group.
 */
function buildGroupedHelpFormatter(
  manifest: readonly CommandManifestEntry[]
): (cmd: Command, helper: Help) => string {
  const commandGroupMap = new Map<string, CommandManifestEntry['group']>();
  for (const entry of manifest) {
    commandGroupMap.set(entry.name, entry.group);
  }

  return (cmd: Command, helper: Help): string => {
    // For subcommands (e.g. `furnace --help`), fall back to Commander's
    // default formatting by calling the prototype method directly.
    if (cmd.parent) {
      return Help.prototype.formatHelp.call(helper, cmd, helper);
    }

    const termWidth = helper.padWidth(cmd, helper);
    const helpWidth = helper.helpWidth ?? 80;

    const output: string[] = [];

    // Usage
    output.push(`Usage: ${helper.commandUsage(cmd)}`, '');

    // Description
    const desc = helper.commandDescription(cmd);
    if (desc) {
      output.push(desc, '');
    }

    // Options
    const optionLines = helper.visibleOptions(cmd).map((opt) => {
      const term = helper.optionTerm(opt);
      const desc = helper.optionDescription(opt);
      return formatHelpLine(term, desc, termWidth, helpWidth);
    });
    // -V/--version is handled in main() before commander parses (a real
    // root-level `.version()` option would claim `--version` ANYWHERE in
    // argv under commander's default parsing, breaking subcommand flags
    // like `source set --version <v>`); advertise it here so root help
    // stays truthful.
    optionLines.unshift(
      formatHelpLine('-V, --version', 'output the version number', termWidth, helpWidth)
    );
    if (optionLines.length > 0) {
      output.push('Options:');
      output.push(...optionLines);
      output.push('');
    }

    // Grouped commands
    const visibleCommands = helper.visibleCommands(cmd);
    const grouped = new Map<string, string[]>();

    const otherLines: string[] = [];

    for (const sub of visibleCommands) {
      const name = sub.name();
      const group = commandGroupMap.get(name);
      const term = helper.subcommandTerm(sub);
      const desc = helper.subcommandDescription(sub);
      const line = formatHelpLine(term, desc, termWidth, helpWidth);

      if (!group) {
        // Built-in commands (e.g. "help") go to the end
        otherLines.push(line);
        continue;
      }

      const label = GROUP_LABELS.get(group) ?? group;
      const lines = grouped.get(label) ?? [];
      lines.push(line);
      grouped.set(label, lines);
    }

    for (const [, displayLabel] of GROUP_LABELS) {
      const lines = grouped.get(displayLabel);
      if (!lines || lines.length === 0) continue;
      output.push(`${displayLabel}:`);
      output.push(...lines);
      output.push('');
    }

    if (otherLines.length > 0) {
      output.push(...otherLines);
      output.push('');
    }

    return output.join('\n');
  };
}

/** Formats a single help line with term and description, wrapping as needed. */
function formatHelpLine(
  term: string,
  description: string,
  termWidth: number,
  helpWidth: number
): string {
  const padding = ' '.repeat(termWidth - term.length);
  const fullLine = `  ${term}${padding}  ${description}`;
  if (fullLine.length <= helpWidth || !description) {
    return fullLine;
  }

  // Wrap long descriptions
  const descWidth = helpWidth - termWidth - 4;
  if (descWidth < 20) {
    return fullLine;
  }

  const words = description.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > descWidth && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine.length > 0 ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  const indent = ' '.repeat(termWidth + 4);
  const first = lines[0] ?? '';
  const rest = lines.slice(1).map((l) => `${indent}${l}`);

  return [`  ${term}${padding}  ${first}`, ...rest].join('\n');
}

/**
 * Creates and configures the CLI program.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('fireforge')
    .description('A build tool for customizing Firefox')
    .option('-v, --verbose', 'Enable debug output')
    .option(
      '--ignore-corrupt-tree-marker',
      'Run even when .fireforge/tree.json exists but cannot be parsed. Without this the tree guard refuses, because an unreadable marker leaves it unknown whether this is a snapshot or the primary tree.'
    )
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      if (opts['verbose']) {
        setVerbose(true);
      }
    })
    // Verification-tree guard (FORGE G15): when the cwd resolves into a
    // tree snapshot, refuse mutating commands before their action runs —
    // one hook covers every command regardless of how the cwd got there.
    .hook('preAction', async (thisCommand, actionCommand) => {
      await runTreeGuardHook(thisCommand.name(), actionCommand);
    });

  const groupedFormatter = buildGroupedHelpFormatter(COMMAND_MANIFEST);
  program.configureHelp({
    formatHelp: groupedFormatter,
  });

  const ctx: CommandContext = { getProjectRoot, withErrorHandling };

  for (const entry of COMMAND_MANIFEST) {
    entry.register(program, ctx);
  }

  return program;
}

/**
 * Main CLI entry point.
 */
export async function main(): Promise<void> {
  // Root-level --version/-V handling. Deliberately NOT a commander
  // `.version()` option: under commander's default (non-positional)
  // parsing, a root version option claims `--version` anywhere in argv and
  // hijacks subcommand flags like `source set --version <v>`. The rule
  // here: when NO subcommand was given, any -V/--version among the root
  // flags prints the version — so `fireforge --verbose --version` works,
  // and `fireforge source set --version 152` is untouched.
  const userArgs = process.argv.slice(2);
  const hasSubcommand = userArgs.some((arg) => !arg.startsWith('-'));
  if (!hasSubcommand && userArgs.some((arg) => arg === '--version' || arg === '-V')) {
    process.stdout.write(`${getCliVersion()}\n`);
    return;
  }

  const program = createProgram();
  await program.parseAsync(process.argv);
}
