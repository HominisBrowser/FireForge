// SPDX-License-Identifier: EUPL-1.2
/**
 * `download` through the CLI. The network is absent: the host cache already
 * holds the archive, and the project pins its digest, so nothing is fetched.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sourceArchive } from '../engine/index.js';
import { hashFile } from '../kernel/hash.js';
import { type CliResult, runCli } from '../testing/cli.js';
import { makeSyntheticFirefoxArchive } from '../testing/firefox.js';
import { git } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { download } from './download.js';

const dir = useTempDir();
const VERSION = '140.9.0esr';

interface Result {
  commit: string;
  pristine: string;
  engine: string | null;
  replaced: boolean;
  recovery: string | null;
}

/** A project whose pin is already in the host cache, and a runner for `download` in it. */
async function setUp(
  extra: Record<string, unknown> = {}
): Promise<(...args: string[]) => Promise<CliResult>> {
  const home = join(dir(), 'home');
  const packed = await makeSyntheticFirefoxArchive(join(dir(), 'mozilla'), VERSION);
  const sha256 = await hashFile(packed);
  const firefox = { version: VERSION, product: 'firefox-esr' as const, sha256 };
  const archive = sourceArchive({ ...firefox, allowUnverifiedDownload: false });
  await mkdir(join(home, 'cache'), { recursive: true });
  await copyFile(packed, join(home, 'cache', archive.filename));
  await writeFile(
    join(home, 'cache', `${archive.filename}.json`),
    JSON.stringify({
      url: archive.url,
      size: (await stat(packed)).size,
      sha256,
      verification: 'pinned',
      downloadedAt: '2000-01-01T00:00:00.000Z',
    })
  );
  await writeTree(join(dir(), 'project'), {
    'fireforge.json': JSON.stringify({
      name: 'Example',
      vendor: 'Example Org',
      appId: 'org.example.browser',
      binaryName: 'example',
      firefox,
      ...extra,
    }),
  });
  return (...args) =>
    runCli(['download', ...args], {
      cwd: join(dir(), 'project'),
      env: { FIREFORGE_HOME: home },
      commands: [download],
    });
}

const parsed = (result: CliResult): Result => JSON.parse(result.stdout) as Result;

// The archive is packed and extracted by a `tar` that handles xz.
describe.skipIf(process.platform === 'win32')('fireforge download', () => {
  it('imports the pin and makes engine/ its checkout in patch mode', async () => {
    const run = await setUp();
    const first = await run('--json');
    expect(first.exitCode).toBe(0);
    const engine = join(dir(), 'project', 'engine');
    expect(parsed(first)).toMatchObject({
      pristine: join(dir(), 'home', 'pristine', `firefox-esr-${VERSION}`),
      engine,
      replaced: false,
      recovery: null,
    });
    expect((await git(engine, ['rev-parse', 'HEAD'])).trim()).toBe(parsed(first).commit);

    const again = await run();
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('--force');

    await writeFile(join(engine, 'browser/new.js'), 'unexported\n');
    const forced = await run('--force', '--json');
    expect(forced.exitCode).toBe(0);
    expect(parsed(forced)).toMatchObject({ commit: parsed(first).commit, replaced: true });
    expect(await git(engine, ['show', `${parsed(forced).recovery ?? ''}:browser/new.js`])).toBe(
      'unexported\n'
    );
    await expect(readFile(join(engine, 'browser/new.js'))).rejects.toThrow();
  });

  it('fills only the pristine store in source mode, and holds the import to the pinned commit', async () => {
    const source = (pristineCommit: string): Record<string, unknown> => ({
      mode: 'source',
      source: { root: 'src', metadataRoot: 'upstream', pristineCommit },
    });
    const wrong = await (await setUp(source('a'.repeat(40))))('--json');
    expect(wrong.exitCode).toBe(2);
    expect(JSON.parse(wrong.stdout)).toMatchObject({ code: 'pristine-commit-mismatch' });
    const actual = /imports as commit ([0-9a-f]{40})/.exec(wrong.stdout)?.[1] ?? '';

    const right = await (await setUp(source(actual)))('--json');
    expect(right.exitCode).toBe(0);
    expect(parsed(right)).toMatchObject({ commit: actual, engine: null, replaced: false });
    await expect(stat(join(dir(), 'project', 'engine'))).rejects.toThrow();
  });
});
