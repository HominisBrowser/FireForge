// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture } from '../../core/authored/__tests__/fixtures.js';
import { loadConfig } from '../../core/config.js';
import * as locks from '../../core/file-lock.js';
import {
  createDefaultFurnaceConfig,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { furnaceCreateCommand } from '../furnace/create.js';
import { furnaceRefreshCommand } from '../furnace/refresh.js';
import { furnaceRemoveCommand } from '../furnace/remove.js';
import { browserTestFileName } from '../furnace/test-file-name.js';

vi.mock('../../utils/logger.js', async () => {
  const { createLoggerMock } = await import('../../test-utils/module-mocks.js');
  return createLoggerMock();
});
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => removeTempProject(path)));
});
function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function legacy(): Promise<string> {
  const root = await createTempProject('ff-a05-');
  directories.push(root);
  await writeFireForgeConfig(root);
  await initCommittedRepo(join(root, 'engine'), { '.keep': '' });
  return root;
}

describe('shared browser test ownership', () => {
  it.each(['legacy', 'authored'] as const)(
    'keeps peer nested suites, non-js tests, support assets and manifest in %s mode',
    async (mode) => {
      let root: string;
      if (mode === 'authored') {
        const fixture = await sourceFixture();
        root = fixture.root;
        directories.push(dirname(root));
        vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', fixture.pristine);
      } else root = await legacy();
      const config = await loadConfig(root);
      await writeFurnaceConfig(root, createDefaultFurnaceConfig({ binaryName: config.binaryName }));
      const source = config.sources?.root ?? 'engine';
      const testDir = `${source}/browser/base/content/test/${config.binaryName}`;
      const ownTest = browserTestFileName('moz-own', config.binaryName);
      const peerSection = '["browser_peer.mjs"]\nsupport-files = ["peer.json"]\n';
      const registration = `BROWSER_CHROME_MANIFESTS += [\n    "content/test/${config.binaryName}/browser.toml",\n]\n`;
      await furnaceCreateCommand(root, 'moz-own', {
        description: 'owned fixture',
        register: false,
        localized: false,
      });
      await writeFiles(root, {
        [`${testDir}/${ownTest}`]: 'owned test\n',
        [`${testDir}/browser.toml`]: `[DEFAULT]\n\n["${ownTest}"]\n\n${peerSection}`,
        [`${testDir}/nested/browser_peer.js`]: 'nested peer\n',
        [`${testDir}/peer.json`]: '{"peer":true}\n',
        [`${testDir}/browser_peer.mjs`]: 'module peer\n',
        [`${source}/browser/base/moz.build`]: registration,
      });
      await furnaceRemoveCommand(root, 'moz-own', { yes: true });
      await expect(readFile(join(root, testDir, ownTest))).rejects.toThrow();
      expect(await readFile(join(root, testDir, 'nested/browser_peer.js'), 'utf8')).toBe(
        'nested peer\n'
      );
      expect(await readFile(join(root, testDir, 'peer.json'), 'utf8')).toBe('{"peer":true}\n');
      expect(await readFile(join(root, testDir, 'browser_peer.mjs'), 'utf8')).toBe('module peer\n');
      expect(await readFile(join(root, testDir, 'browser.toml'), 'utf8')).toContain(
        peerSection.trim()
      );
      expect(await readFile(join(root, source, 'browser/base/moz.build'), 'utf8')).toBe(
        registration
      );
      expect((await loadFurnaceConfig(root)).custom['moz-own']).toBeUndefined();
    }
  );
});

describe('refresh target admission', () => {
  it.each([true, false])(
    'revalidates removal after waiting for the Furnace lock (resetBase=%s)',
    async (resetBase) => {
      const root = await legacy();
      const config = createDefaultFurnaceConfig({ binaryName: 'testbrowser' });
      config.overrides['moz-own'] = {
        type: 'full',
        description: 'before',
        basePath: 'old/path',
        baseVersion: '1',
      };
      await writeFurnaceConfig(root, config);
      await writeFiles(root, { 'components/overrides/moz-own/own.mjs': 'owned\n' });
      const entered = barrier(),
        release = barrier(),
        attempted = barrier();
      const peer = runFurnaceMutation(root, 'remove-rollback', async () => {
        entered.resolve();
        await release.promise;
        const current = await loadFurnaceConfig(root);
        delete current.overrides['moz-own'];
        current.stock.push('moz-peer');
        await writeFurnaceConfig(root, current);
        await rm(join(root, 'components/overrides/moz-own'), { recursive: true });
      });
      await entered.promise;
      const actual = locks.withFileLock;
      vi.spyOn(locks, 'withFileLock').mockImplementation((...args) => {
        if (args[0].endsWith('/furnace.lock')) attempted.resolve();
        return actual(...args);
      });
      const waiting = furnaceRefreshCommand(root, 'moz-own', { resetBase, waitLockSeconds: 5 });
      const refused = expect(waiting).rejects.toThrow(/not an override component/);
      await attempted.promise;
      release.resolve();
      await peer;
      await refused;
      const final = await loadFurnaceConfig(root);
      expect(final.overrides['moz-own']).toBeUndefined();
      expect(final.stock).toContain('moz-peer');
    }
  );
});
