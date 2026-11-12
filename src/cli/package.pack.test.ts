// SPDX-License-Identifier: EUPL-1.2
/**
 * The package as a user installs it: what `npm pack` puts in the tarball,
 * and that the installed `fireforge` executable starts, reports the build it
 * was packed from and finds its templates.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../testing/script.js';

const exec = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cleanup: string[] = [];

interface PackRecord {
  filename: string;
  files: { path: string }[];
}

/** Runs `npm pack` and reads its report; lifecycle output may precede the JSON. */
async function pack(...flags: string[]): Promise<PackRecord> {
  const { stdout } = await exec(npm, ['pack', '--json', ...flags], {
    cwd: REPO_ROOT,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  const records = JSON.parse(stdout.slice(stdout.lastIndexOf('\n[') + 1)) as PackRecord[];
  const [record] = records;
  if (record === undefined) throw new Error('npm pack reported no package');
  return record;
}

afterAll(async () => {
  await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('the packed package', () => {
  it('holds the compiled tree, the templates and the documentation, and nothing else', async () => {
    const files = (await pack('--dry-run')).files.map((file) => file.path);
    expect(files).toEqual(
      expect.arrayContaining([
        'package.json',
        'README.md',
        'CHANGELOG.md',
        'LICENSE.md',
        'dist/bin/fireforge.js',
        'dist/build-info.json',
        'dist/src/commands/index.js',
        'templates/configs/common.mozconfig',
        'templates/licenses/MPL-2.0.md',
        'docs/README.md',
        'docs/exit-codes.md',
        'docs/machine-output.md',
      ])
    );
    const allowed =
      /^(?:dist|templates|docs)\/|^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE\.md)$/;
    expect(files.filter((path) => !allowed.test(path))).toEqual([]);
    const unwanted = /\.test\.|^dist\/src\/testing\/|\.d\.ts$|\.map$|\.ts$|(?:^|\/)legacy\//;
    expect(files.filter((path) => unwanted.test(path))).toEqual([]);
  });

  it('installs into a project and runs', async () => {
    const { version } = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const tarball = join(REPO_ROOT, (await pack()).filename);
    cleanup.push(tarball);
    const project = await mkdtemp(join(tmpdir(), 'fireforge-pack-'));
    cleanup.push(project);
    await writeFile(join(project, 'package.json'), '{ "name": "consumer", "private": true }\n');
    await exec(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], {
      cwd: project,
      shell: process.platform === 'win32',
    });

    const installed = join(
      project,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'fireforge.cmd' : 'fireforge'
    );
    const fireforge = async (...args: string[]): Promise<string> =>
      (await exec(installed, args, { cwd: project, shell: process.platform === 'win32' })).stdout;

    // The tarball carries the identity of the checkout it was packed from.
    const identity = new RegExp(
      `^${version.replaceAll('.', '\\.')}\\+g[0-9a-f]{7,40}(?:\\.dirty(?:\\.[0-9a-f]{8})?)?$`
    );
    expect((await fireforge('--version')).trim()).toMatch(identity);

    const help = await fireforge('--help');
    expect(help).toContain('Usage: fireforge');
    for (const command of ['setup', 'status', 'build', 'test', 'gate', 'furnace']) {
      expect(help).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
    expect(await fireforge('setup', '--help')).toContain('--firefox-version');

    // `setup` writes a project from the installed templates.
    await fireforge(
      'setup',
      ...['--name', 'Packed', '--vendor', 'Example', '--app-id', 'org.example.packed'],
      ...['--binary-name', 'packed', '--firefox-version', '140.9.0esr']
    );
    expect(await readFile(join(project, 'configs/common.mozconfig'), 'utf8')).not.toBe('');
    const config = JSON.parse(await readFile(join(project, 'fireforge.json'), 'utf8')) as {
      binaryName: string;
    };
    expect(config.binaryName).toBe('packed');
  });
});
