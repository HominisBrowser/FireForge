// SPDX-License-Identifier: EUPL-1.2
/**
 * Parse-level behaviour of the blanket `--wait-lock` registration: a
 * lock-free command must accept the flag (rather than die on "unknown
 * option") without becoming permissive about malformed values.
 *
 * Which real commands carry — and honor — the flag is asserted against the
 * actual program in `src/__tests__/wait-lock-contract.test.ts`.
 */
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { addWaitLockOption, ensureWaitLockOptionEverywhere } from '../options.js';

function buildTree(): Command {
  const program = new Command();
  program.exitOverride();
  const lockTaking = program.command('build');
  lockTaking.exitOverride();
  addWaitLockOption(lockTaking);
  const lockFree = program.command('status');
  lockFree.exitOverride();
  const parent = program.command('patch');
  parent.exitOverride();
  const nested = parent.command('staged-dependency');
  nested.exitOverride();
  return program;
}

describe('ensureWaitLockOptionEverywhere', () => {
  it('parses the flag on a lock-free command instead of erroring on an unknown option', () => {
    const program = buildTree();
    ensureWaitLockOptionEverywhere(program);
    let parsed: unknown;
    (program.commands[1] as Command).action((options: { waitLock?: unknown }) => {
      parsed = options.waitLock;
    });
    program.parse(['status', '--wait-lock', '120'], { from: 'user' });
    expect(parsed).toBe(120);
  });

  it('still rejects a malformed value everywhere — uniformity is not permissiveness', () => {
    const program = buildTree();
    ensureWaitLockOptionEverywhere(program);
    (program.commands[1] as Command).action(() => undefined);
    expect(() => program.parse(['status', '--wait-lock', 'soon'], { from: 'user' })).toThrow();
  });
});
