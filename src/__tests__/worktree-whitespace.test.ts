// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, runGit } from '../test-utils/index.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'check-worktree-whitespace.mjs');

/**
 * The script's environment, minus the PR base sha CI sets for the real
 * repository: that commit does not exist in the temp repo, so inheriting it
 * makes the script diff against a missing base and fail on every PR run.
 */
function scriptEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['WHITESPACE_CHECK_BASE'];
  return env;
}

async function writeRepoFile(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

describe('check-worktree-whitespace script', () => {
  let projectRoot: string | undefined;

  afterEach(async () => {
    if (projectRoot) {
      await removeTempProject(projectRoot);
      projectRoot = undefined;
    }
  });

  async function initRepo(): Promise<string> {
    projectRoot = await createTempProject('ff-whitespace-');
    await runGit(projectRoot, ['init']);
    await runGit(projectRoot, ['config', 'user.email', 'fireforge@example.test']);
    await runGit(projectRoot, ['config', 'user.name', 'FireForge Tests']);
    await writeRepoFile(projectRoot, 'README.md', 'clean\n');
    await runGit(projectRoot, ['add', '-A']);
    await runGit(projectRoot, ['commit', '-m', 'initial']);
    return projectRoot;
  }

  it('ignores patch syntax context whitespace under patches/*.patch', async () => {
    const root = await initRepo();
    await writeRepoFile(
      root,
      'patches/001-ui-test.patch',
      ['diff --git a/foo.js b/foo.js', '@@ -1 +1 @@', ' context line', '+changed', ''].join('\n')
    );

    const result = await execFileAsync(process.execPath, [scriptPath], {
      cwd: root,
      env: scriptEnv(),
    });
    expect(result.stdout).toContain('Whitespace check passed (worktree and index).');
  });

  it('fails on non-patch trailing whitespace', async () => {
    const root = await initRepo();
    await writeRepoFile(root, 'src/bad.js', 'const value = 1; \n');
    await runGit(root, ['add', 'src/bad.js']);

    let error: unknown;
    try {
      await execFileAsync(process.execPath, [scriptPath], { cwd: root, env: scriptEnv() });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { stdout?: string }).stdout).toContain('trailing whitespace');
  });
});
