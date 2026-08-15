// SPDX-License-Identifier: EUPL-1.2
/**
 * Structural coverage of the `--wait-lock` flag (FORGE J4).
 *
 * Maintenance contract: any command that serializes on a FireForge lock —
 * `withEngineSessionLock` for engine-mutating commands or
 * `withPatchDirectoryLock` at command level for queue-mutating ones — must
 * register `addWaitLockOption` AND appear in the expected list below. This
 * test asserts set equality in BOTH directions, so a lock-taking command
 * that forgets the flag fails here, and a newly flagged command that is
 * not added to the list fails here too (forcing a deliberate decision
 * instead of snapshot-regeneration drift).
 */
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from '../cli.js';

/** Fully-qualified command paths expected to register `--wait-lock`. */
const EXPECTED_WAIT_LOCK_COMMANDS = [
  'build',
  'export',
  're-export',
  'test',
  'tree create',
  'furnace apply',
  'furnace deploy',
  'furnace sync',
  'patch delete',
  'patch reorder',
  'patch rename',
  'patch move-files',
  'patch split',
  'patch compact',
].sort();

function collectWaitLockCommands(command: Command, prefix: string[]): string[] {
  const found: string[] = [];
  const path = [...prefix, command.name()].filter((part) => part !== '');
  if (command.options.some((option) => option.long === '--wait-lock')) {
    found.push(path.join(' '));
  }
  for (const sub of command.commands) {
    found.push(...collectWaitLockCommands(sub, path));
  }
  return found;
}

describe('--wait-lock structural coverage', () => {
  it('is registered on exactly the lock-taking commands', () => {
    const program = createProgram();
    // The root program's name does not prefix subcommand paths.
    const actual = program.commands
      .flatMap((command) => collectWaitLockCommands(command, []))
      .sort();
    expect(actual).toEqual(EXPECTED_WAIT_LOCK_COMMANDS);
  });
});
