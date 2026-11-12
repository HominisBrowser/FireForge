// SPDX-License-Identifier: EUPL-1.2
/**
 * The program end to end, in-process: real parsing, real help, the real error
 * boundary, with commands declared for the test.
 */
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ExitCode, FireForgeError, invariant } from '../kernel/errors.js';
import * as log from '../kernel/log.js';
import { type CliResult, runCli } from '../testing/cli.js';
import { arg, type Command, defineCommand, lockOptions, opt } from './command.js';

const strip = stripVTControlCharacters;

function received(result: CliResult): unknown {
  return JSON.parse(result.stdout);
}

const echo = defineCommand({
  name: 'echo',
  summary: 'Print what was parsed',
  description: 'Prints the parsed arguments and options as JSON.',
  group: 'Diagnostics',
  json: true,
  args: { first: arg.string('First word', { optional: true }), rest: arg.list('Remaining words') },
  options: {
    loud: opt.flag('Shout', { short: 'l' }),
    color: opt.flag('Colour', { negatable: true, default: true }),
    times: opt.integer('Repetitions', { short: 'n', min: 1, default: 1 }),
    mode: opt.enum(['a', 'b'], 'Mode'),
    out: opt.path('Output file'),
    tag: opt.list('Tags', { short: 't' }),
    secret: opt.string('Not shown', { hidden: true }),
    version: opt.string('A version of its own'),
    ...lockOptions,
  },
  run: (ctx, args, opts) => {
    ctx.out.json({
      args,
      opts,
      cwd: ctx.cwd,
      interactive: ctx.interactive,
      verbose: log.isVerbose(),
    });
    ctx.out.line(`first=${args.first ?? ''}`);
  },
});

const fail = defineCommand({
  name: 'fail',
  summary: 'Fail in a chosen way',
  group: 'Diagnostics',
  json: true,
  args: { how: arg.enum(['known', 'internal', 'unexpected', 'after-json'], 'Kind of failure') },
  run: (ctx, args) => {
    if (args.how === 'known') {
      throw new FireForgeError('engine-missing', 'There is no engine here.', {
        exitCode: ExitCode.BUILD_ERROR,
        hint: 'Run "fireforge setup" first.',
        cause: new Error('ENOENT: engine/'),
      });
    }
    if (args.how === 'after-json') {
      ctx.out.json({ dirty: 3 });
      throw new FireForgeError('dirty', 'The tree is dirty.');
    }
    invariant(args.how !== 'internal', 'manifest order is contiguous');
    throw new TypeError('cannot read properties of undefined');
  },
});

const judge = defineCommand({
  name: 'judge',
  summary: 'End with a verdict',
  group: 'Engine',
  verdict: true,
  json: true,
  options: { pass: opt.flag('Pass'), crash: opt.flag('Throw before the verdict') },
  run: (ctx, _args, opts) => {
    ctx.out.line('ran 3 checks');
    if (opts.crash) throw new FireForgeError('lock-timeout', 'Timed out.', { exitCode: 15 });
    ctx.out.verdict(opts.pass, opts.pass ? { checks: 3 } : { reason: 'test-failures' });
    ctx.out.json({ verdict: opts.pass ? 'pass' : 'fail' });
    if (!opts.pass) throw new FireForgeError('test-failures', '1 test failed.', { exitCode: 5 });
  },
});

const patch = defineCommand({
  name: 'patch',
  summary: 'Work with patches',
  group: 'Engine',
  subcommands: [
    defineCommand({
      name: 'list',
      summary: 'List patches',
      run: (ctx) => {
        ctx.out.line('001-a.patch');
      },
    }),
  ],
});

const hidden = defineCommand({
  name: 'internal-thing',
  summary: 'Not listed',
  hidden: true,
  run: () => undefined,
});

const commands: readonly Command[] = [echo, fail, judge, patch, hidden];

function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return runCli(args, { cwd: '/work', env, commands });
}

describe('parsing', () => {
  it('hands run the typed values of every kind of option and argument', async () => {
    const result = await cli([
      'echo',
      'one',
      'two',
      '-l',
      '--no-color',
      '-n',
      '3',
      '--mode',
      'b',
      '--out',
      'x/y.json',
      '-t',
      'a',
      '--tag',
      'b',
      '--version',
      '140',
      '--wait-lock',
      '30',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(received(result)).toEqual({
      schemaVersion: 1,
      args: { first: 'one', rest: ['two'] },
      opts: {
        loud: true,
        color: false,
        times: 3,
        mode: 'b',
        out: resolve('/work/x/y.json'),
        tag: ['a', 'b'],
        version: '140',
        waitLock: 30,
      },
      cwd: '/work',
      interactive: false,
      verbose: false,
    });
  });

  it('applies defaults, and passes everything after -- through untouched', async () => {
    const result = await cli(['echo', '--json', '--', '--loud', '--json', '-x']);
    expect(received(result)).toMatchObject({
      args: { first: '--loud', rest: ['--json', '-x'] },
      opts: { loud: false, color: true, times: 1, tag: [] },
    });
  });

  it('reads an option from its environment variable, and prefers the command line', async () => {
    expect(received(await cli(['echo', '--json'], { FIREFORGE_WAIT_LOCK: '45' }))).toMatchObject({
      opts: { waitLock: 45 },
    });
    expect(
      received(await cli(['echo', '--json', '--wait-lock', '5'], { FIREFORGE_WAIT_LOCK: '45' }))
    ).toMatchObject({
      opts: { waitLock: 5 },
    });
    const invalid = await cli(['echo'], { FIREFORGE_WAIT_LOCK: 'soon' });
    expect(invalid.exitCode).toBe(8);
    expect(strip(invalid.stderr)).toContain(
      '--wait-lock must be an integer between 0 and 86400 (got "soon")'
    );
  });

  it('turns on debug output from either position of --verbose', async () => {
    expect(received(await cli(['--verbose', 'echo', '--json']))).toMatchObject({ verbose: true });
    expect(received(await cli(['echo', '-v', '--json']))).toMatchObject({ verbose: true });
  });

  it('reads --json and --verbose given as an option value as that value', async () => {
    const result = await cli(['echo', 'hi', '--secret', '--json', '--version', '-v']);
    expect(result.stdout).toBe('first=hi\n');
  });

  it('writes human lines without --json', async () => {
    const result = await cli(['echo', 'hello']);
    expect(result).toEqual({ exitCode: 0, stdout: 'first=hello\n', stderr: '' });
  });

  it('runs a nested command', async () => {
    expect((await cli(['patch', 'list'])).stdout).toBe('001-a.patch\n');
  });
});

describe('usage errors', () => {
  it.each([
    [['echo', '--bogus'], "unknown option '--bogus'"],
    [['nope'], "unknown command 'nope'"],
    [['echo', '--times'], "option '-n, --times <n>' argument missing"],
    [['fail', 'known', 'extra'], 'too many arguments'],
    [['echo', '--times', 'x'], '--times must be an integer of at least 1 (got "x")'],
    [['echo', '--mode', 'c'], '--mode must be one of: a, b (got "c")'],
    [['fail'], '<how> is required'],
  ])('%j exits 8 naming the problem', async (args, message) => {
    const result = await cli(args);
    expect(result.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(result.stdout).toBe('');
    expect(strip(result.stderr)).toContain(message);
  });

  it('prints parser and declaration refusals in the form of every failure', async () => {
    expect(strip((await cli(['echo', '--bogus'])).stderr)).toMatch(
      /^error\[invalid-argument\]: unknown option '--bogus'\n/
    );
    expect(strip((await cli(['echo', '--times', 'x'])).stderr)).toBe(
      'error[invalid-argument]: --times must be an integer of at least 1 (got "x")\n'
    );
  });

  it('suggests the nearest command and option', async () => {
    expect((await cli(['ecoh'])).stderr).toContain('Did you mean echo?');
    expect((await cli(['echo', '--lod'])).stderr).toContain('Did you mean --loud?');
  });

  it('answers with the failure envelope under --json, for parser and declaration refusals alike', async () => {
    const parser = await cli(['echo', '--bogus', '--json']);
    expect(parser.exitCode).toBe(8);
    expect(received(parser)).toEqual({
      schemaVersion: 1,
      error: "unknown option '--bogus'",
      code: 'invalid-argument',
    });
    const declared = await cli(['echo', '--json', '--times', '0']);
    expect(received(declared)).toEqual({
      schemaVersion: 1,
      error: '--times must be an integer of at least 1 (got "0")',
      code: 'invalid-argument',
    });
  });
});

describe('help and version', () => {
  it('prints the version only when no command is named', async () => {
    const version = await cli(['--version']);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect((await cli(['--verbose', '-V'])).stdout).toBe(version.stdout);
    expect(received(await cli(['echo', '--version', '152', '--json']))).toMatchObject({
      opts: { version: '152' },
    });
  });

  it('groups the root help by heading, in declaration order, without hidden commands', async () => {
    const result = await cli(['--help']);
    expect(result.exitCode).toBe(0);
    const help = result.stdout;
    expect(help).toContain('Usage: fireforge [options] [command]');
    expect(help).toMatch(
      /Diagnostics:\n\s+echo \[options\] \[first\] \[rest\.\.\.\]\s+Print what was parsed\n\s+fail/
    );
    expect(help).toMatch(
      /Engine:\n\s+judge \[options\]\s+End with a verdict\n\s+patch\s+Work with patches/
    );
    expect(help.indexOf('Diagnostics:')).toBeLessThan(help.indexOf('Engine:'));
    expect(help).not.toContain('internal-thing');
    expect(help).toContain('-V, --version');
  });

  it('describes a command from its declaration', async () => {
    const help = (await cli(['echo', '--help'])).stdout;
    expect(help).toContain('Prints the parsed arguments and options as JSON.');
    expect(help).toMatch(/-n, --times <n>\s+Repetitions \(default 1\)/);
    expect(help).toMatch(/--mode <choice>\s+Mode \(one of: a, b\)/);
    expect(help).toMatch(/--color\s+Colour \(on by default\)/);
    expect(help).toMatch(/--no-color\s+Turn off --color/);
    expect(help).toMatch(/-l, --loud\s+Shout\n/);
    expect(help).toMatch(
      /--wait-lock <seconds>\s+Wait up to this many seconds[\s\S]*env:\s+FIREFORGE_WAIT_LOCK/
    );
    expect(help).toMatch(/--json\s+Write the result as one JSON document/);
    expect(help).toMatch(/first\s+First word/);
    expect(help).not.toContain('--secret');
  });

  it('shows help, successfully, for the bare program and for a command group', async () => {
    const bare = await cli([]);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout + bare.stderr).toContain('Usage: fireforge');
    const group = await cli(['patch']);
    expect(group.exitCode).toBe(0);
    expect(group.stdout + group.stderr).toMatch(
      /Usage: fireforge patch[\s\S]*list \[options\]\s+List patches/
    );
  });
});

describe('the error boundary', () => {
  it('prints a known failure as error[code], message and hint, with its exit code and no stack', async () => {
    const result = await cli(['fail', 'known']);
    expect(result.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(result.stdout).toBe('');
    expect(strip(result.stderr)).toBe(
      'error[engine-missing]: There is no engine here.\nhint: Run "fireforge setup" first.\n'
    );
  });

  it('adds the cause chain under --verbose', async () => {
    const result = await cli(['fail', 'known', '--verbose']);
    expect(strip(result.stderr)).toContain('debug: Caused by: Error: ENOENT: engine/');
  });

  it('writes the failure envelope under --json and still explains on stderr', async () => {
    const result = await cli(['fail', 'known', '--json']);
    expect(result.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(received(result)).toEqual({
      schemaVersion: 1,
      error: 'There is no engine here.',
      code: 'engine-missing',
      hint: 'Run "fireforge setup" first.',
    });
    expect(strip(result.stderr)).toContain('error[engine-missing]: There is no engine here.');
  });

  it('never appends an envelope to a document the command already wrote', async () => {
    const result = await cli(['fail', 'after-json', '--json']);
    expect(result.exitCode).toBe(1);
    expect(received(result)).toEqual({ schemaVersion: 1, dirty: 3 });
  });

  it('reports an invariant failure as a bug, with a stack and where to report it', async () => {
    const result = await cli(['fail', 'internal']);
    expect(result.exitCode).toBe(ExitCode.INTERNAL_ERROR);
    const stderr = strip(result.stderr);
    expect(stderr).toContain('error[internal]: Internal error: manifest order is contiguous');
    expect(stderr).toContain('This is a bug in FireForge');
    expect(stderr).toContain('/issues');
    expect(stderr).toMatch(/\n\s+at /);
  });

  it('reports anything else as unexpected, with a stack', async () => {
    const result = await cli(['fail', 'unexpected', '--json']);
    expect(result.exitCode).toBe(1);
    expect(received(result)).toMatchObject({
      code: 'unexpected-error',
      error: 'cannot read properties of undefined',
    });
    expect(strip(result.stderr)).toMatch(
      /^error\[unexpected-error\]: Unexpected error: cannot read properties of undefined\nTypeError: /
    );
  });
});

describe('verdict commands', () => {
  it('end stdout with the verdict line on a pass', async () => {
    const result = await cli(['judge', '--pass']);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'ran 3 checks\nFIREFORGE-VERDICT: PASS checks=3\n',
    });
  });

  it('keep the verdict last when the command then fails', async () => {
    const result = await cli(['judge']);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe('ran 3 checks\nFIREFORGE-VERDICT: FAIL reason=test-failures\n');
    expect(strip(result.stderr)).toBe('error[test-failures]: 1 test failed.\n');
  });

  it('get a failing verdict from the boundary when they throw before writing one', async () => {
    const result = await cli(['judge', '--crash']);
    expect(result.exitCode).toBe(15);
    expect(result.stdout).toBe('ran 3 checks\nFIREFORGE-VERDICT: FAIL reason=lock-timeout\n');
  });

  it('write the document and no verdict line under --json', async () => {
    const result = await cli(['judge', '--pass', '--json']);
    expect(result.stdout).toBe('{"schemaVersion":1,"verdict":"pass"}\n');
  });
});
