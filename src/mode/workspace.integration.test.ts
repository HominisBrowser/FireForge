// SPDX-License-Identifier: EUPL-1.2
/**
 * Pool workspaces as checkouts of one source-mode project lease them: what
 * the engine holds when a workspace passes between checkouts, is repaired,
 * cloned, or deployed into.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { addWorkspace, listWorkspaces, repairWorkspace } from '../engine/index.js';
import { exists } from '../kernel/fs.js';
import { sleep } from '../kernel/time.js';
import type { SourceProject } from '../project/index.js';
import { override } from '../source/index.js';
import { makeSourceProject, useMachSandbox } from '../testing/engine.js';
import { SYNTHETIC_FIREFOX_PATHS as PATHS } from '../testing/firefox.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { deployComponents, pinnedPristine, withWorkspace } from './index.js';

const dir = useTempDir();
useMachSandbox();

const lease = (project: SourceProject, workspace?: string): Promise<string> =>
  withWorkspace(project, { command: 'build', workspace }, (leased) =>
    Promise.resolve(leased.engineDir)
  );

const failure = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'none',
    (error: unknown) => (error as { code: string }).code
  );

describe('a pool workspace', () => {
  it('is usable again after the repair the drift refusal names', async () => {
    const project = await makeSourceProject(dir(), { files: { 'src/browser/new.js': 'A\n' } });
    const engine = await lease(project);
    await writeFile(join(engine, 'browser/new.js'), 'edited in the engine\n');
    const refused = await withWorkspace(project, { command: 'build' }, () =>
      Promise.resolve()
    ).catch((error: unknown) => error as { code: string; hint: string });
    expect(refused).toMatchObject({
      code: 'materialize-drift',
      hint: expect.stringContaining('fireforge workspace repair w1') as string,
    });
    await repairWorkspace(project.host, 'w1');
    expect(await lease(project)).toBe(engine);
    expect(await readFile(join(engine, 'browser/new.js'), 'utf8')).toBe('A\n');
  });

  it('is created once when two commands find the pool empty at the same time', async () => {
    const project = await makeSourceProject(dir(), { files: { 'src/browser/new.js': 'A\n' } });
    const results = await Promise.all(
      [1, 2].map(() =>
        withWorkspace(project, { command: 'build' }, async (workspace) => {
          await sleep(100);
          return workspace.name;
        })
      )
    );
    expect(results).toEqual(['w1', 'w1']);
    expect((await listWorkspaces(project.host)).map((workspace) => workspace.name)).toEqual(['w1']);
  });

  it('cloned, holds what any checkout leasing it next needs', async (test) => {
    const first = await makeSourceProject(
      dir(),
      { files: { 'src/browser/a-only.js': 'A\n', 'src/browser/shared.js': 'A version\n' } },
      'first'
    );
    await lease(first);
    try {
      await addWorkspace(first.host, 'copy', { pin: first.config.firefox, from: 'w1' });
      await addWorkspace(first.host, 'copy2', { pin: first.config.firefox, from: 'w1' });
    } catch (error: unknown) {
      // The temporary directory's filesystem cannot clone copy-on-write.
      if ((error as { code?: string }).code === 'clone-unsupported') test.skip();
      throw error;
    }
    const second = await makeSourceProject(
      dir(),
      { files: { 'src/browser/shared.js': 'B version\n' } },
      'second'
    );
    const third = await makeSourceProject(dir(), { files: { 'src/browser/c.js': 'C\n' } }, 'third');
    const copy = await lease(second, 'copy');
    expect(await readFile(join(copy, 'browser/shared.js'), 'utf8')).toBe('B version\n');
    expect(await exists(join(copy, 'browser/a-only.js'))).toBe(false);
    const other = await lease(third, 'copy2');
    expect(await exists(join(other, 'browser/a-only.js'))).toBe(false);
    expect(await exists(join(other, 'browser/shared.js'))).toBe(false);
    expect(await readFile(join(other, 'browser/c.js'), 'utf8')).toBe('C\n');
  });

  it('takes components registered in a manifest the checkout overrides, lease after lease', async () => {
    const project = await makeSourceProject(dir(), {
      files: {
        'furnace.json': JSON.stringify({
          version: 1,
          componentPrefix: 'moz-',
          custom: {
            'moz-test-chip': {
              description: 'A chip',
              targetPath: 'toolkit/content/widgets/moz-test-chip',
              register: true,
              localized: false,
            },
          },
        }),
        'components/custom/moz-test-chip/moz-test-chip.mjs':
          'export default class MozTestChip extends HTMLElement {}\n' +
          'customElements.define("moz-test-chip", MozTestChip);\n',
      },
    });
    await override(project, await pinnedPristine(project), PATHS.widgetsJar);
    const owned = join(project.root, 'src', PATHS.widgetsJar);
    await writeTree(project.root, {
      [`src/${PATHS.widgetsJar}`]: `${await readFile(owned, 'utf8')}# owned by the checkout\n`,
    });
    for (let round = 0; round < 3; round++) {
      const engine = await withWorkspace(project, { command: 'build' }, async (workspace) => {
        await deployComponents(workspace);
        return workspace.engineDir;
      });
      const jar = await readFile(join(engine, PATHS.widgetsJar), 'utf8');
      expect(jar).toContain('# owned by the checkout');
      expect(jar).toContain('moz-test-chip.mjs');
    }
    // A new owned version still reaches the engine, and the components register in it again.
    await writeTree(project.root, {
      [`src/${PATHS.widgetsJar}`]: `${await readFile(owned, 'utf8')}# second version\n`,
    });
    expect(
      await failure(
        withWorkspace(project, { command: 'build' }, async (workspace) => {
          await deployComponents(workspace);
          const jar = await readFile(join(workspace.engineDir, PATHS.widgetsJar), 'utf8');
          expect(jar).toContain('# second version');
          expect(jar).toContain('moz-test-chip.mjs');
        })
      )
    ).toBe('none');
  });
});
