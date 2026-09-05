// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pathExists } from '../../utils/fs.js';
import { exec } from '../../utils/process.js';
import { invokePatchLintPrettier } from '../patch-lint-prettier.js';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));
vi.mock('../../utils/fs.js', () => ({ pathExists: vi.fn(() => Promise.resolve(false)) }));
vi.mock('../../utils/logger.js', () => ({ verbose: vi.fn() }));

const FILES = ['browser/modules/a.sys.mjs', 'browser/modules/b.sys.mjs'];

// The resolver builds this with the host's separator, so the expectation
// must too or a Windows runner fails on `\` alone.
const ENGINE_PRETTIER = join('/engine', 'node_modules', '.bin', 'prettier');

function execResult(
  exitCode: number,
  stderr = ''
): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: '', stderr, exitCode };
}

describe('invokePatchLintPrettier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(false);
  });

  it('does nothing when the gate is off', async () => {
    expect(await invokePatchLintPrettier('/engine', '/project', FILES, 'off')).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('does nothing when the patch owns no modules', async () => {
    expect(await invokePatchLintPrettier('/engine', '/project', [], 'warning')).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  // The whole point of the pass: the check must resolve config and ignore
  // rules the way it does for someone standing in engine/. A root-level run
  // reports a false pass when the root .prettierignore excludes engine/.
  it('runs prettier with cwd set to the engine directory', async () => {
    vi.mocked(exec).mockResolvedValue(execResult(0));
    await invokePatchLintPrettier('/engine', '/project', FILES, 'warning');
    expect(exec).toHaveBeenCalledWith(
      'npx',
      ['--no-install', 'prettier', '--check', ...FILES],
      expect.objectContaining({ cwd: '/engine' })
    );
  });

  it('prefers a prettier installed in the engine tree', async () => {
    vi.mocked(pathExists).mockImplementation((p: string) => Promise.resolve(p === ENGINE_PRETTIER));
    vi.mocked(exec).mockResolvedValue(execResult(0));
    await invokePatchLintPrettier('/engine', '/project', FILES, 'warning');
    expect(exec).toHaveBeenCalledWith(
      ENGINE_PRETTIER,
      ['--check', ...FILES],
      expect.objectContaining({ cwd: '/engine' })
    );
  });

  it('reports nothing when everything is formatted', async () => {
    vi.mocked(exec).mockResolvedValue(execResult(0));
    expect(await invokePatchLintPrettier('/engine', '/project', FILES, 'warning')).toEqual([]);
  });

  it('reports one issue per named file and drops the summary line', async () => {
    vi.mocked(exec).mockResolvedValue(
      execResult(
        1,
        '[warn] browser/modules/a.sys.mjs\n[warn] Code style issues found in the above file. Run Prettier to fix.\n'
      )
    );
    const issues = await invokePatchLintPrettier('/engine', '/project', FILES, 'warning');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe('browser/modules/a.sys.mjs');
    expect(issues[0]?.check).toBe('prettier-format');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('prettier --write');
  });

  it("honours an 'error' gate", async () => {
    vi.mocked(exec).mockResolvedValue(execResult(1, '[warn] browser/modules/a.sys.mjs\n'));
    const issues = await invokePatchLintPrettier('/engine', '/project', FILES, 'error');
    expect(issues[0]?.severity).toBe('error');
  });

  // Exit 2 is prettier failing (bad config, unparseable file). Reporting it
  // as formatting drift would send the operator to `--write`, which cannot
  // fix it.
  it('distinguishes a prettier failure from formatting drift', async () => {
    vi.mocked(exec).mockResolvedValue(execResult(2, 'SyntaxError: Unexpected token\n'));
    const issues = await invokePatchLintPrettier('/engine', '/project', FILES, 'warning');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe('(prettier)');
    expect(issues[0]?.message).toContain('exited 2');
  });

  it('reports a spawn failure as a run-level issue', async () => {
    vi.mocked(exec).mockRejectedValue(new Error('ENOENT'));
    const issues = await invokePatchLintPrettier('/engine', '/project', FILES, 'warning');
    expect(issues[0]?.file).toBe('(prettier)');
    expect(issues[0]?.message).toContain('could not be run');
  });
});
