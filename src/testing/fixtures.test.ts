// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  HOST_PYTHON,
  makeSyntheticFirefoxArchive,
  readMachLog,
  scriptMach,
  SYNTHETIC_FIREFOX_PATHS,
  writeSyntheticFirefox,
} from './firefox.js';
import { commitAll, git, initRepo } from './git.js';
import { readTree, useTempDir, writeTree } from './temp.js';

const run = promisify(execFile);
const dir = useTempDir();

describe('temporary git repositories', () => {
  it('start with one commit of the given files and a pinned identity', async () => {
    const first = await initRepo(dir(), { 'a.txt': 'a\n', 'sub/b.txt': 'b\n' });
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(dir(), ['log', '--format=%an <%ae> %s'])).trim()).toBe(
      'FireForge Tests <fireforge@example.test> initial'
    );
    expect((await git(dir(), ['status', '--porcelain'])).trim()).toBe('');
    await writeTree(dir(), { 'a.txt': 'changed\n' });
    const second = await commitAll(dir(), 'second');
    expect(second).not.toBe(first);
    expect(await readTree(dir())).toEqual({ 'a.txt': 'changed\n', 'sub/b.txt': 'b\n' });
  });
});

describe('the synthetic Firefox tree', () => {
  it('has a mach that records its calls, builds a stamp, and fails on request', async () => {
    await writeSyntheticFirefox(dir(), { 'browser/extra.js': '// extra\n' });
    // Windows has no executable bit.
    if (process.platform !== 'win32') {
      expect((await stat(join(dir(), 'mach'))).mode & 0o111).not.toBe(0);
    }
    const built = await run(HOST_PYTHON, ['mach', 'build', 'faster'], { cwd: dir() });
    expect(built.stdout).toBe('build complete\n');
    expect(await readFile(join(dir(), SYNTHETIC_FIREFOX_PATHS.buildStamp), 'utf8')).toContain(
      'faster'
    );
    await writeTree(dir(), { '.mach-state/fail-test': '' });
    await expect(run(HOST_PYTHON, ['mach', 'test', 'x'], { cwd: dir() })).rejects.toMatchObject({
      code: 1,
    });
    expect((await readMachLog(dir())).map((call) => call.args)).toEqual([
      ['build', 'faster'],
      ['test', 'x'],
    ]);
    expect(await readFile(join(dir(), 'browser/extra.js'), 'utf8')).toBe('// extra\n');
  });

  it('has a mach that follows a script and records its object directory', async () => {
    await writeSyntheticFirefox(dir());
    await scriptMach(dir(), 'build', { stdout: ['compiling'], stderr: ['warned'], exit: 3 });
    const failed = await run(HOST_PYTHON, ['mach', 'build'], {
      cwd: dir(),
      env: { ...process.env, MOZ_BUILD_DATE: '20000101000000' },
    }).catch((error: unknown) => error as { code: number; stdout: string; stderr: string });
    expect(failed).toMatchObject({ code: 3, stdout: 'compiling\n', stderr: 'warned\n' });
    expect((await readMachLog(dir()))[0]?.env['MOZ_BUILD_DATE']).toBe('20000101000000');
    const mozinfo = JSON.parse(
      await readFile(join(dir(), SYNTHETIC_FIREFOX_PATHS.mozinfo), 'utf8')
    ) as { topsrcdir: string; topobjdir: string };
    expect(mozinfo).toMatchObject({ topsrcdir: dir(), topobjdir: join(dir(), 'obj-fireforge') });

    await writeTree(dir(), {
      mozconfig: 'mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-other\n',
    });
    await run(HOST_PYTHON, ['mach', 'configure'], { cwd: dir() });
    // The stand-in writes the path as a Python literal, which doubles a backslash.
    expect(await readFile(join(dir(), 'obj-other/config.status'), 'utf8')).toContain(
      dir().replaceAll('\\', '\\\\')
    );
  });

  // Needs a `tar` that reads and writes xz.
  it.skipIf(process.platform === 'win32')(
    'packs as a source archive with one versioned top-level directory',
    async () => {
      const archive = await makeSyntheticFirefoxArchive(dir(), '140.9.0esr');
      const listing = (await run('tar', ['-tJf', archive])).stdout.split('\n').filter(Boolean);
      expect(listing.every((entry) => entry.startsWith('firefox-140.9.0esr/'))).toBe(true);
      expect(listing).toContain(`firefox-140.9.0esr/${SYNTHETIC_FIREFOX_PATHS.browserScript}`);
    }
  );
});
