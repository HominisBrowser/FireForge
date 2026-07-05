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
 * Before this mode existed, clack's log helpers wrote styled warnings to
 * stdout *before* the JSON body — a truncated-directory warning during
 * `status --json` broke every `JSON.parse(stdout)` consumer, and error
 * objects on the machine contract were followed by a styled duplicate on
 * the same stream.
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

/** Writes a plain diagnostic line to stderr (machine-mode side channel). */
function writeDiagnostic(prefix: string, message: string): void {
  process.stderr.write(`${prefix}${message}\n`);
}

/**
 * Checks if verbose mode is enabled.
 * @returns True if verbose mode is enabled
 */
function isVerbose(): boolean {
  return verboseMode;
}

/**
 * Displays a verbose/debug message (only shown if verbose mode is enabled).
 * @param message - Message to display
 */
export function verbose(message: string): void {
  if (!isVerbose()) return;
  if (machineOutputMode) {
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
  if (machineOutputMode) return;
  p.intro(message);
}

/** Displays the closing outro banner for a command. */
export function outro(message: string): void {
  if (machineOutputMode) return;
  p.outro(message);
}

/** Logs an informational message. */
export function info(message: string): void {
  if (machineOutputMode) {
    writeDiagnostic('', message);
    return;
  }
  p.log.info(message);
}

/** Logs a success message. */
export function success(message: string): void {
  if (machineOutputMode) {
    writeDiagnostic('', message);
    return;
  }
  p.log.success(message);
}

/** Logs a warning message. */
export function warn(message: string): void {
  if (machineOutputMode) {
    writeDiagnostic('warning: ', message);
    return;
  }
  p.log.warn(message);
}

/** Logs an error message. */
export function error(message: string): void {
  if (machineOutputMode) {
    writeDiagnostic('error: ', message);
    return;
  }
  p.log.error(message);
}

/** Logs an in-progress step message. */
export function step(message: string): void {
  if (machineOutputMode) {
    writeDiagnostic('', message);
    return;
  }
  p.log.step(message);
}

/** Logs a plain message without a status prefix. */
export function message(message: string): void {
  if (machineOutputMode) {
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
  if (machineOutputMode) {
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
  if (machineOutputMode) {
    writeDiagnostic('cancelled: ', message);
    return;
  }
  p.cancel(message);
}

/** Checks whether a prompt result represents a user cancellation. */
export function isCancel(value: unknown): boolean {
  return p.isCancel(value);
}

/** Displays a titled note block for follow-up details. */
export function note(message: string, title?: string): void {
  if (machineOutputMode) {
    writeDiagnostic('', title ? `${title}: ${message}` : message);
    return;
  }
  p.note(message, title);
}
