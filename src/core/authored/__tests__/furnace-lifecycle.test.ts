// SPDX-License-Identifier: EUPL-1.2
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { furnaceChromeDocCreateCommand } from '../../../commands/furnace/chrome-doc.js';
import { furnaceChromeDocRemoveCommand } from '../../../commands/furnace/chrome-doc-remove.js';
import { furnaceCreateCommand } from '../../../commands/furnace/create.js';
import { furnaceInitCommand } from '../../../commands/furnace/init.js';
import { furnaceOverrideCommand } from '../../../commands/furnace/override.js';
import { furnaceRefreshCommand } from '../../../commands/furnace/refresh.js';
import { furnaceRemoveCommand } from '../../../commands/furnace/remove.js';
import { furnaceRenameCommand } from '../../../commands/furnace/rename.js';
import { removeAuthoringFile } from '../../furnace-authored-lifecycle.js';
import { createDefaultFurnaceConfig } from '../../furnace-config.js';
import { createRollbackJournal, restoreRollbackJournal } from '../../furnace-rollback.js';
import { captureAuthoredSnapshot } from '../capture.js';
import { sourceGit } from '../git.js';
import { declareAuthoredOverride } from '../writer.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
  await writeAt(
    value.root,
    'furnace.json',
    JSON.stringify(createDefaultFurnaceConfig({ binaryName: 'fixture' }))
  );
  await writeAt(value.root, 'engine/sentinel.txt', 'Never mutate the ignored editor engine\n');
  return value;
}

describe('authored Furnace lifecycle', () => {
  it('initializes source token/config scaffolds without touching the editor engine', async () => {
    const { root } = await fixture();
    await furnaceInitCommand(root, { force: true, prefix: 'moz-fixture-' });
    expect(await readFile(join(root, 'engine/sentinel.txt'), 'utf8')).toBe(
      'Never mutate the ignored editor engine\n'
    );
    expect(await readdir(join(root, 'engine'))).toEqual(['sentinel.txt']);
  });

  it.each(['browser-chrome', 'mochikit'] as const)(
    'preserves %s behavior source through rename/removal',
    async (testStyle) => {
      const { root } = await fixture();
      await furnaceCreateCommand(root, 'moz-before', {
        description: 'Lifecycle fixture',
        register: false,
        localized: false,
        withTests: true,
        testStyle,
      });
      await furnaceRenameCommand(root, 'moz-before', 'moz-after');
      const path =
        testStyle === 'mochikit'
          ? 'toolkit/content/tests/widgets/test_moz-after.html'
          : 'browser/base/content/test/fixture/browser_fixture_after.js';
      expect(await readFile(join(root, 'src', path), 'utf8')).toContain('moz-after');
      await furnaceRemoveCommand(root, 'moz-after', { yes: true });
      await expect(readFile(join(root, 'src', path))).rejects.toThrow();
      expect(await readFile(join(root, 'engine/sentinel.txt'), 'utf8')).toBe(
        'Never mutate the ignored editor engine\n'
      );
    }
  );
  it('creates, renames and removes a component with xpcshell behavior source while leaving engine untouched', async () => {
    const { root, pristine } = await fixture();
    await furnaceCreateCommand(root, 'moz-before', {
      description: 'Lifecycle fixture',
      register: false,
      localized: false,
      xpcshell: true,
    });
    const oldTest =
      'browser/base/content/test/fixture-xpcshell/moz-before/test_moz_before_packaged.js';
    expect(await readFile(join(root, 'src', oldTest), 'utf8')).toContain('moz-before');
    await furnaceRenameCommand(root, 'moz-before', 'moz-after');
    const newTest =
      'browser/base/content/test/fixture-xpcshell/moz-after/test_moz_after_packaged.js';
    expect(await readFile(join(root, 'src', newTest), 'utf8')).toContain('moz-after');
    await expect(readFile(join(root, 'src', oldTest))).rejects.toThrow();
    expect(
      await readFile(join(root, 'components/custom/moz-after/moz-after.mjs'), 'utf8')
    ).toContain('MozAfter');
    await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    await furnaceRemoveCommand(root, 'moz-after', { yes: true });
    await expect(readFile(join(root, 'src', newTest))).rejects.toThrow();
    await expect(stat(join(root, 'components/custom/moz-after'))).rejects.toThrow();
    await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    expect(await readFile(join(root, 'engine/sentinel.txt'), 'utf8')).toBe(
      'Never mutate the ignored editor engine\n'
    );
    expect(await readdir(join(root, 'engine'))).toEqual(['sentinel.txt']);
  });

  it('transactionally restores upstream meaning and keeps origin declaration on rollback', async () => {
    const { root } = await fixture();
    await declareAuthoredOverride(root, 'browser/manifest.txt', {
      component: 'stable-origin',
      classification: 'registration',
    });
    const sidecar = join(root, '.fireforge-sources/overrides/browser/manifest.txt.json');
    const before = await readFile(sidecar);
    const journal = createRollbackJournal();
    await removeAuthoringFile(join(root, 'src/browser/manifest.txt'), journal);
    await expect(readFile(sidecar)).rejects.toThrow();
    await restoreRollbackJournal(journal);
    expect(await readFile(sidecar)).toEqual(before);
    expect(await readFile(join(root, 'src/browser/manifest.txt'), 'utf8')).toContain('second');
  });

  it('retires a removed generated upstream override declaration without touching an engine', async () => {
    const { root, pristine, config } = await fixture();
    const path = 'toolkit/content/widgets/moz-before/moz-before.mjs';
    await writeAt(pristine, path, 'export const upstream = true;\n');
    await commitFixture(pristine);
    const commit = (await sourceGit(pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
    if (!config.sources) throw new Error('source fixture missing config');
    await writeAt(
      root,
      'fireforge.json',
      JSON.stringify({ ...config, sources: { ...config.sources, pristineCommit: commit } })
    );
    await furnaceCreateCommand(root, 'moz-before', {
      description: 'Generated override retirement',
      register: false,
      localized: false,
    });
    await declareAuthoredOverride(root, path, {
      component: 'stable-generator-origin',
      classification: 'registration',
    });
    const sidecar = join(root, '.fireforge-sources/overrides', `${path}.json`);
    expect(await readFile(sidecar, 'utf8')).toContain('stable-generator-origin');
    await furnaceRemoveCommand(root, 'moz-before', { yes: true });
    await expect(readFile(sidecar)).rejects.toThrow();
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    expect(snapshot.files.some((file) => file.path === path)).toBe(false);
    expect(await readFile(join(root, 'engine/sentinel.txt'), 'utf8')).toBe(
      'Never mutate the ignored editor engine\n'
    );
  });

  it('creates/removes a chrome document and packaging test through authenticated source manifests', async () => {
    const { root, pristine, config } = await fixture();
    for (const path of [
      'browser/base/jar.mn',
      'browser/themes/shared/jar.inc.mn',
      'browser/locales/jar.mn',
    ])
      await writeAt(pristine, path, 'browser.jar:\n');
    await commitFixture(pristine);
    const commit = (await sourceGit(pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
    if (!config.sources) throw new Error('source fixture missing config');
    await writeAt(
      root,
      'fireforge.json',
      JSON.stringify({ ...config, sources: { ...config.sources, pristineCommit: commit } })
    );
    for (const path of [
      'browser/base/jar.mn',
      'browser/themes/shared/jar.inc.mn',
      'browser/locales/jar.mn',
    ])
      await declareAuthoredOverride(root, path, {
        component: 'chrome-entry',
        classification: 'registration',
      });
    await furnaceChromeDocCreateCommand(root, 'source-window', { withTests: true });
    expect(
      await readFile(join(root, 'src/browser/base/content/source-window.xhtml'), 'utf8')
    ).toContain('source-window');
    expect(await readFile(join(root, 'src/browser/base/jar.mn'), 'utf8')).toContain(
      'source-window.xhtml'
    );
    await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    await furnaceChromeDocRemoveCommand(root, 'source-window', { yes: true });
    await expect(
      readFile(join(root, 'src/browser/base/content/source-window.xhtml'))
    ).rejects.toThrow();
    expect(await readFile(join(root, 'src/browser/base/jar.mn'), 'utf8')).not.toContain(
      'source-window.xhtml'
    );
    expect(await readFile(join(root, 'engine/sentinel.txt'), 'utf8')).toBe(
      'Never mutate the ignored editor engine\n'
    );
    expect(await readdir(join(root, 'engine'))).toEqual(['sentinel.txt']);
  });

  it('directs legacy name-only upstream fork/refresh to the source authority commands before reading engine', async () => {
    const { root } = await fixture();
    await expect(
      furnaceOverrideCommand(root, 'moz-upstream', { type: 'full', description: 'Fixture' })
    ).rejects.toThrow('authored override');
    await expect(furnaceRefreshCommand(root, 'moz-upstream')).rejects.toThrow('authored refresh');
    expect(await readFile(join(root, 'engine/sentinel.txt'), 'utf8')).toBe(
      'Never mutate the ignored editor engine\n'
    );
    expect(await readdir(join(root, 'engine'))).toEqual(['sentinel.txt']);
  });
});
