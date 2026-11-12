// SPDX-License-Identifier: EUPL-1.2
import type { Out } from './output.js';

/**
 * What every command's `run` receives. It describes the invocation and knows
 * nothing about projects: a command that needs one loads it from `cwd`.
 */
export interface CommandContext {
  /** Absolute directory the command was run from. */
  readonly cwd: string;
  /** The environment of the invocation. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where the command writes its result. */
  readonly out: Out;
  /** Whether a prompt can be answered. False in scripts, CI and agent sessions. */
  readonly interactive: boolean;
}
