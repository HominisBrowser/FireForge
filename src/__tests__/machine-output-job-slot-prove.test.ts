// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../cli.js';
import { handleParseError, wantsMachineOutput } from '../cli-usage-error.js';
import { readJob } from '../core/jobs/client.js';
import { removeSlot } from '../core/jobs/slot-lifecycle.js';
import { runSourceGuardHook } from '../core/source-guard.js';
import { CommandError, GeneralError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';

vi.mock('../core/source-guard.js', () => ({ runSourceGuardHook: vi.fn() }));
vi.mock('../core/tree-guard.js', () => ({ runTreeGuardHook: vi.fn() }));
vi.mock('../core/jobs/guard.js', () => ({
  coordinatorNamespace: () => '/private/test',
  assertJobAdmission: vi.fn(),
}));
vi.mock('../core/jobs/client.js', async (original) => ({
  ...(await original<typeof import('../core/jobs/client.js')>()),
  readJob: vi.fn(),
}));
vi.mock('../core/jobs/slot-lifecycle.js', () => ({ removeSlot: vi.fn() }));
const originalArgv = process.argv;
const JOB = '7d41b2c0-3333-4aaa-8bbb-000000000003';
let stdout: string[];
let stderr: string[];

async function run(...args: string[]): Promise<void> {
  process.argv = ['node', 'fireforge', ...args];
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error: unknown) {
    handleParseError(error, wantsMachineOutput());
  }
}

function onlyPayload(): unknown {
  const text = stdout.join('').trim();
  expect(text.split('\n')).toHaveLength(1);
  return JSON.parse(text);
}

beforeEach(() => {
  vi.resetAllMocks();
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' '));
  });
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('job, slot and prove explicit machine contracts', () => {
  it.each([
    ['job', 'submit'],
    ['slot', 'remove'],
    ['prove', 'accept', 'static'],
    ['job', 'status', 'one', '--bogus'],
    ['slot', 'list', '--bogus'],
    ['prove', 'status', '--bogus'],
  ])('returns one JSON usage refusal for %j', async (...args) => {
    await expect(run(...args, '--json')).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CommandError && error.exitCode === ExitCode.INVALID_ARGUMENT
    );
    expect(onlyPayload()).toMatchObject({
      schemaVersion: 1,
      code: 'invalid-argument',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
      error: expect.any(String),
    });
    expect(runSourceGuardHook).not.toHaveBeenCalled();
  });

  it.each([
    ['job', 'status', 'one'],
    ['slot', 'list'],
    ['prove', 'status'],
  ])('keeps pre-action admission refusal parseable for %j', async (...args) => {
    vi.mocked(runSourceGuardHook).mockRejectedValue(new GeneralError('immutable execution slot'));
    await expect(run(...args, '--json')).rejects.toBeInstanceOf(CommandError);
    expect(onlyPayload()).toEqual({
      schemaVersion: 1,
      code: 'general',
      error: 'immutable execution slot',
    });
    expect(stderr.join('')).toContain('immutable execution slot');
    expect(readJob).not.toHaveBeenCalled();
  });

  it('preserves the default job success document when --json enables refusal handling', async () => {
    vi.mocked(readJob).mockResolvedValue({
      schemaVersion: 1,
      id: JOB,
      state: 'running',
    } as never);
    await run('job', '--json', 'status', JOB);
    expect(onlyPayload()).toEqual({ schemaVersion: 1, id: JOB, state: 'running' });
  });

  it('returns one slot ownership refusal and no success payload', async () => {
    vi.mocked(removeSlot).mockRejectedValue(new GeneralError('slot still leased'));
    await expect(run('slot', 'remove', 'one', '--json')).rejects.toBeInstanceOf(CommandError);
    expect(onlyPayload()).toEqual({
      schemaVersion: 1,
      code: 'general',
      error: 'slot still leased',
    });
  });

  it('keeps the default JSON-producing job failure diagnostic on the text contract without --json', async () => {
    vi.mocked(readJob).mockRejectedValue(new GeneralError('coordinator refused'));
    await expect(run('job', 'status', JOB)).rejects.toBeInstanceOf(CommandError);
    expect(stdout.join('') + stderr.join('')).toContain('coordinator refused');
    expect(stdout.join('')).not.toContain('"schemaVersion"');
  });

  it.each(['authored', 'job', 'slot', 'host', 'prove'])('%s accepts --json', (group) => {
    const command = createProgram().commands.find((entry) => entry.name() === group);
    expect(command?.options.some((option) => option.long === '--json')).toBe(true);
  });
});
