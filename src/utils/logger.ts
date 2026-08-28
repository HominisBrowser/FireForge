// SPDX-License-Identifier: EUPL-1.2
import * as p from '@clack/prompts';
import pc from 'picocolors';

/** Whether verbose mode is enabled */
let verboseMode = false;

/**
 * Whether machine-output mode is active (`--json` / `--raw`).
 *
 * In machine mode, stdout belongs EXCLUSIVELY to the machine-readable
 * payload: all human-facing diagnostics (intro/outro banners, info, warn,
 * error, steps, notes) are routed to stderr as plain unstyled lines.
 * Otherwise clack's log helpers write styled warnings to stdout *before* the
 * JSON body — a truncated-directory warning during `status --json` breaks
 * every `JSON.parse(stdout)` consumer.
 */
let machineOutputMode = false;

/**
 * Enables or disables verbose mode.
 * @param enabled - Whether to enable verbose output
 */
export function setVerbose(enabled: boolean): void {
  verboseMode = enabled;
}

/**
 * Switches the logger into (or out of) machine-output mode. Commands with
 * `--json`/`--raw` flags call this before producing any output.
 */
export function setMachineOutputMode(enabled: boolean): void {
  machineOutputMode = enabled;
}

/** True when machine-output mode is active. */
export function isMachineOutputMode(): boolean {
  return machineOutputMode;
}

/**
 * Whether stdout is sealed behind a machine-readable final line.
 *
 * The `FIREFORGE-VERDICT:` contract promises that line as the run's LAST
 * stdout write — but emit-then-throw failure paths rethrow into
 * `withErrorHandling`, whose clack error/cancel rendering lands on stdout
 * in non-machine mode, displacing the verdict from the final line. The
 * verdict sink seals stdout the moment it writes; every later logger call
 * routes to stderr through the same diagnostic channel machine mode uses.
 * `withErrorHandling`'s finally clears the seal (alongside machine mode).
 */
let stdoutSealed = false;

/** Seals (or unseals) stdout after a machine-readable final line. */
export function setStdoutSealed(sealed: boolean): void {
  stdoutSealed = sealed;
}

/**
 * True when a machine-readable payload already owns stdout.
 *
 * The CLI error boundary consults this before emitting a `--json` error
 * envelope: a command that wrote its payload and THEN refused (e.g.
 * `status --json --fail-on`) must not have a second JSON document appended,
 * which would break the "exactly one document" half of the contract in
 * docs/machine-output.md.
 */
export function isStdoutSealed(): boolean {
  return stdoutSealed;
}

/** True when human output must avoid stdout. */
function routeToStderr(): boolean {
  return machineOutputMode || stdoutSealed;
}

/** Writes a plain diagnostic line to stderr (machine-mode side channel). */
function writeDiagnostic(prefix: string, message: string): void {
  process.stderr.write(`${prefix}${message}\n`);
}

/**
 * Checks if verbose mode is enabled.
 *
 * Exported so the CLI error boundary can decide whether to walk an error's
 * `cause` chain.
 *
 * @returns True if verbose mode is enabled
 */
export function isVerbose(): boolean {
  return verboseMode;
}

/**
 * Displays a verbose/debug message (only shown if verbose mode is enabled).
 * @param message - Message to display
 */
export function verbose(message: string): void {
  if (!isVerbose()) return;
  if (routeToStderr()) {
    writeDiagnostic('[debug] ', message);
    return;
  }
  p.log.info(`[debug] ${message}`);
}

/**
 * Handle returned by the spinner function.
 */
export interface SpinnerHandle {
  /** Update the spinner message */
  message: (msg: string) => void;
  /** Stop the spinner with a success message */
  stop: (msg?: string) => void;
  /** Stop the spinner with an error message */
  error: (msg?: string) => void;
}

function supportsInteractiveSpinner(): boolean {
  return process.stdout.isTTY && process.stderr.isTTY;
}

/** Displays the top-level intro banner for a command. */
export function intro(message: string): void {
  if (routeToStderr()) return;
  p.intro(message);
}

/** Displays the closing outro banner for a command. */
export function outro(message: string): void {
  if (routeToStderr()) return;
  p.outro(message);
}

/** Logs an informational message. */
export function info(message: string): void {
  if (routeToStderr()) {
    writeDiagnostic('', message);
    return;
  }
  p.log.info(message);
}

/** Logs a success message. */
export function success(message: string): void {
  if (routeToStderr()) {
    writeDiagnostic('', message);
    return;
  }
  p.log.success(message);
}

/** Logs a warning message. */
export function warn(message: string): void {
  if (routeToStderr()) {
    writeDiagnostic('warning: ', message);
    return;
  }
  p.log.warn(message);
}

/**
 * Prefix that marks a line as FireForge's own explanatory output rather
 * than a defect. Kept greppable so downstream filters can whitelist it.
 */
export const NOTICE_PREFIX = '[FireForge] NOTICE:';

/**
 * Logs one of FireForge's own "why this is happening / why this is slow"
 * explanations at WARNING severity.
 *
 * These lines are not warnings about the operator's code — they explain a
 * decision FireForge just made (escalating an incremental build to a full
 * one, sharding a run, skipping a step). Emitted through `info` they are
 * silently dropped by agent-facing output filters that keep only warnings
 * and errors, leaving a multi-minute build with no explanation and reading
 * as a hang. There are very few such lines and they are exactly the ones a
 * non-interactive operator needs, so they ride the warning channel and carry
 * {@link NOTICE_PREFIX} so a reader can still tell them apart from a real
 * warning.
 */
export function notice(message: string): void {
  if (routeToStderr()) {
    writeDiagnostic('warning: ', `${NOTICE_PREFIX} ${message}`);
    return;
  }
  p.log.warn(`${NOTICE_PREFIX} ${message}`);
}

/** Logs an error message. */
export function error(message: string): void {
  if (routeToStderr()) {
    writeDiagnostic('error: ', message);
    return;
  }
  p.log.error(message);
}

/** Logs an in-progress step message. */
export function step(message: string): void {
  if (routeToStderr()) {
    writeDiagnostic('', message);
    return;
  }
  p.log.step(message);
}

/** Logs a plain message without a status prefix. */
export function message(message: string): void {
  if (routeToStderr()) {
    writeDiagnostic('', message);
    return;
  }
  p.log.message(message);
}

/** Formats text using the success color without logging it. */
export function formatSuccessText(message: string): string {
  return pc.green(message);
}

/** Formats text using the error color without logging it. */
export function formatErrorText(message: string): string {
  return pc.red(message);
}

/**
 * Creates a spinner for long-running operations.
 * @param initialMessage - Initial message to display
 * @returns Spinner handle with message(), stop(), and error() methods
 */
export function spinner(initialMessage: string): SpinnerHandle {
  if (routeToStderr()) {
    // Spinner progress is diagnostics; keep stdout clean for the payload.
    return {
      message: (msg: string) => {
        writeDiagnostic('', msg);
      },
      stop: (msg?: string) => {
        if (msg) writeDiagnostic('', msg);
      },
      error: (msg?: string) => {
        writeDiagnostic('error: ', msg ?? 'Failed');
      },
    };
  }
  if (!supportsInteractiveSpinner()) {
    let latestMessage = initialMessage;

    return {
      message: (msg: string) => {
        latestMessage = msg;
        p.log.step(msg);
      },
      stop: (msg?: string) => {
        p.log.step(msg ?? latestMessage);
      },
      error: (msg?: string) => {
        p.log.error(msg ?? 'Failed');
      },
    };
  }

  const s = p.spinner();
  s.start(initialMessage);

  return {
    message: (msg: string) => {
      s.message(msg);
    },
    stop: (msg?: string) => {
      s.stop(msg ?? initialMessage);
    },
    error: (msg?: string) => {
      s.stop();
      p.log.error(msg ?? 'Failed');
    },
  };
}

/** Emits a cancellation message. */
export function cancel(message: string): void {
  if (routeToStderr()) {
    writeDiagnostic('cancelled: ', message);
    return;
  }
  p.cancel(message);
}

/**
 * Checks whether a prompt result represents a user cancellation.
 *
 * Narrows to `symbol` — clack returns its cancel sentinel as a symbol and
 * `p.isCancel` is itself a type predicate. Returning plain `boolean` erases
 * that narrowing and forces `as string` / `as PatchCategory` casts across
 * the command modules on the *non*-cancelled branch, where the value is
 * already known not to be the sentinel. Keep the predicate form.
 */
export function isCancel(value: unknown): value is symbol {
  return p.isCancel(value);
}

/** Displays a titled note block for follow-up details. */
export function note(message: string, title?: string): void {
  if (routeToStderr()) {
    writeDiagnostic('', title ? `${title}: ${message}` : message);
    return;
  }
  p.note(message, title);
}
