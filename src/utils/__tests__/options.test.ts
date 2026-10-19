// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addWaitLockOption,
  commanderArgParser,
  ensureWaitLockOptionEverywhere,
  isPathShapedArgument,
  pickDefined,
  releasePathShapedValues,
  resolveWaitLockSeconds,
  WAIT_LOCK_ENV_VAR,
} from '../options.js';

describe('pickDefined', () => {
  it('strips undefined values', () => {
    const result = pickDefined({ a: 1, b: undefined, c: 'hello' });
    expect(result).toEqual({ a: 1, c: 'hello' });
    expect('b' in result).toBe(false);
  });

  it('keeps falsy non-undefined values (false, 0, empty string, null)', () => {
    const result = pickDefined({ a: false, b: 0, c: '', d: null });
    expect(result).toEqual({ a: false, b: 0, c: '', d: null });
  });

  it('returns empty object when all values are undefined', () => {
    const result = pickDefined({ a: undefined, b: undefined });
    expect(result).toEqual({});
  });

  it('returns empty object for empty input', () => {
    const result = pickDefined({});
    expect(result).toEqual({});
  });

  it('preserves all values when none are undefined', () => {
    const result = pickDefined({ x: 1, y: 'two', z: true });
    expect(result).toEqual({ x: 1, y: 'two', z: true });
  });
});

describe('resolveWaitLockSeconds', () => {
  it('returns undefined when the flag is absent', () => {
    expect(resolveWaitLockSeconds(undefined)).toBeUndefined();
  });

  it('maps the bare flag to the 60-second default', () => {
    expect(resolveWaitLockSeconds(true)).toBe(60);
  });

  it('parses an explicit seconds value', () => {
    expect(resolveWaitLockSeconds('120')).toBe(120);
  });

  it('passes through an already-parsed number', () => {
    expect(resolveWaitLockSeconds(45)).toBe(45);
  });

  it('accepts waits past the old one-hour cap, up to a day', () => {
    expect(resolveWaitLockSeconds('7200')).toBe(7200);
    expect(resolveWaitLockSeconds('86400')).toBe(86400);
  });

  it.each(['0', '86401', 'abc', '-5'])('rejects %s with the exact range message', (raw) => {
    expect(() => resolveWaitLockSeconds(raw)).toThrow(
      `--wait-lock must be an integer in 1..86400 (got "${raw}")`
    );
  });
});

describe(`resolveWaitLockSeconds and ${WAIT_LOCK_ENV_VAR}`, () => {
  afterEach(() => {
    process.env[WAIT_LOCK_ENV_VAR] = '';
  });

  it('uses the environment budget when the flag is absent', () => {
    process.env[WAIT_LOCK_ENV_VAR] = '900';
    expect(resolveWaitLockSeconds(undefined)).toBe(900);
  });

  it('lets an explicit flag value win over the environment', () => {
    // The environment states a default for a session. An invocation that
    // names a budget has said something more specific.
    process.env[WAIT_LOCK_ENV_VAR] = '900';
    expect(resolveWaitLockSeconds('30')).toBe(30);
    expect(resolveWaitLockSeconds(true)).toBe(60);
  });

  it('ignores an empty or whitespace-only value', () => {
    process.env[WAIT_LOCK_ENV_VAR] = '   ';
    expect(resolveWaitLockSeconds(undefined)).toBeUndefined();
  });

  it.each(['0', '86401', 'soon'])('refuses %s rather than silently failing fast', (raw) => {
    process.env[WAIT_LOCK_ENV_VAR] = raw;
    expect(() => resolveWaitLockSeconds(undefined)).toThrow(WAIT_LOCK_ENV_VAR);
  });
});

describe('nested wait-lock routing', () => {
  it.each(['furnace', 'patch', 'tree', 'token', 'source'])(
    'delivers a trailing flag to the %s leaf action',
    async (family) => {
      const program = new Command();
      program.option('--verbose');
      const group = program.command(family);
      const leaf = addWaitLockOption(group.command('mutate'));
      let received: unknown;
      leaf.action((options: { waitLock?: number | boolean }) => {
        received = options.waitLock;
      });
      ensureWaitLockOptionEverywhere(program);
      await program.parseAsync([
        'node',
        'fireforge',
        '--verbose',
        family,
        'mutate',
        '--wait-lock',
        '300',
      ]);
      expect(received).toBe(300);
      expect(group.opts()).not.toHaveProperty('waitLock');
      expect(program.opts()['verbose']).toBe(true);
    }
  );

  it('routes the bare wait flag as the leaf default', async () => {
    const program = new Command();
    const leaf = addWaitLockOption(program.command('furnace').command('deploy'));
    let received: unknown;
    leaf.action((options: { waitLock?: number | boolean }) => {
      received = options.waitLock;
    });
    ensureWaitLockOptionEverywhere(program);
    await program.parseAsync(['node', 'fireforge', 'furnace', 'deploy', '--wait-lock']);
    expect(resolveWaitLockSeconds(received as boolean)).toBe(60);
  });
});

describe('path-shaped values after numeric optional-value flags', () => {
  it.each([
    ['browser_x.js', true],
    ['browser/base/content/test/tiles', true],
    ['dir/', true],
    ['.', true],
    ['browser.toml', true],
    ['1800', false],
    ['1.5', false],
    ['nonsense', false],
  ])('isPathShapedArgument(%s) is %s', (token, expected) => {
    expect(isPathShapedArgument(token)).toBe(expected);
  });

  it('moves a released flag after the operands and before "--", keeping operand order', () => {
    expect(
      releasePathShapedValues(
        ['--wait-lock', 'a/browser_a.js', 'b.js', '--shuffle', 'c/', '--', '--x'],
        new Set()
      )
    ).toEqual(['a/browser_a.js', 'b.js', 'c/', '--wait-lock', '--shuffle', '--', '--x']);
  });

  it('keeps numeric values, bare words and required-option values in place', () => {
    const argv = [
      '--wait-port',
      '300',
      '--wait-browser',
      'soon',
      '--mach-arg',
      '--wait-lock',
      'x.js',
    ];
    expect(releasePathShapedValues(argv, new Set(['--mach-arg']))).toEqual(argv);
  });

  function makeProgram(seen: { paths?: string[]; options?: Record<string, unknown> }): Command {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    const test = program
      .command('test [paths...]')
      .option(
        '--wait-browser [seconds]',
        'wait',
        commanderArgParser((raw) => resolveWaitLockSeconds(raw))
      )
      .option(
        '--shuffle [seed]',
        'seed',
        commanderArgParser((raw) => Number.parseInt(raw, 10))
      )
      .option('--canary [path]', 'canary path')
      .option('--mach-arg <arg>', 'forward')
      .action((paths: string[], options: Record<string, unknown>) => {
        seen.paths = paths;
        seen.options = options;
      });
    addWaitLockOption(test);
    ensureWaitLockOptionEverywhere(program);
    return program;
  }

  it('reads a path after --wait-lock as a positional and the flag as bare (was a usage error)', async () => {
    const seen: { paths?: string[]; options?: Record<string, unknown> } = {};
    await makeProgram(seen).parseAsync([
      'node',
      'fireforge',
      'test',
      '--wait-lock',
      'browser/base/browser_a.js',
      'browser/base/browser_b.js',
    ]);
    expect(seen.paths).toEqual(['browser/base/browser_a.js', 'browser/base/browser_b.js']);
    expect(seen.options).toMatchObject({ waitLock: true });
  });

  it('applies to --wait-browser and --shuffle but never to --canary, whose value is a path', async () => {
    const seen: { paths?: string[]; options?: Record<string, unknown> } = {};
    await makeProgram(seen).parseAsync([
      'node',
      'fireforge',
      'test',
      'a/browser_a.js',
      '--wait-browser',
      'b/browser_b.js',
      '--shuffle',
      'c/browser_c.js',
      '--canary',
      'd/browser_d.js',
    ]);
    expect(seen.paths).toEqual(['a/browser_a.js', 'b/browser_b.js', 'c/browser_c.js']);
    expect(seen.options).toMatchObject({
      waitBrowser: true,
      shuffle: true,
      canary: 'd/browser_d.js',
    });
  });

  it('still binds a numeric value and still refuses a bare-word one', async () => {
    const seen: { paths?: string[]; options?: Record<string, unknown> } = {};
    await makeProgram(seen).parseAsync(['node', 'fireforge', 'test', '--wait-lock', '120', 'x.js']);
    expect(seen.options).toMatchObject({ waitLock: 120 });
    expect(seen.paths).toEqual(['x.js']);
    await expect(
      makeProgram({}).parseAsync(['node', 'fireforge', 'test', '--wait-lock', 'nonsense'])
    ).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });
});
