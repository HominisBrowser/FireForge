// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerJob } from '../job.js';
import { runJob } from '../job-run.js';

vi.mock('../job-run.js', () => ({ runJob: vi.fn(), keptProfile: vi.fn() }));
vi.mock('../job-support.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../job-support.js')>()),
  assertSourceMode: vi.fn(),
  printJob: vi.fn(),
  exitWithState: vi.fn(),
}));
vi.mock('../../core/jobs/guard.js', () => ({ coordinatorNamespace: () => '/private/default' }));

async function jobRun(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerJob(program, {
    getProjectRoot: () => '/editor',
    withErrorHandling: (handler) => handler,
  });
  await program.parseAsync(['node', 'fireforge', 'job', 'run', ...args]);
}

const shapeOf = (): unknown => vi.mocked(runJob).mock.calls[0]?.[0].shape;

describe('job run test repetition and order', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(runJob).mockResolvedValue({ state: 'passed' } as never);
  });

  it('passes --repeat and --shuffle to the test step as its own arguments', async () => {
    await jobRun('--test', 'browser/a.js', '--repeat', '3', '--shuffle', '42');
    expect(shapeOf()).toEqual({ args: ['--repeat', '3', '--shuffle', '42'] });
  });

  it('adds nothing when neither is named', async () => {
    await jobRun('--test', 'browser/a.js');
    expect(shapeOf()).toEqual({});
  });

  it.each([
    ['--repeat', '0'],
    ['--repeat', 'x'],
    ['--shuffle', '-1'],
  ])('refuses %s %s', async (flag, value) => {
    await expect(jobRun('--test', 'a.js', flag, value)).rejects.toThrow(/whole number/);
  });

  it.each(['--repeat', '--shuffle'])(
    '%s describes how tests run, so it needs --test',
    async (flag) => {
      await expect(jobRun(flag, '2')).rejects.toThrow(/name them with --test/);
    }
  );
});

describe('job run --allow-dirty-root', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(runJob).mockResolvedValue({ state: 'passed' } as never);
  });

  it('is passed to the capture, and absent without it', async () => {
    await jobRun('--check', '--allow-dirty-root');
    expect(vi.mocked(runJob).mock.calls[0]?.[0]).toMatchObject({ allowDirtyRoot: true });
    vi.mocked(runJob).mockClear();
    await jobRun('--check');
    expect(vi.mocked(runJob).mock.calls[0]?.[0]).not.toHaveProperty('allowDirtyRoot');
  });
});
