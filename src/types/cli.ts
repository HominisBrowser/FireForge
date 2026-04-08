// SPDX-License-Identifier: EUPL-1.2
import type { Command } from 'commander';

/**
 * Context passed to command registration functions.
 */
export interface CommandContext {
  /** Returns the detected project root directory */
  getProjectRoot: () => string;
  /** Wraps async handlers with error handling */
  withErrorHandling: <T extends unknown[]>(
    handler: (...args: T) => Promise<void>
  ) => (...args: T) => Promise<void>;
}

/**
 * Function that registers one or more commands onto the given program.
 */
export type CommandRegistrar = (program: Command, ctx: CommandContext) => void;
