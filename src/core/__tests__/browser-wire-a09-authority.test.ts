// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempProject, writeFiles, writeFireForgeConfig } from '../../test-utils/index.js';
import { commitFixture, sourceFixture, writeAt } from '../authored/__tests__/fixtures.js';
import { sourceGit } from '../authored/git.js';
import { declareAuthoredOverride, writeAuthoredSourceFile } from '../authored/writer.js';
import { wireSubscript } from '../browser-wire.js';
import { loadFurnaceState } from '../furnace-config.js';
import * as dom from '../wire-dom-fragment.js';

vi.mock('../../utils/logger.js', async () => {
  const { createLoggerMock } = await import('../../test-utils/module-mocks.js');
  return createLoggerMock();
});
vi.mock('../wire-dom-fragment.js', async (original) => {
  const module = await original<typeof import('../wire-dom-fragment.js')>();
  return { ...module, addDomFragment: vi.fn(module.addDomFragment) };
});
const main = 'browser/base/content/browser-main.js';
const jar = 'browser/base/jar.mn';
const document = 'browser/base/content/browser.xhtml';
const fragment = 'browser/components/fixture/fragment.inc.xhtml';
const contents: Record<string, string> = {
  [main]: 'Services.scriptloader.loadSubScript("chrome://browser/content/existing.js", this);\n',
  [document]: '<window><hbox/></window>\n',
  [jar]: 'browser.jar:\n  content/browser/existing.js (content/existing.js)\n',
};
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {
    throw new Error('barrier not ready');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(source: boolean): Promise<{ root: string; tree: string }> {
  if (!source) {
    const root = await createTempProject('fireforge-a09-wire-');
    directories.push(root);
    await writeFireForgeConfig(root);
    await writeFiles(
      root,
      Object.fromEntries(
        Object.entries({ ...contents, [fragment]: '<div/>\n' }).map(([path, bytes]) => [
          `engine/${path}`,
          bytes,
        ])
      )
    );
    return { root, tree: join(root, 'engine') };
  }
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  for (const [path, bytes] of Object.entries(contents)) await writeAt(value.pristine, path, bytes);
  await commitFixture(value.pristine);
  const pin = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString().trim();
  if (!value.config.sources) throw new Error('fixture source config');
  value.config.sources.pristineCommit = pin;
  await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
  await writeAt(
    value.root,
    'docs/adr/fixture-wire.md',
    '# Fixture wire\nStatus: Accepted\n\nExplicit temporary upstream edits for this isolated rollback fixture.\n'
  );
  vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
  for (const path of Object.keys(contents))
    await declareAuthoredOverride(value.root, path, {
      component: 'fixture-wire',
      classification: 'exception',
      adr: 'docs/adr/fixture-wire.md',
    });
  await writeAt(value.root, 'src/' + fragment, '<div/>\n');
  return { root: value.root, tree: join(value.root, 'src') };
}

describe('A09 standalone browser-wire authority', () => {
  it('attributes and restores its own first authored publication without requiring furnace.json', async () => {
    const f = await fixture(true);
    await expect(wireSubscript(f.root, 'fixture', { domFilePath: fragment })).rejects.toThrow(
      'insertion point'
    );
    for (const [path, expected] of Object.entries(contents))
      expect(await readFile(join(f.tree, path), 'utf8')).toBe(expected);
    expect((await loadFurnaceState(f.root)).pendingRepair).toBeUndefined();
    await expect(readFile(join(f.root, 'furnace.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a conditional peer authored publication after wire and records incomplete rollback', async () => {
    const f = await fixture(true),
      paused = barrier(),
      release = barrier();
    vi.mocked(dom.addDomFragment).mockImplementationOnce(async () => {
      paused.resolve();
      await release.promise;
      throw new Error('fixture later step failed');
    });
    const operation = wireSubscript(f.root, 'fixture', { domFilePath: fragment });
    const refused = expect(operation).rejects.toThrow('authored-rollback-drift');
    await paused.promise;
    const published = await readFile(join(f.tree, main));
    expect(published.toString()).toContain('fixture.js');
    await writeAuthoredSourceFile(f.root, main, Buffer.from('completed peer source\n'), {
      expected: published,
    });
    release.resolve();
    await refused;
    expect(await readFile(join(f.tree, main), 'utf8')).toBe('completed peer source\n');
    expect((await loadFurnaceState(f.root)).pendingRepair?.reason).toContain(
      'authored-rollback-drift'
    );
  });

  it('does not overwrite a peer edit to a legacy pre-snapshot that wire never changed', async () => {
    const f = await fixture(false),
      paused = barrier(),
      release = barrier();
    vi.mocked(dom.addDomFragment).mockImplementationOnce(async () => {
      paused.resolve();
      await release.promise;
      throw new Error('fixture later step failed');
    });
    const operation = wireSubscript(f.root, 'fixture', { domFilePath: fragment });
    const refused = expect(operation).rejects.toThrow('rollback-drift');
    await paused.promise;
    await writeAt(f.tree, jar, 'completed peer manifest\n');
    release.resolve();
    await refused;
    expect(await readFile(join(f.tree, main), 'utf8')).toBe(contents[main]);
    expect(await readFile(join(f.tree, jar), 'utf8')).toBe('completed peer manifest\n');
    expect((await loadFurnaceState(f.root)).pendingRepair).toBeDefined();
  });
});
