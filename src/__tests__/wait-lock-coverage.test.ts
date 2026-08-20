// SPDX-License-Identifier: EUPL-1.2
/**
 * Structural coverage of the `--wait-lock` flag.
 *
 * Two contracts, and they are different:
 *
 *  - EVERY command accepts `--wait-lock`, so a scripted sequence that
 *    blanket-appends the flag gets a lock message where one applies and a
 *    no-op elsewhere — never a usage error that kills the sequence.
 *  - Exactly the lock-taking commands HONOR it. Any command that
 *    serializes on a FireForge lock (`withEngineSessionLock` for
 *    engine-mutating commands, `withPatchDirectoryLock` at command level
 *    for queue-mutating ones) must register `addWaitLockOption` AND appear
 *    in the expected list below.
 *
 * Set equality is asserted in BOTH directions, so a lock-taking command
 * that forgets the flag fails here, and a newly flagged command that is
 * not added to the list fails here too (forcing a deliberate decision
 * instead of snapshot-regeneration drift).
 */
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from '../cli.js';

/** Fully-qualified command paths expected to HONOR `--wait-lock`. */
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

/** The accept-and-ignore registration says so in its description. */
function isAcceptedAndIgnored(command: Command): boolean {
  return (
    command.options.find((option) => option.long === '--wait-lock')?.description ?? ''
  ).includes('ignored');
}

function walk(
  command: Command,
  prefix: string[],
  visit: (path: string, command: Command) => void
): void {
  const path = [...prefix, command.name()].filter((part) => part !== '');
  visit(path.join(' '), command);
  for (const sub of command.commands) walk(sub, path, visit);
}

function collect(predicate: (command: Command) => boolean): string[] {
  const program = createProgram();
  const found: string[] = [];
  // The root program's name does not prefix subcommand paths.
  for (const command of program.commands) {
    walk(command, [], (path, current) => {
      if (predicate(current)) found.push(path);
    });
  }
  return found.sort();
}

describe('--wait-lock structural coverage', () => {
  it('is honored by exactly the lock-taking commands', () => {
    expect(
      collect(
        (command) =>
          command.options.some((option) => option.long === '--wait-lock') &&
          !isAcceptedAndIgnored(command)
      )
    ).toEqual(EXPECTED_WAIT_LOCK_COMMANDS);
  });

  it('is ACCEPTED by every command, so a blanket-appended flag is never a usage error', () => {
    const missing = collect(
      (command) => !command.options.some((option) => option.long === '--wait-lock')
    );
    expect(missing).toEqual([]);
  });

  it('marks the lock-free registrations as ignored rather than implying they wait', () => {
    const ignored = collect(
      (command) =>
        command.options.some((option) => option.long === '--wait-lock') &&
        isAcceptedAndIgnored(command)
    );
    expect(ignored).not.toHaveLength(0);
    expect(ignored).toContain('status');
    expect(ignored).toContain('patch staged-dependency');
    // A lock-taking command must never be downgraded to the ignored form.
    for (const honoring of EXPECTED_WAIT_LOCK_COMMANDS) {
      expect(ignored).not.toContain(honoring);
    }
  });
});
