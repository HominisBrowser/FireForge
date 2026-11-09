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
    vi.mocked(pathExists).mockImplementation((path) => Promise.resolve(path === ENGINE_PRETTIER));
  });

  it('does nothing when the gate is off', async () => {
    expect(await invokePatchLintPrettier('/engine', '/project', FILES, 'off')).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('does nothing when the patch owns no modules', async () => {
    expect(await invokePatchLintPrettier('/engine', '/project', [], 'warning')).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  // The pass exists so the check resolves config and ignore rules the way
  // it does for someone standing in engine/. A root-level run
  // reports a false pass when the root .prettierignore excludes engine/.
  it('runs prettier with cwd set to the engine directory', async () => {
    vi.mocked(exec).mockResolvedValue(execResult(0));
    await invokePatchLintPrettier('/engine', '/project', FILES, 'warning');
    expect(exec).toHaveBeenCalledWith(
      ENGINE_PRETTIER,
      ['--check', ...FILES],
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

  it('uses only the project formatter when the engine has none', async () => {
    const projectPrettier = join('/project', 'node_modules', '.bin', 'prettier');
    vi.mocked(pathExists).mockImplementation((path) => Promise.resolve(path === projectPrettier));
    vi.mocked(exec).mockResolvedValue(execResult(0));
    expect(await invokePatchLintPrettier('/engine', '/project', FILES, 'error')).toEqual([]);
    expect(exec).toHaveBeenCalledWith(projectPrettier, ['--check', ...FILES], expect.anything());
  });

  it('refuses a missing formatter without invoking npx or downloading tools', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);
    const issues = await invokePatchLintPrettier('/engine', '/project', FILES, 'error');
    expect(issues).toEqual([expect.objectContaining({ file: '(prettier)', severity: 'error' })]);
    expect(issues[0]?.message).toContain('No installed project or engine formatter');
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'npm error: could not determine executable',
    '[warn] unknown formatter warning',
    '[warn] browser/modules/not-selected.sys.mjs',
  ])('refuses unexplained exit 1: %s', async (output) => {
    vi.mocked(exec).mockResolvedValue(execResult(1, output));
    const issues = await invokePatchLintPrettier('/engine', '/project', FILES, 'error');
    expect(issues).toEqual([
      expect.objectContaining({
        file: '(prettier)',
        severity: 'error',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
        message: expect.stringContaining('inconclusive'),
      }),
    ]);
  });

  it('retains recognized diagnostics and adds a tooling issue for mixed error output', async () => {
    vi.mocked(exec).mockResolvedValue(
      execResult(1, '[warn] browser/modules/a.sys.mjs\nnpm error: formatter failed\n')
    );
    const issues = await invokePatchLintPrettier('/engine', '/project', FILES, 'warning');
    expect(issues.map((issue) => issue.file)).toEqual(['browser/modules/a.sys.mjs', '(prettier)']);
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
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
