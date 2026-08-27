// SPDX-License-Identifier: EUPL-1.2
import { rm, stat } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { warn } from '../../utils/logger.js';
import { withXpcshellProfileDir, XPCSHELL_PROFILE_ENV_VAR } from '../xpcshell-profile-dir.js';

async function pathExistsOnDisk(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('withXpcshellProfileDir', () => {
  const savedEnv = process.env[XPCSHELL_PROFILE_ENV_VAR];

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['XPCSHELL_TEST_PROFILE_DIR'];
    else process.env[XPCSHELL_PROFILE_ENV_VAR] = savedEnv;
    vi.clearAllMocks();
  });

  it('mints a fresh fireforge-prefixed dir that exists during fn and is removed after', async () => {
    delete process.env['XPCSHELL_TEST_PROFILE_DIR'];
    let seenDir = '';
    await withXpcshellProfileDir({ FOO: 'bar' }, async (env) => {
      seenDir = env[XPCSHELL_PROFILE_ENV_VAR] ?? '';
      expect(seenDir).toContain('fireforge-xpcshell-profile-');
      expect(env['FOO']).toBe('bar');
      await expect(pathExistsOnDisk(seenDir)).resolves.toBe(true);
    });
    await expect(pathExistsOnDisk(seenDir)).resolves.toBe(false);
  });

  it('mints a UNIQUE dir per invocation', async () => {
    delete process.env['XPCSHELL_TEST_PROFILE_DIR'];
    const dirs: string[] = [];
    for (let i = 0; i < 2; i++) {
      await withXpcshellProfileDir(undefined, (env) => {
        dirs.push(env[XPCSHELL_PROFILE_ENV_VAR] ?? '');
        return Promise.resolve();
      });
    }
    expect(dirs[0]).not.toBe(dirs[1]);
  });

  it('removes the dir when fn throws', async () => {
    delete process.env['XPCSHELL_TEST_PROFILE_DIR'];
    let seenDir = '';
    await expect(
      withXpcshellProfileDir(undefined, (env) => {
        seenDir = env[XPCSHELL_PROFILE_ENV_VAR] ?? '';
        return Promise.reject(new Error('boom'));
      })
    ).rejects.toThrow('boom');
    await expect(pathExistsOnDisk(seenDir)).resolves.toBe(false);
  });

  it('respects an operator-provided value verbatim and never deletes it', async () => {
    delete process.env['XPCSHELL_TEST_PROFILE_DIR'];
    await withXpcshellProfileDir({ [XPCSHELL_PROFILE_ENV_VAR]: '/operator/profile' }, (env) => {
      expect(env[XPCSHELL_PROFILE_ENV_VAR]).toBe('/operator/profile');
      return Promise.resolve();
    });

    process.env[XPCSHELL_PROFILE_ENV_VAR] = '/process/env/profile';
    await withXpcshellProfileDir(undefined, (env) => {
      expect(env[XPCSHELL_PROFILE_ENV_VAR]).toBe('/process/env/profile');
      return Promise.resolve();
    });
  });

  it('warns instead of throwing when cleanup fails', async () => {
    delete process.env['XPCSHELL_TEST_PROFILE_DIR'];
    // Force a REAL cleanup failure: a child file inside a directory whose
    // permission bits forbid unlinking (no write/execute on the dir).
    const { chmod, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    let seenDir = '';
    await expect(
      withXpcshellProfileDir(undefined, async (env) => {
        seenDir = env[XPCSHELL_PROFILE_ENV_VAR] ?? '';
        await writeFile(join(seenDir, 'held.txt'), 'x');
        await chmod(seenDir, 0o444);
        return 'ok';
      })
    ).resolves.toBe('ok');
    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      expect.stringContaining('Could not clean up xpcshell profile dir')
    );
    await chmod(seenDir, 0o755);
    await rm(seenDir, { recursive: true, force: true });
  });
});
