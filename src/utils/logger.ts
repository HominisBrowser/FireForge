// SPDX-License-Identifier: EUPL-1.2
import * as p from '@clack/prompts';
import pc from 'picocolors';

/** Whether verbose mode is enabled */
let verboseMode = false;

/**
 * Enables or disables verbose mode.
 * @param enabled - Whether to enable verbose output
 */
export function setVerbose(enabled: boolean): void {
  verboseMode = enabled;
}

/**
 * Checks if verbose mode is enabled.
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
  if (verboseMode) {
    p.log.info(`[debug] ${message}`);
  }
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
  p.intro(message);
}

/** Displays the closing outro banner for a command. */
export function outro(message: string): void {
  p.outro(message);
}

/** Logs an informational message. */
export function info(message: string): void {
  p.log.info(message);
}

/** Logs a success message. */
export function success(message: string): void {
  p.log.success(message);
}

/** Logs a warning message. */
export function warn(message: string): void {
  p.log.warn(message);
}

/** Logs an error message. */
export function error(message: string): void {
  p.log.error(message);
}

/** Logs an in-progress step message. */
export function step(message: string): void {
  p.log.step(message);
}

/** Logs a plain message without a status prefix. */
export function message(message: string): void {
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
  p.cancel(message);
}

/** Checks whether a prompt result represents a user cancellation. */
export function isCancel(value: unknown): boolean {
  return p.isCancel(value);
}

/** Displays a titled note block for follow-up details. */
export function note(message: string, title?: string): void {
  p.note(message, title);
}
