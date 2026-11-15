// SPDX-License-Identifier: EUPL-1.2
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { build } from '../engine/index.js';
import { sleep } from '../kernel/time.js';
import { hostPaths } from '../project/index.js';
import { makeSourceProject, seedPristine, useMachSandbox } from '../testing/engine.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { watch, withWorkspace } from './index.js';

const dir = useTempDir();
const logged = useMachSandbox();

const PANEL = 'browser/base/content/panel.mjs';

/** Waits until `check` holds, failing after eight seconds. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('the watcher did not get there in time');
    await sleep(50);
  }
}

describe.skipIf(process.platform === 'win32')('watch in source mode', () => {
  it('brings owned files edited during the watch into the leased engine', async () => {
    // The stand-in watch stays up long enough for two edits to be followed.
    await seedPristine(hostPaths({ FIREFORGE_HOME: join(dir(), 'home') }), {
      '.mach-state/script-watch.json': JSON.stringify({ stdout: ['watching'], sleep: 2 }),
    });
    const project = await makeSourceProject(dir(), {
      files: { [`src/${PANEL}`]: 'export const panel = "first";\n' },
    });
    const bin = join(dir(), 'watchman-bin');
    await writeTree(bin, { watchman: '#!/bin/sh\necho 2026.01.01.00\n' });
    await chmod(join(bin, 'watchman'), 0o755);
    const env = { PATH: [bin, process.env['PATH'] ?? ''].join(delimiter) };

    await withWorkspace(project, { command: 'watch' }, async (workspace) => {
      await build(workspace);
      const engineFile = (path: string): Promise<string> =>
        readFile(join(workspace.engineDir, path), 'utf8');
      const watching = watch(workspace, { env, pollMs: 50 });
      await sleep(200);
      await writeTree(project.root, {
        [`src/${PANEL}`]: 'export const panel = "second, edited";\n',
        'src/browser/base/content/added.mjs': 'export {};\n',
      });
      await sleep(500);
      expect(await engineFile(PANEL)).toContain('"second, edited"');
      expect(await engineFile('browser/base/content/added.mjs')).toBe('export {};\n');
      await rm(join(project.root, 'src/browser/base/content/added.mjs'));
      await watching;
      await expect(engineFile('browser/base/content/added.mjs')).rejects.toThrow();
      expect(logged()).toContain('Brought 2 changed file(s) into workspace "w1".');
    });
  }, 60_000);

  it('tries a refresh that failed again without another edit, and follows a mode change', async () => {
    await seedPristine(hostPaths({ FIREFORGE_HOME: join(dir(), 'home') }), {
      '.mach-state/script-watch.json': JSON.stringify({ stdout: ['watching'], sleep: 12 }),
    });
    const project = await makeSourceProject(dir(), {
      files: { [`src/${PANEL}`]: 'export const panel = "first";\n' },
    });
    const bin = join(dir(), 'watchman-bin');
    await writeTree(bin, { watchman: '#!/bin/sh\necho 2026.01.01.00\n' });
    await chmod(join(bin, 'watchman'), 0o755);
    const env = { PATH: [bin, process.env['PATH'] ?? ''].join(delimiter) };

    await withWorkspace(project, { command: 'watch' }, async (workspace) => {
      await build(workspace);
      const enginePath = join(workspace.engineDir, PANEL);
      const watching = watch(workspace, { env, pollMs: 50 });
      await sleep(200);
      // Someone edits the engine file by hand, so the next refresh stops on it.
      await writeFile(enginePath, 'export const panel = "by hand";\n');
      await writeTree(project.root, { [`src/${PANEL}`]: 'export const panel = "second";\n' });
      await until(() => logged().includes('The workspace was not updated'));
      expect(await readFile(enginePath, 'utf8')).toContain('by hand');
      // The engine file is as the last refresh left it: the same input now goes through.
      await writeFile(enginePath, 'export const panel = "first";\n');
      await until(async () => (await readFile(enginePath, 'utf8')).includes('"second"'));
      // One warning per failing state, not one per retry: the edit can be seen
      // half-written, which is a second state.
      const warnings = logged().match(/The workspace was not updated/g) ?? [];
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings.length).toBeLessThanOrEqual(2);

      if (process.platform !== 'win32') {
        await chmod(join(project.root, `src/${PANEL}`), 0o755);
        await until(async () => ((await stat(enginePath)).mode & 0o111) !== 0);
      }
      await watching;
    });
  }, 60_000);
});
