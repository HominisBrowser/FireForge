// SPDX-License-Identifier: EUPL-1.2
/**
 * Diagnostics. Every line goes to stderr: stdout belongs to a command's
 * result and is written only through `cli/output.ts`, so nothing logged here
 * can corrupt a `--json` document or displace a verdict line.
 */
import { spinner as clackSpinner } from '@clack/prompts';
import picocolors from 'picocolors';

/**
 * Colour is for a person reading a terminal. A pipe or a log file gets plain
 * text, so output reads the same in a script, in CI and under test. `NO_COLOR`
 * turns colour off on a terminal; `FORCE_COLOR` turns it on for a pipe.
 */
function colourEnabled(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  const forced = process.env['FORCE_COLOR'];
  if (forced !== undefined) return forced !== '0';
  return (process.stderr.isTTY as boolean | undefined) === true;
}

const pc = picocolors.createColors(colourEnabled());

/** Where diagnostics go, and how much of them. */
export interface LogConfig {
  /** Receives each complete line (with its newline). Unset means `process.stderr`. */
  write?: ((text: string) => void) | undefined;
  /** Show `verbose` lines. */
  verbose?: boolean;
  /** Drop `info`, `step` and `success`; warnings and errors still print. */
  quiet?: boolean;
}

let config: LogConfig = {};

/**
 * Replaces the logging configuration and returns the previous one, so an
 * in-process CLI run can restore it.
 *
 * @param next - The configuration to install
 */
export function configureLog(next: LogConfig): LogConfig {
  const previous = config;
  config = next;
  return previous;
}

/** Whether `verbose` lines are shown. */
export function isVerbose(): boolean {
  return config.verbose === true;
}

function emit(prefix: string, message: string): void {
  const text = `${prefix}${message}\n`;
  if (config.write !== undefined) config.write(text);
  else process.stderr.write(text);
}

/**
 * Logs progress or context the operator may want.
 *
 * @param message - The line
 */
export function info(message: string): void {
  if (config.quiet !== true) emit('', message);
}

/**
 * Logs the start of a unit of work.
 *
 * @param message - The line
 */
export function step(message: string): void {
  if (config.quiet !== true) emit(pc.cyan('> '), message);
}

/**
 * Logs a completed unit of work.
 *
 * @param message - The line
 */
export function success(message: string): void {
  if (config.quiet !== true) emit(pc.green('ok '), message);
}

/**
 * Logs something the operator should look at that did not stop the command.
 *
 * @param message - The line
 */
export function warn(message: string): void {
  emit(pc.yellow('warning: '), message);
}

/**
 * Logs a failure. The CLI error boundary reports a thrown error itself; this
 * is for failures a command survives.
 *
 * @param message - The line
 */
export function error(message: string): void {
  emit(pc.red('error: '), message);
}

/**
 * Reports the failure a command ended with, the one form every failure takes
 * for a person: `error[<code>]: <message>`, then `hint: <hint>` when the
 * failure carries one.
 *
 * @param code - The failure's stable code
 * @param message - What failed
 * @param hint - What to do next
 */
export function failure(code: string, message: string, hint?: string): void {
  emit(pc.red(`error[${code}]: `), message);
  if (hint !== undefined) emit(pc.cyan('hint: '), hint);
}

/**
 * Logs detail shown only under `--verbose`.
 *
 * @param message - The line
 */
export function verbose(message: string): void {
  if (config.verbose === true) emit(pc.dim('debug: '), message);
}

/** A running progress indicator. */
export interface Spinner {
  /** Replaces the text. */
  update(message: string): void;
  /** Ends it as done, with an optional final line. */
  stop(message?: string): void;
  /** Ends it as failed. */
  fail(message?: string): void;
}

/**
 * Starts a progress indicator: animated when stderr is a terminal, one line
 * per update otherwise.
 *
 * @param message - The initial text
 */
export function spinner(message: string): Spinner {
  const animated =
    config.write === undefined &&
    config.quiet !== true &&
    process.stderr.isTTY &&
    process.stdout.isTTY;
  if (!animated) {
    let latest = message;
    step(message);
    return {
      update(next) {
        latest = next;
        step(next);
      },
      stop(final) {
        if (final !== undefined && final !== latest) success(final);
      },
      fail(final) {
        error(final ?? latest);
      },
    };
  }
  const active = clackSpinner({ output: process.stderr });
  active.start(message);
  return {
    update(next) {
      active.message(next);
    },
    stop(final) {
      active.stop(final ?? message);
    },
    fail(final) {
      active.error(final ?? message);
    },
  };
}
