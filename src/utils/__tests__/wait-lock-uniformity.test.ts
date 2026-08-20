// SPDX-License-Identifier: EUPL-1.2
/**
 * A scripted sequence blanket-appends `--wait-lock`, and a subcommand that
 * rejects it with "unknown option" kills the sequence with a usage error
 * instead of a lock message.
 */
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  addWaitLockOption,
  ensureWaitLockOptionEverywhere,
  hasWaitLockOption,
} from '../options.js';

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
  it('gives every subcommand at every depth a --wait-lock flag', () => {
    const program = buildTree();
    expect(hasWaitLockOption(program.commands[1] as Command)).toBe(false);

    ensureWaitLockOptionEverywhere(program);

    const [build, status, patch] = program.commands as [Command, Command, Command];
    expect(hasWaitLockOption(build)).toBe(true);
    expect(hasWaitLockOption(status)).toBe(true);
    expect(hasWaitLockOption(patch.commands[0] as Command)).toBe(true);
  });

  it('does not replace the honoring registration on a lock-taking command', () => {
    const program = buildTree();
    ensureWaitLockOptionEverywhere(program);
    const build = program.commands[0] as Command;
    expect(build.options.filter((o) => o.long === '--wait-lock')).toHaveLength(1);
    expect(build.options.find((o) => o.long === '--wait-lock')?.description).not.toContain(
      'ignored'
    );
  });

  it('says plainly that the accepted flag is ignored on lock-free commands', () => {
    const program = buildTree();
    ensureWaitLockOptionEverywhere(program);
    const status = program.commands[1] as Command;
    expect(status.options.find((o) => o.long === '--wait-lock')?.description).toContain('ignored');
  });

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
