// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { hermeticGitEnvironment } from '../../git-hermetic.js';
import { qualifiedGitRuntime } from '../../qualified-git.js';
import { gitToolIdentity } from '../git-tools.js';
import { readAdmittedSnapshot } from '../guard.js';

vi.mock('../guard.js', () => ({ readAdmittedSnapshot: vi.fn() }));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it('binds actual Git/helper bytes despite unchanged version and excludes ambient configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-git-tools-'));
  directories.push(root);
  const bin = join(root, 'bin'),
    helpers = join(root, 'helpers');
  await mkdir(bin);
  await mkdir(helpers);
  const launcher = join(bin, 'git');
  await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' '${helpers}'\n`);
  await chmod(launcher, 0o755);
  await writeFile(join(helpers, 'git'), 'same-version-git-A');
  await writeFile(join(helpers, 'remote-helper'), 'helper-A');
  await symlink(launcher, join(helpers, 'launcher'));
  vi.stubEnv('PATH', bin);
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'foreign-config'));
  const first = await gitToolIdentity();
  expect(first.executable).toBe(await realpath(join(helpers, 'git')));
  await writeFile(join(helpers, 'remote-helper'), 'helper-B');
  expect((await gitToolIdentity()).digest).not.toBe(first.digest);
  await writeFile(join(helpers, 'git'), 'same-version-git-B');
  expect((await gitToolIdentity()).digest).not.toBe(first.digest);
  expect(hermeticGitEnvironment(helpers)).toMatchObject({
    GIT_EXEC_PATH: helpers,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_VALUE_0: 'false',
  });
  vi.stubEnv('PATH', join(root, 'missing'));
  await expect(gitToolIdentity()).rejects.toThrow(/unavailable/);
});

it('refuses an escaping helper alias and malformed launcher discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-git-tools-'));
  directories.push(root);
  const bin = join(root, 'bin'),
    helpers = join(root, 'helpers');
  await mkdir(bin);
  await mkdir(helpers);
  const launcher = join(bin, 'git');
  await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' '${helpers}'\n`);
  await chmod(launcher, 0o755);
  await writeFile(join(helpers, 'git'), 'git');
  await writeFile(join(root, 'outside'), 'foreign');
  await symlink(join(root, 'outside'), join(helpers, 'bad'));
  vi.stubEnv('PATH', bin);
  await expect(gitToolIdentity()).rejects.toThrow(/escapes declared root/);
  await rm(join(helpers, 'bad'));
  await writeFile(launcher, '#!/bin/sh\nexit 2\n');
  await expect(gitToolIdentity()).rejects.toThrow();
});

it('requires live admitted Git metadata and scopes reuse to one authenticated phase', async () => {
  vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
  expect(await qualifiedGitRuntime()).toBeUndefined();
  vi.stubEnv('FIREFORGE_JOB_TOKEN', 'git-fixture-token');
  vi.stubEnv('FIREFORGE_JOB_PHASE', 'missing');
  vi.mocked(readAdmittedSnapshot).mockResolvedValueOnce(
    {} as Awaited<ReturnType<typeof readAdmittedSnapshot>>
  );
  await expect(qualifiedGitRuntime()).rejects.toThrow(/qualified Git/);
  vi.stubEnv('FIREFORGE_JOB_PHASE', 'first');
  vi.stubEnv('FIREFORGE_EXECUTION_ROOT', '/private/slot');
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    gitExecutable: '/tools/git',
    gitExecPath: '/tools/helpers',
  } as Awaited<ReturnType<typeof readAdmittedSnapshot>>);
  const first = await qualifiedGitRuntime();
  expect(first?.executable).toBe('/tools/git');
  expect(first?.environment['GIT_EXEC_PATH']).toBe('/tools/helpers');
  expect(await qualifiedGitRuntime()).toBe(first);
  expect(readAdmittedSnapshot).toHaveBeenCalledTimes(2);
  vi.stubEnv('FIREFORGE_JOB_PHASE', 'second');
  await qualifiedGitRuntime();
  expect(readAdmittedSnapshot).toHaveBeenCalledTimes(3);
});
