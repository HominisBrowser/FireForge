// SPDX-License-Identifier: EUPL-1.2
/**
 * Maps commander's own parse failures onto the FireForge exit-code contract.
 *
 * Commander terminates the process itself on a usage error (unknown option,
 * missing argument, unknown command) with exit 1, which contradicts the
 * documented `INVALID_ARGUMENT` (8) in `docs/exit-codes.md` and bypasses the
 * `--json` refusal envelope because no action (and therefore no
 * `withErrorHandling` wrapper) ever runs. `createProgram` installs
 * `exitOverride()` so those failures surface as a thrown `CommanderError`,
 * and `main` routes them through here.
 */
import { CommanderError } from 'commander';

import { CommandError, FireForgeError, InvalidArgumentError } from './errors/base.js';
import { emitMachineError } from './utils/machine-output.js';

/**
 * Stable machine-readable tag for an error class, for the `--json` envelope.
 *
 * Derived from the class name rather than hand-mapped: a new error class gets
 * a sensible tag automatically, and the mapping cannot drift out of sync with
 * the taxonomy. `ConfigNotFoundError` becomes `config-not-found`.
 *
 * @param error - The error being rendered
 * @returns A kebab-case tag with the `Error` suffix stripped
 */
export function machineErrorCode(error: FireForgeError): string {
  return error.name
    .replace(/Error$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Whether the invocation asked for machine-readable output.
 *
 * Reading the flag from argv is blunt but exact: if the invocation asked for
 * machine output, stdout belongs to the payload from the first byte, before
 * commander has parsed anything.
 *
 * @param argv - Process argv (defaults to `process.argv`)
 * @returns True when `--json` or `--raw` is present
 */
export function wantsMachineOutput(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--json') || argv.includes('--raw');
}

/**
 * Converts a `CommanderError` thrown out of `parseAsync` into the exit
 * contract, and rethrows anything else untouched.
 *
 * `--help` and `--version` also travel through `exitOverride()` (codes
 * `commander.helpDisplayed` / `commander.version`, exit 0): commander has
 * already written their output, so those simply return. So does
 * `commander.help`: a command group invoked with no subcommand (`fireforge`,
 * `fireforge tree`), for which commander prints the group's help and would
 * exit 1. That is an informational invocation rather than a wrong flag.
 * `patch`, `token` and `furnace` already answer it with help and exit 0
 * through an explicit action, and the groups without one must not exit 8 (or
 * leak commander's `(outputHelp)` placeholder into a `--json` envelope)
 * merely for lacking it. A genuine usage error has already had its message
 * written to stderr by commander. It becomes exit 8, and under `--json` it
 * also gets the standard refusal envelope on stdout so a scripted consumer
 * sees a parseable failure.
 *
 * @param error - Whatever `parseAsync` rejected with
 * @param machineOutput - Whether the invocation asked for `--json`/`--raw`
 * @throws CommandError carrying `INVALID_ARGUMENT` for a usage error
 */
export function handleParseError(error: unknown, machineOutput: boolean): void {
  if (!(error instanceof CommanderError)) {
    throw error;
  }
  if (error.exitCode === 0 || error.code === 'commander.help') {
    return;
  }
  // Commander's message carries its own `error: ` prefix. Strip it so the
  // envelope text matches how every other refusal reads.
  const usage = new InvalidArgumentError(error.message.replace(/^error:\s*/, ''));
  if (machineOutput) {
    emitMachineError(machineErrorCode(usage), usage.message, usage.code);
  }
  throw new CommandError(usage.code);
}
