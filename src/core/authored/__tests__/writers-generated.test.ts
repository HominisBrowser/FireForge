// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { furnaceCreateCommand } from '../../../commands/furnace/create.js';
import { registerCommand } from '../../../commands/register.js';
import { createDefaultFurnaceConfig } from '../../furnace-config.js';
import { addJarMnEntries } from '../../furnace-registration.js';
import {
  createRollbackJournal,
  restoreRollbackJournal,
  snapshotFile,
  trackRollbackMutations,
} from '../../furnace-rollback.js';
import { captureAuthoredSnapshot } from '../capture.js';
import * as authoringFs from '../fs.js';
import { generateAuthoredDelta } from '../generate.js';
import { declareAuthoredOverride, writeAuthoredSourceFile } from '../writer.js';
import { readCaptured, sourceFixture, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
  return value;
}

describe('source-native sanctioned writers', () => {
  it('creates a component and xpcshell scaffolds entirely in tracked source without an engine', async () => {
    const { root, pristine } = await fixture();
    const config = createDefaultFurnaceConfig({ binaryName: 'fixture' });
    await writeAt(root, 'furnace.json', JSON.stringify(config));
    await furnaceCreateCommand(root, 'moz-source-fixture', {
      description: 'Frozen source fixture',
      localized: false,
      register: false,
      xpcshell: true,
    });
    expect(
      await readFile(
        join(root, 'components/custom/moz-source-fixture/moz-source-fixture.mjs'),
        'utf8'
      )
    ).toContain('MozSourceFixture');
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    expect(snapshot.files.some((file) => file.path.includes('test_moz_source_fixture'))).toBe(true);
    await expect(readFile(join(root, 'engine/browser/manifest.txt'))).rejects.toThrow();
  });
  it('routes registration to tracked source without requiring or writing a live engine', async () => {
    const { root } = await fixture();
    await writeAt(
      root,
      'src/browser/modules/fixture/Example.sys.mjs',
      '/* SPDX-License-Identifier: EUPL-1.2 */\nexport const example = 1;\n'
    );
    await writeAt(
      root,
      'src/browser/modules/fixture/moz.build',
      'EXTRA_JS_MODULES += [\n    "Existing.sys.mjs",\n]\n'
    );
    await registerCommand(root, 'browser/modules/fixture/Example.sys.mjs');
    expect(await readFile(join(root, 'src/browser/modules/fixture/moz.build'), 'utf8')).toContain(
      'Example.sys.mjs'
    );
    await expect(
      readFile(join(root, 'engine/browser/modules/fixture/moz.build'))
    ).rejects.toThrow();
  });

  it('requires first-touch upstream authorization and compares source before replacing bytes', async () => {
    const { root } = await fixture();
    await expect(
      writeAuthoredSourceFile(root, 'browser/manifest.txt', Buffer.from('unsafe'))
    ).rejects.toThrow('authored-declaration-required');
    await declareAuthoredOverride(root, 'browser/manifest.txt', {
      component: 'infra-registration',
      classification: 'registration',
    });
    const enginePath = join(root, 'engine/browser/manifest.txt');
    expect(await authoringFs.readText(enginePath)).toContain('second');
    await writeAt(root, 'src/browser/manifest.txt', 'peer edit\n');
    await expect(authoringFs.writeText(enginePath, 'lost update\n')).rejects.toThrow(
      'authored-source-moved'
    );
    expect(await readFile(join(root, 'src/browser/manifest.txt'), 'utf8')).toBe('peer edit\n');
  });

  it('Furnace registration and rollback address authored manifests while deployed files stay outside source', async () => {
    const { root } = await fixture();
    const original =
      'toolkit.jar:\n   content/global/elements/existing.mjs (widgets/existing/existing.mjs)\n';
    const source = 'src/toolkit/content/jar.mn';
    await writeAt(root, source, original);
    const enginePath = join(root, 'engine/toolkit/content/jar.mn');
    const journal = createRollbackJournal();
    await snapshotFile(journal, enginePath);
    await trackRollbackMutations(
      () => journal,
      () => addJarMnEntries(join(root, 'engine'), 'moz-fixture', ['moz-fixture.mjs'])
    );
    expect(await readFile(join(root, source), 'utf8')).toContain('moz-fixture.mjs');
    await restoreRollbackJournal(journal);
    expect(await readFile(join(root, source), 'utf8')).toBe(original);
    await expect(readFile(enginePath)).rejects.toThrow();
  });
});

describe('captured Furnace derivation', () => {
  it('composes shared fragments from frozen inputs, retains derived objects, and refuses dual authority', async () => {
    const { root, pristine } = await fixture();
    const furnace = createDefaultFurnaceConfig({ binaryName: 'fixture' });
    furnace.custom['moz-fixture'] = {
      description: 'Fixture',
      targetPath: 'toolkit/content/widgets/moz-fixture',
      register: true,
      localized: false,
    };
    await writeAt(root, 'furnace.json', JSON.stringify(furnace));
    await writeAt(
      root,
      'components/custom/moz-fixture/moz-fixture.mjs',
      'export const value = 1;\n'
    );
    await writeAt(
      root,
      'components/custom/moz-fixture/moz-fixture.css',
      '/* @fireforge-include shared.css */\n'
    );
    await writeAt(root, 'components/shared/shared.css', ':host { display: block; }\n');
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    expect(snapshot.generatedTree).toMatch(/^[a-f0-9]{40}$/);
    const cssPath = 'toolkit/content/widgets/moz-fixture/moz-fixture.css';
    expect(snapshot.files.find((file) => file.path === cssPath)?.kind).toBe('generated');
    await writeAt(root, 'components/shared/shared.css', ':host { display: none; }\n');
    expect((await readCaptured(snapshot, cssPath))?.toString()).toContain('display: block');
    expect(await generateAuthoredDelta(snapshot, { pristineRepository: pristine })).toContain(
      'display: block'
    );
    await writeAt(root, `src/${cssPath}`, 'dual authority\n');
    await expect(
      captureAuthoredSnapshot({
        projectRoot: root,
        intendedPaths: ['src'],
        pristineRepository: pristine,
      })
    ).rejects.toThrow('authored-in-furnace-target');
  });
});
