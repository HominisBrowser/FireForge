// SPDX-License-Identifier: EUPL-1.2
import { resolve } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  arg,
  confirmOptions,
  defineCommand,
  kebabCase,
  lockOptions,
  lockWaitMs,
  opt,
  type RawInvocation,
  resolveInvocation,
} from './command.js';
import type { CommandContext } from './context.js';

const build = defineCommand({
  name: 'build',
  summary: 'Build the browser',
  args: {
    target: arg.enum(['browser', 'tests'], 'What to build', { optional: true }),
    paths: arg.list('Directories to rebuild'),
  },
  options: {
    ui: opt.flag('Rebuild front-end files only'),
    full: opt.flag('Rebuild everything'),
    color: opt.flag('Colour the output', { negatable: true, default: true }),
    jobs: opt.integer('Parallel jobs', { short: 'j', min: 1, max: 64 }),
    retries: opt.integer('Retries', { default: 2 }),
    ratio: opt.number('Load ratio', { min: 0, max: 1 }),
    arch: opt.enum(['x64', 'arm64'], 'Target architecture'),
    channel: opt.enum(['release', 'beta'], 'Channel', { default: 'release' }),
    name: opt.string('Build name', { required: true }),
    out: opt.path('Output directory'),
    only: opt.list('Steps to run'),
    ...lockOptions,
    ...confirmOptions,
  },
  constraints: {
    exclusive: [['ui', 'full']],
    requires: { ratio: ['jobs'] },
  },
  run: (ctx, args, opts) => {
    expectTypeOf(ctx).toEqualTypeOf<CommandContext>();
    expectTypeOf(args).toEqualTypeOf<{
      target: 'browser' | 'tests' | undefined;
      paths: string[];
    }>();
    expectTypeOf(opts).toEqualTypeOf<{
      ui: boolean;
      full: boolean;
      color: boolean;
      jobs: number | undefined;
      retries: number;
      ratio: number | undefined;
      arch: 'x64' | 'arm64' | undefined;
      channel: 'release' | 'beta';
      name: string;
      out: string | undefined;
      only: string[];
      waitLock: number | undefined;
      yes: boolean;
    }>();
  },
});

function raw(
  options: RawInvocation['options'] = {},
  args: RawInvocation['args'] = {},
  given: string[] = Object.keys(options)
): RawInvocation {
  return { options, args, given: (key) => given.includes(key) };
}

function resolved(invocation: RawInvocation): ReturnType<typeof resolveInvocation> {
  return resolveInvocation(build, invocation, '/work');
}

describe('defineCommand', () => {
  it('fills in what a declaration leaves out', () => {
    const bare = defineCommand({ name: 'status', summary: 'Show status' });
    expect(bare).toMatchObject({
      args: {},
      options: {},
      constraints: {},
      json: false,
      verdict: false,
      hidden: false,
      subcommands: [],
      run: undefined,
    });
  });

  it('spells flags in kebab case', () => {
    expect(kebabCase('waitLock')).toBe('wait-lock');
    expect(kebabCase('ui')).toBe('ui');
    expect(kebabCase('maxOldSpaceSize')).toBe('max-old-space-size');
  });
});

describe('lockWaitMs', () => {
  it('waits two hours by default, the given seconds otherwise, and not at all for zero', () => {
    expect(lockWaitMs(undefined)).toBe(7_200_000);
    expect(lockWaitMs(45)).toBe(45_000);
    expect(lockWaitMs(0)).toBe(0);
  });
});

describe('resolveInvocation', () => {
  it('converts every value through its declaration and fills defaults', () => {
    const { args, opts } = resolved(
      raw(
        {
          ui: true,
          jobs: '8',
          ratio: '0.5',
          arch: 'arm64',
          name: 'nightly',
          out: 'dist/out',
          only: ['a', 'b'],
        },
        { target: 'tests', paths: ['browser', 'toolkit'] }
      )
    );
    expect(args).toEqual({ target: 'tests', paths: ['browser', 'toolkit'] });
    expect(opts).toEqual({
      ui: true,
      full: false,
      color: true,
      jobs: 8,
      retries: 2,
      ratio: 0.5,
      arch: 'arm64',
      channel: 'release',
      name: 'nightly',
      out: resolve('/work/dist/out'),
      only: ['a', 'b'],
      waitLock: undefined,
      yes: false,
    });
  });

  it('reads absent arguments as undefined or empty, and a negated flag as false', () => {
    const { args, opts } = resolved(raw({ name: 'x', color: false }));
    expect(args).toEqual({ target: undefined, paths: [] });
    expect(opts['color']).toBe(false);
  });

  it.each([
    [{ name: 'x', jobs: '0' }, '--jobs must be an integer between 1 and 64 (got "0")'],
    [{ name: 'x', jobs: '2.5' }, '--jobs must be an integer between 1 and 64 (got "2.5")'],
    [{ name: 'x', jobs: 'many' }, '--jobs must be an integer between 1 and 64 (got "many")'],
    [{ name: 'x', jobs: '' }, '--jobs must be an integer between 1 and 64 (got "")'],
    [{ name: 'x', retries: 'two' }, '--retries must be an integer (got "two")'],
    [
      { name: 'x', jobs: '2', ratio: '1.5' },
      '--ratio must be a number between 0 and 1 (got "1.5")',
    ],
    [{ name: 'x', arch: 'mips' }, '--arch must be one of: x64, arm64 (got "mips")'],
    [
      { name: 'x', waitLock: '-1' },
      '--wait-lock must be an integer between 0 and 86400 (got "-1")',
    ],
    [{}, '--name is required'],
  ])('refuses %j', (options, message) => {
    expect(() => resolved(raw(options))).toThrow(
      expect.objectContaining({ code: 'invalid-argument', exitCode: 8, message }) as Error
    );
  });

  it('refuses an argument outside its choices, by its usage name', () => {
    expect(() => resolved(raw({ name: 'x' }, { target: 'docs' }))).toThrow(
      '<target> must be one of: browser, tests (got "docs")'
    );
  });

  it('enforces the declared combinations on what was actually given', () => {
    expect(() => resolved(raw({ name: 'x', ui: true, full: true }))).toThrow(
      '--ui, --full cannot be used together'
    );
    expect(() => resolved(raw({ name: 'x', ratio: '0.5' }))).toThrow('--ratio requires --jobs');
    // A default is not "given": `--color` defaults on and conflicts with nothing.
    expect(() =>
      resolved(raw({ name: 'x', ui: true, full: false }, {}, ['name', 'ui']))
    ).not.toThrow();
  });

  it('supports "either X or Y" across options and arguments', () => {
    const remove = defineCommand({
      name: 'remove',
      summary: 'Remove patches',
      args: {
        patch: arg.string('Patch to remove', { optional: true }),
        rest: arg.list('More', { required: false }),
      },
      options: { all: opt.flag('Remove every patch'), force: opt.flag('Skip checks') },
      constraints: { oneOf: [['patch', 'all']] },
    });
    const run = (options: RawInvocation['options'], args: RawInvocation['args']): unknown =>
      resolveInvocation(remove, raw(options, args), '/work');
    expect(() => run({}, {})).toThrow('One of <patch>, --all is required');
    expect(() => run({ all: true }, { patch: '001' })).toThrow(
      '<patch>, --all cannot be used together'
    );
    expect(run({ all: true }, {})).toMatchObject({ opts: { all: true, force: false } });
    expect(run({}, { patch: '001' })).toMatchObject({ args: { patch: '001' } });
  });

  it('requires a required argument and at least one value of a required list', () => {
    const add = defineCommand({
      name: 'add',
      summary: 'Add files',
      args: {
        name: arg.string('Name'),
        file: arg.path('File'),
        files: arg.list('Files', { required: true }),
      },
    });
    expect(() => resolveInvocation(add, raw(), '/work')).toThrow('<name> is required');
    expect(() => resolveInvocation(add, raw({}, { name: 'n', file: 'a' }), '/work')).toThrow(
      '<files> is required'
    );
    expect(
      resolveInvocation(add, raw({}, { name: 'n', file: 'a/b', files: ['c'] }), '/work').args
    ).toEqual({
      name: 'n',
      file: resolve('/work/a/b'),
      files: ['c'],
    });
  });
});
