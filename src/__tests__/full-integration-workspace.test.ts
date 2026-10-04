// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  runGit,
} from '../test-utils/index.js';

const run = promisify(execFile);
const scripts = join(dirname(fileURLToPath(import.meta.url)), '../../scripts');
const moduleUrl = pathToFileURL(join(scripts, 'full-integration-workspace.mjs')).href;
let root: string;
let engine: string;
const untrackedName = process.platform === 'win32' ? 'untracked user.txt' : 'untracked -> user.txt';
const renamedName = process.platform === 'win32' ? 'renamed dirty.txt' : 'renamed -> dirty.txt';
beforeEach(async () => {
  root = await createTempProject('ff-full-runner-');
  engine = join(root, 'engine');
  await initCommittedRepo(engine, {
    'target.js': 'original\n',
    'dirty.txt': 'original dirty\n',
    '.gitignore': 'obj-*/\n',
  });
  await mkdir(join(root, 'patches'));
  await writeFile(join(root, 'patches/patches.json'), '{"version":1,"patches":[]}');
  await writeFile(
    join(root, 'fireforge.json'),
    '{"name":"T","firefox":{"version":"140.9.0esr","product":"firefox-esr"}}'
  );
});
afterEach(async () => {
  await removeTempProject(root);
});

async function helper(body: string): Promise<string> {
  return (
    await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import * as workspace from ${JSON.stringify(moduleUrl)}; ${body}`,
      ],
      { cwd: engine }
    )
  ).stdout;
}

async function runner(fakeCli = ''): Promise<{
  exitCode: number;
  report: { success: boolean; cleanup: { actions: string[]; errors: string[] } };
}> {
  const staging = join(root, 'runner');
  await mkdir(join(staging, 'scripts'), { recursive: true });
  await mkdir(join(staging, 'dist/bin'), { recursive: true });
  for (const file of ['run-full-firefox-integration.mjs', 'full-integration-workspace.mjs']) {
    await copyFile(join(scripts, file), join(staging, 'scripts', file));
  }
  await writeFile(join(staging, 'dist/bin/fireforge.js'), fakeCli);
  let exitCode = 0;
  try {
    await run(process.execPath, [join(staging, 'scripts/run-full-firefox-integration.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        FIREFORGE_FULL_PROJECT_ROOT: root,
        FIREFORGE_FULL_TARGET_FILE: 'target.js',
        FIREFORGE_FULL_TREE: '0',
        FIREFORGE_FULL_KEEP_PATCH: '0',
        FIREFORGE_FULL_SKIP_SETUP: '1',
      },
    });
  } catch (error: unknown) {
    exitCode = Number((error as { code: unknown }).code);
  }
  const { readdir } = await import('node:fs/promises');
  const artifacts = join(root, '.fireforge/full-integration-artifacts');
  const [stamp] = await readdir(artifacts);
  if (!stamp) throw new Error('Runner did not write a report');
  const report = JSON.parse(await readFile(join(artifacts, stamp, 'report.json'), 'utf8')) as {
    success: boolean;
    cleanup: { actions: string[]; errors: string[] };
  };
  return { exitCode, report };
}

describe('integration refusal preservation', () => {
  it.each(['dirty', 'managed'])(
    'preserves files and the index for a %s target refusal',
    async (reason) => {
      await writeFile(join(engine, 'target.js'), 'USER EDIT\n');
      await writeFile(join(engine, 'dirty.txt'), 'staged user edit\n');
      await runGit(engine, ['add', 'dirty.txt']);
      await writeFile(join(engine, untrackedName), 'USER FILE\n');
      if (reason === 'managed')
        await writeFile(
          join(root, 'patches/patches.json'),
          '{"version":1,"patches":[{"filesAffected":["target.js"]}]}'
        );
      const index = await readFile(join(engine, '.git/index'));
      const result = await runner();
      expect(result.exitCode).toBe(1);
      expect(result.report.success).toBe(false);
      expect(result.report.cleanup.actions).toEqual([]);
      expect(await readFile(join(engine, 'target.js'), 'utf8')).toBe('USER EDIT\n');
      expect(await readFile(join(engine, untrackedName), 'utf8')).toBe('USER FILE\n');
      expect(await readFile(join(engine, '.git/index'))).toEqual(index);
    }
  );

  it('does not arm cleanup when a project snapshot fails', async () => {
    await mkdir(join(root, '.gitignore'));
    await writeFile(join(engine, 'dirty.txt'), 'USER EDIT\n');
    await writeFile(join(engine, 'untracked.txt'), 'USER FILE\n');
    const result = await runner();
    expect(result.exitCode).toBe(1);
    expect(result.report.cleanup.actions).toEqual([]);
    expect(await readFile(join(engine, 'dirty.txt'), 'utf8')).toBe('USER EDIT\n');
    expect(await readFile(join(engine, 'untracked.txt'), 'utf8')).toBe('USER FILE\n');
  });
});

it.each([false, true])(
  'reports the real cleanup outcome after a successful scenario (failure=%s)',
  async (fails) => {
    const result = await runner(`
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const command = args[0];
    fs.mkdirSync('.fireforge', { recursive: true });
    if (command === 'build') fs.mkdirSync('engine/obj-test/dist/bin', { recursive: true });
    if (command === 'export') {
      const filename = '001-infra-integration.patch';
      fs.copyFileSync('engine/target.js', '.fireforge/payload');
      fs.writeFileSync('patches/' + filename, 'synthetic patch');
      fs.writeFileSync('patches/patches.json', JSON.stringify({ version: 1, patches: [{filename, filesAffected: ['target.js']}] }));
    }
    if (command === 'import') {
      if (!args.includes('--force')) { console.error('Uncommitted changes in patch-touched files'); process.exitCode = 1; }
      else fs.copyFileSync('.fireforge/payload', 'engine/target.js');
    }
    if (command === 'status') {
      const counter = '.fireforge/status-count';
      const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) + 1 : 1;
      fs.writeFileSync(counter, String(count));
      if (count === 2 && ${String(fails)}) {
        fs.unlinkSync('fireforge.json');
        fs.mkdirSync('fireforge.json');
        fs.writeFileSync('fireforge.json/preserve', 'valuable recovery evidence');
      }
    }
  `);
    expect(result.exitCode).toBe(fails ? 1 : 0);
    expect(result.report.success).toBe(!fails);
    expect(result.report.cleanup.errors).toEqual(
      fails ? [expect.stringContaining('Failed to restore fireforge.json') as string] : []
    );
    if (fails)
      expect(await readFile(join(root, 'fireforge.json/preserve'), 'utf8')).toBe(
        'valuable recovery evidence'
      );
    else
      expect(
        JSON.parse(await readFile(join(root, 'fireforge.json'), 'utf8')) as unknown
      ).toMatchObject({ name: 'T' });
  }
);

it('restores dirty/staged filenames, binary data, rename sides and index state exactly', async () => {
  const names =
    process.platform === 'win32'
      ? ['ordinary name.txt', 'café.txt']
      : ['arrow -> name.txt', 'quote"name.txt', 'tab\tname.txt', 'line\nname.txt', 'café.txt'];
  for (const name of names) await writeFile(join(engine, name), Buffer.from([0, 1, 255]));
  await rename(join(engine, 'dirty.txt'), join(engine, renamedName));
  await runGit(engine, ['add', '-A']);
  const index = await readFile(join(engine, '.git/index'));
  const output = await helper(`
    import { writeFile, rm } from 'node:fs/promises';
    const baseline = await workspace.snapshotEngine(process.cwd());
    for (const path of baseline.paths.keys()) if (baseline.paths.get(path).kind === 'file') await writeFile(path, 'MUTATED');
    await writeFile('target.js', 'runner edit');
    await writeFile('introduced.txt', 'new file');
    const cleanup = { actions: [], errors: [] };
    await workspace.restoreEngine(process.cwd(), baseline, cleanup);
    console.log(JSON.stringify(cleanup));
  `);
  expect((JSON.parse(output) as { errors: string[] }).errors).toEqual([]);
  for (const name of names)
    expect(await readFile(join(engine, name))).toEqual(Buffer.from([0, 1, 255]));
  expect(await readFile(join(engine, renamedName), 'utf8')).toBe('original dirty\n');
  expect(await readFile(join(engine, 'target.js'), 'utf8')).toBe('original\n');
  expect(await readFile(join(engine, '.git/index'))).toEqual(index);
  await expect(lstat(join(engine, 'introduced.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('failed checkout preserves the target and produces a failed recovery outcome', async () => {
  const output = await helper(`
    import { writeFile, readFile } from 'node:fs/promises';
    const baseline = await workspace.snapshotEngine(process.cwd());
    await writeFile('target.js', 'valuable bytes');
    const cleanup = { actions: [], errors: [] };
    await workspace.restoreEngine(process.cwd(), baseline, cleanup, () => { throw new Error('checkout denied'); });
    console.log(JSON.stringify({ text: await readFile('target.js', 'utf8'), errors: cleanup.errors, failure: workspace.recoveryFailure(cleanup.errors)?.message }));
  `);
  expect(JSON.parse(output) as unknown).toMatchObject({
    text: 'valuable bytes',
    errors: [expect.stringContaining('checkout denied') as string],
    failure: expect.stringContaining('Integration recovery failed') as string,
  });
});

it.skipIf(process.platform === 'win32')(
  'preserves mode and an untouched link identity across refused runs',
  async () => {
    await writeFile(join(engine, 'target.js'), 'USER EDIT\n');
    await chmod(join(engine, 'target.js'), 0o755);
    await symlink('dirty.txt', join(engine, 'user-link'));
    const before = await lstat(join(engine, 'user-link'));
    await runner();
    expect((await lstat(join(engine, 'target.js'))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(engine, 'user-link'))).ino).toBe(before.ino);
    expect(await readlink(join(engine, 'user-link'))).toBe('dirty.txt');
  }
);

it.skipIf(process.platform === 'win32')(
  'restores replaced links and original file permissions',
  async () => {
    await writeFile(join(engine, 'dirty.txt'), 'user edit');
    await chmod(join(engine, 'dirty.txt'), 0o755);
    await symlink('dirty.txt', join(engine, 'user-link'));
    const output = await helper(`
    import { writeFile, rm, chmod } from 'node:fs/promises';
    const baseline = await workspace.snapshotEngine(process.cwd());
    await rm('user-link'); await writeFile('user-link', 'replacement');
    await writeFile('dirty.txt', 'modified'); await chmod('dirty.txt', 0o600);
    const cleanup = {actions: [], errors: []};
    await workspace.restoreEngine(process.cwd(), baseline, cleanup);
    console.log(JSON.stringify(cleanup));
  `);
    expect((JSON.parse(output) as { errors: string[] }).errors).toEqual([]);
    expect(await readlink(join(engine, 'user-link'))).toBe('dirty.txt');
    expect((await lstat(join(engine, 'dirty.txt'))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(engine, 'dirty.txt'), 'utf8')).toBe('user edit');
  }
);

it('preserves a peer index lock and reports index recovery failure', async () => {
  const output = await helper(`
    import { writeFile, readFile } from 'node:fs/promises';
    const baseline = await workspace.snapshotEngine(process.cwd());
    await writeFile(baseline.indexPath + '.lock', 'peer lock');
    const cleanup = {actions: [], errors: []};
    await workspace.restoreEngine(process.cwd(), baseline, cleanup);
    console.log(JSON.stringify({lock: await readFile(baseline.indexPath + '.lock', 'utf8'), errors: cleanup.errors}));
  `);
  expect(JSON.parse(output) as unknown).toMatchObject({
    lock: 'peer lock',
    errors: [expect.stringContaining('Index recovery failed') as string],
  });
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'refuses an unreadable snapshot and leaves its bytes intact',
  async () => {
    await writeFile(join(engine, 'dirty.txt'), 'valuable bytes');
    await chmod(join(engine, 'dirty.txt'), 0o000);
    try {
      await expect(helper('await workspace.snapshotEngine(process.cwd());')).rejects.toThrow();
    } finally {
      await chmod(join(engine, 'dirty.txt'), 0o644);
    }
    expect(await readFile(join(engine, 'dirty.txt'), 'utf8')).toBe('valuable bytes');
  }
);
