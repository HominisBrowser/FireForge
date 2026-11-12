// SPDX-License-Identifier: EUPL-1.2
import {
  confirm as clackConfirm,
  isCancel,
  select as clackSelect,
  text as clackText,
} from '@clack/prompts';

import { CancelledError, ExitCode, FireForgeError } from './errors.js';

/**
 * Whether a prompt can be answered: stdin and stdout are both terminals.
 * At runtime `isTTY` is `true` or absent, never `false`, hence the comparison.
 */
export function isInteractive(): boolean {
  const stdin = process.stdin.isTTY as boolean | undefined;
  const stdout = process.stdout.isTTY as boolean | undefined;
  return stdin === true && stdout === true;
}

/**
 * Asks a yes/no question on the terminal.
 *
 * @param message - The question
 * @param options - `initial` is the answer Enter gives (default no)
 * @returns The answer. "No" is an answer, not a cancellation
 * @throws {CancelledError} When the user interrupts the prompt
 * @throws An `invalid-argument` error when no terminal is attached, so a
 *   scripted run fails with the flag to pass instead of hanging
 */
export async function confirm(
  message: string,
  options: { initial?: boolean } = {}
): Promise<boolean> {
  if (!isInteractive()) {
    throw new FireForgeError(
      'invalid-argument',
      `"${message}" needs an answer, but no terminal is attached.`,
      { exitCode: ExitCode.INVALID_ARGUMENT, hint: 'Pass --yes to confirm without a prompt.' }
    );
  }
  const answer = await clackConfirm({
    message,
    initialValue: options.initial ?? false,
    output: process.stderr,
  });
  if (isCancel(answer)) throw new CancelledError();
  return answer;
}

function requireTerminal(message: string): void {
  if (isInteractive()) return;
  throw new FireForgeError(
    'invalid-argument',
    `"${message}" needs an answer, but no terminal is attached.`,
    { exitCode: ExitCode.INVALID_ARGUMENT, hint: 'Pass the value as an option.' }
  );
}

/**
 * Asks for one line of text on the terminal.
 *
 * @param message - The question
 * @param options - `initial` is the answer Enter gives; `validate` returns
 *   why an answer is refused, or undefined to accept it
 * @returns The answer, trimmed
 * @throws {CancelledError} When the user interrupts the prompt
 * @throws An `invalid-argument` error when no terminal is attached
 */
export async function ask(
  message: string,
  options: { initial?: string; validate?: (answer: string) => string | undefined } = {}
): Promise<string> {
  requireTerminal(message);
  const { initial, validate } = options;
  const answer = await clackText({
    message,
    output: process.stderr,
    ...(initial === undefined ? {} : { placeholder: initial, defaultValue: initial }),
    validate: (value) => validate?.((value ?? '').trim() || (initial ?? '')),
  });
  if (isCancel(answer)) throw new CancelledError();
  return answer.trim();
}

/**
 * Asks the user to pick one of several values on the terminal.
 *
 * @param message - The question
 * @param choices - The values, each with the label shown for it
 * @param initial - The value the cursor starts on
 * @throws {CancelledError} When the user interrupts the prompt
 * @throws An `invalid-argument` error when no terminal is attached
 */
export async function choose<T extends string>(
  message: string,
  choices: readonly { value: T; label: string }[],
  initial?: T
): Promise<T> {
  requireTerminal(message);
  const answer = await clackSelect<string>({
    message,
    output: process.stderr,
    options: choices.map((choice) => ({ value: choice.value, label: choice.label })),
    ...(initial === undefined ? {} : { initialValue: initial }),
  });
  if (isCancel(answer)) throw new CancelledError();
  return answer as T;
}
