// SPDX-License-Identifier: EUPL-1.2
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { makeEngineProject, makeProjectEngine, useMachSandbox } from '../testing/engine.js';
import { readMachLog, scriptMach } from '../testing/firefox.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { machFailure, runMach } from './mach.js';
import { machPythonRange } from './python.js';
import type { Workspace } from './workspace.js';

const dir = useTempDir();
const logged = useMachSandbox();

const workspace = async (): Promise<Workspace> => makeProjectEngine(await makeEngineProject(dir()));

describe('runMach', () => {
  it('runs mach in the engine with the arguments and environment given', async () => {
    const ws = await workspace();
    await writeTree(ws.engineDir, { '.mach-state/record-env': 'EXTRA PYTHONPATH\n' });
    const result = await runMach(ws, ['build', 'faster'], { env: { EXTRA: 'yes' } });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'build complete\n', timedOut: false });
    const [call] = await readMachLog(ws.engineDir);
    expect(call?.args).toEqual(['build', 'faster']);
    expect(call?.env['EXTRA']).toBe('yes');
    // The resource guard reaches mach before any virtualenv exists.
    expect(call?.env['PYTHONPATH']).toContain('fireforge-mach-guard');
  });

  it('hands every raw line to the caller and shows it on stderr, never stdout', async () => {
    const ws = await workspace();
    await scriptMach(ws.engineDir, 'test', {
      stdout: ['TEST-START one', 'TEST-UNEXPECTED-FAIL one'],
      stderr: ['Traceback'],
      exit: 1,
    });
    const lines: string[] = [];
    const result = await runMach(ws, ['test', 'x'], {
      onLine: (line, stream) => lines.push(`${stream}:${line}`),
    });
    expect(result.exitCode).toBe(1);
    expect(lines.sort()).toEqual([
      'stderr:Traceback',
      'stdout:TEST-START one',
      'stdout:TEST-UNEXPECTED-FAIL one',
    ]);
    expect(logged()).toContain('TEST-UNEXPECTED-FAIL one\n');
    expect(result.stdout).toBe('TEST-START one\nTEST-UNEXPECTED-FAIL one\n');
  });

  it('prints the known remedy when a failure is one it recognises', async () => {
    const ws = await workspace();
    await scriptMach(ws.engineDir, 'build', {
      stderr: ['ERROR: cbindgen version 0.29.1 is too old. At least version 0.29.4 is required.'],
      exit: 1,
    });
    await runMach(ws, ['build']);
    expect(logged()).toContain('fireforge bootstrap');
    const before = logged().length;
    await runMach(ws, ['build'], { hints: false });
    expect(logged().slice(before)).not.toContain('Hint:');
  });

  it('terminates mach at the deadline and reports it as a result', async () => {
    const ws = await workspace();
    await scriptMach(ws.engineDir, 'run', { stdout: ['started'], sleep: 30 });
    const result = await runMach(ws, ['run'], { timeoutMs: 1_500 });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('started\n');
    expect(machFailure('mach run', result)).toMatchObject({
      code: 'mach-failed',
      exitCode: ExitCode.BUILD_ERROR,
      message: 'mach run timed out',
    });
  });

  it('refuses an engine without mach', async () => {
    const ws = await workspace();
    await rm(join(ws.engineDir, 'mach'));
    await expect(runMach(ws, ['build'])).rejects.toMatchObject({ code: 'engine-missing' });
  });
});

describe('machPythonRange', () => {
  it.each([
    [
      'MIN_PYTHON_VERSION = (3, 9)\nMAX_PYTHON_VERSION_TO_CONSIDER = (3, 13)\n',
      { major: 3, min: 9, max: 13 },
    ],
    ['MIN_PYTHON_VERSION = (3, 9)\n', { major: 3, min: 8, max: 12 }],
    ['', { major: 3, min: 8, max: 12 }],
  ])('reads the range mach declares from %j', (source, expected) => {
    expect(machPythonRange(source)).toEqual(expected);
  });
});
