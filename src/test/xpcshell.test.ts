// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exists } from '../kernel/fs.js';
import { useMachSandbox } from '../testing/engine.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  appPathArguments,
  PROFILE_ENV,
  repairStaleInstallLink,
  withProfileDir,
} from './xpcshell.js';

const dir = useTempDir();
useMachSandbox();
const TEST = 'browser/modules/test/unit/test_x.js';

/** An engine whose object directory says the build's appname, with the given layouts. */
async function engine(options: {
  appname?: string;
  manifest?: string;
  layouts?: ('bin' | 'bundle')[];
}): Promise<{ engineDir: string; objDir: string }> {
  const engineDir = join(dir(), 'engine');
  const objDir = join(engineDir, 'obj-fireforge');
  await writeTree(engineDir, {
    'browser/modules/test/unit/xpcshell.toml':
      options.manifest ?? '[DEFAULT]\nfirefox-appdir = "browser"\n\n["test_x.js"]\n',
    [TEST]: '',
    ...(options.appname === undefined
      ? {}
      : { 'obj-fireforge/mozinfo.json': JSON.stringify({ appname: options.appname }) }),
  });
  for (const layout of options.layouts ?? []) {
    await mkdir(
      layout === 'bin'
        ? join(objDir, 'dist/bin/browser')
        : join(objDir, 'dist/Fork.app/Contents/Resources/browser'),
      { recursive: true }
    );
  }
  return { engineDir, objDir };
}

describe('appPathArguments', () => {
  it('passes --app-path when a rebranded build meets a firefox-appdir manifest', async () => {
    const { engineDir, objDir } = await engine({ appname: 'fork', layouts: ['bin'] });
    expect(await appPathArguments(engineDir, objDir, [TEST], [])).toEqual([
      `--app-path=${join(objDir, 'dist/bin/browser')}`,
    ]);
  });

  it('prefers the layout of the platform when both exist', async () => {
    const { engineDir, objDir } = await engine({ appname: 'fork', layouts: ['bin', 'bundle'] });
    const expected =
      process.platform === 'darwin'
        ? 'dist/Fork.app/Contents/Resources/browser'
        : 'dist/bin/browser';
    expect(await appPathArguments(engineDir, objDir, [TEST], [])).toEqual([
      `--app-path=${join(objDir, expected)}`,
    ]);
  });

  it.each([
    ['a Firefox build', { appname: 'firefox', layouts: ['bin' as const] }],
    ['no mozinfo.json', { layouts: ['bin' as const] }],
    [
      'a manifest using the build key',
      {
        appname: 'fork',
        manifest: '[DEFAULT]\nfork-appdir = "browser"\nfirefox-appdir = "browser"\n["test_x.js"]\n',
        layouts: ['bin' as const],
      },
    ],
    ['no appdir key', { appname: 'fork', manifest: '["test_x.js"]\n', layouts: ['bin' as const] }],
    [
      'an appdir only inside a test section',
      {
        appname: 'fork',
        manifest: '["test_x.js"]\nfirefox-appdir = "browser"\n',
        layouts: ['bin' as const],
      },
    ],
    ['an appdir the build lacks', { appname: 'fork', layouts: [] }],
  ])('passes nothing for %s', async (_name, options) => {
    const { engineDir, objDir } = await engine(options);
    expect(await appPathArguments(engineDir, objDir, [TEST], [])).toEqual([]);
  });

  it('reads an unquoted value, and steps aside for a caller-given --app-path', async () => {
    const { engineDir, objDir } = await engine({
      appname: 'fork',
      manifest: '# comment\nfirefox-appdir = browser # trailing\n["test_x.js"]\n',
      layouts: ['bin'],
    });
    expect(await appPathArguments(engineDir, objDir, [TEST], [])).toHaveLength(1);
    expect(await appPathArguments(engineDir, objDir, [TEST], ['--app-path=/elsewhere'])).toEqual(
      []
    );
  });
});

describe('withProfileDir', () => {
  it('gives each invocation its own profile and removes it, keeping one the caller set', async () => {
    let seen = '';
    await withProfileDir({}, async (env) => {
      seen = env[PROFILE_ENV] ?? '';
      expect(await exists(seen)).toBe(true);
    });
    expect(seen.startsWith(tmpdir()) || seen.includes('fireforge-xpcshell-profile-')).toBe(true);
    expect(await exists(seen)).toBe(false);
    await withProfileDir({ [PROFILE_ENV]: '/kept' }, (env) => {
      expect(env[PROFILE_ENV]).toBe('/kept');
      return Promise.resolve();
    });
  });
});

describe('repairStaleInstallLink', () => {
  it('removes only a symlink inside the object directory _tests that the error names', async () => {
    const objDir = join(dir(), 'obj');
    const link = join(objDir, '_tests/xpcshell/browser/modules/test/unit/head.js');
    await mkdir(join(link, '..'), { recursive: true });
    await symlink('/nowhere', link);
    const outside = join(dir(), 'outside-link');
    await symlink('/nowhere', outside);
    const error = (path: string): string =>
      `FileExistsError: [Errno 17] File exists: '/src/head.js' -> '${path}'`;
    expect(await repairStaleInstallLink(objDir, 'no such error')).toBe(false);
    expect(await repairStaleInstallLink(objDir, error(outside))).toBe(false);
    expect(await repairStaleInstallLink(objDir, error(link))).toBe(true);
    expect(await readdir(join(link, '..'))).toEqual([]);
    expect(await exists(outside)).toBe(true);
  });
});
