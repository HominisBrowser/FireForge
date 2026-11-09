// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authorFs from '../../core/authored/fs.js';
import { sourceGit } from '../../core/authored/git.js';
import * as furnaceConfiguration from '../../core/furnace-config.js';
import { loadFurnaceConfig, writeFurnaceConfig } from '../../core/furnace-config.js';
import { runFurnaceMutation } from '../../core/furnace-operation.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import { validateCompatibility } from '../../core/furnace-validate-compatibility.js';
import {
  checkRegistrationConsistency,
  validateJarMnEntries,
  validateRegistrationPatterns,
} from '../../core/furnace-validate-registration.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import * as rawFs from '../../utils/fs.js';
import { furnaceApplyCommand } from '../furnace/apply.js';
import { furnaceOverrideCommand } from '../furnace/override.js';
import { furnaceRenameCommand } from '../furnace/rename.js';
import { furnaceValidateCommand } from '../furnace/validate.js';

vi.mock('../../utils/logger.js', async () => {
  const { createLoggerMock } = await import('../../test-utils/module-mocks.js');
  return createLoggerMock();
});
const modulePath = 'toolkit/content/widgets/moz-old';
const jarPath = 'toolkit/content/jar.mn';
const properEntry = '   content/global/elements/moz-old.mjs (widgets/moz-old/moz-old.mjs)';
const component = {
  kind: 'library' as const,
  description: 'fixture',
  targetPath: modulePath,
  register: false,
  localized: false,
};
const base: FurnaceConfig = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {},
  custom: { 'moz-old': component },
};
function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {
    throw new Error('uninitialized barrier');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('A07 actual Furnace ownership and validators', () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempProject('fireforge-a07-authority-');
    await writeFireForgeConfig(root);
    await initCommittedRepo(join(root, 'engine'), {
      [jarPath]: `toolkit.jar:\n${properEntry}\n`,
      'toolkit/content/widgets/moz-card/moz-card.mjs': 'export class MozCard {}\n',
      'toolkit/content/widgets/moz-card/moz-card.css': ':host { border: var(--stock-channel); }\n',
      [`${modulePath}/moz-old.mjs`]: 'export class MozOld {}\n',
    });
    await writeFurnaceConfig(root, base);
    await writeFiles(root, { 'components/custom/moz-old/moz-old.mjs': 'export class MozOld {}\n' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempProject(root);
  });

  it('preserves a completed rename winner when a waiting rename fails its under-lock collision check', async () => {
    const entered = barrier(),
      release = barrier(),
      checked = barrier();
    const destination = join(root, 'components/custom/moz-new');
    const exists = authorFs.pathExists;
    vi.spyOn(authorFs, 'pathExists').mockImplementation(async (path) => {
      const result = await exists(path);
      if (path === destination && !result) checked.resolve();
      return result;
    });
    const peer = runFurnaceMutation(root, 'rename-rollback', async () => {
      entered.resolve();
      await release.promise;
      await writeFiles(root, { 'components/custom/moz-new/winner.txt': 'winner survives' });
      await writeFurnaceConfig(root, {
        ...base,
        custom: {
          ...base.custom,
          'moz-new': { ...component, targetPath: 'toolkit/content/widgets/moz-new' },
        },
      });
    });
    await entered.promise;
    const loser = furnaceRenameCommand(root, 'moz-old', 'moz-new');
    const refused = expect(loser).rejects.toThrow('already exists');
    await checked.promise;
    release.resolve();
    await peer;
    await refused;
    expect(await readFile(join(destination, 'winner.txt'), 'utf8')).toBe('winner survives');
    expect(await readFile(join(root, 'components/custom/moz-old/moz-old.mjs'), 'utf8')).toContain(
      'MozOld'
    );
    expect((await loadFurnaceConfig(root)).custom['moz-new']).toBeDefined();
  });

  it('preserves a completed same-name override winner after the waiting command passed its outer preflight', async () => {
    const entered = barrier(),
      release = barrier(),
      checked = barrier();
    const destination = join(root, 'components/overrides/moz-card');
    const exists = rawFs.pathExists;
    vi.spyOn(rawFs, 'pathExists').mockImplementation(async (path) => {
      const result = await exists(path);
      if (path === destination && !result) checked.resolve();
      return result;
    });
    const peer = runFurnaceMutation(root, 'override-rollback', async () => {
      entered.resolve();
      await release.promise;
      await writeFiles(root, { 'components/overrides/moz-card/moz-card.css': 'winner CSS' });
      await writeFurnaceConfig(root, {
        ...base,
        overrides: {
          'moz-card': {
            type: 'css-only',
            description: 'winner',
            basePath: 'toolkit/content/widgets/moz-card',
            baseVersion: '145.0',
          },
        },
      });
    });
    await entered.promise;
    const loser = furnaceOverrideCommand(root, 'moz-card', {
      type: 'css-only',
      description: 'loser',
    });
    const refused = expect(loser).rejects.toThrow('already exists');
    await checked.promise;
    release.resolve();
    await peer;
    await refused;
    expect(await readFile(join(destination, 'moz-card.css'), 'utf8')).toBe('winner CSS');
    expect((await loadFurnaceConfig(root)).overrides['moz-card']?.description).toBe('winner');
  });

  it.each(['nested-directory', 'symlink'])(
    'refuses unsupported rename entries without dropping %s content',
    async (kind) => {
      if (kind === 'nested-directory')
        await writeFiles(root, {
          'components/custom/moz-old/assets/icon.bin': Buffer.from([0, 0xff, 5]),
        });
      else {
        await writeFiles(root, { 'peer.bin': 'unrelated peer asset' });
        await symlink(join(root, 'peer.bin'), join(root, 'components/custom/moz-old/link'));
      }
      await expect(furnaceRenameCommand(root, 'moz-old', 'moz-new')).rejects.toThrow(
        'directory, symlink or special entry'
      );
      expect(await readFile(join(root, 'components/custom/moz-old/moz-old.mjs'), 'utf8')).toContain(
        'MozOld'
      );
      expect((await loadFurnaceConfig(root)).custom['moz-old']).toBeDefined();
      expect(await rawFs.pathExists(join(root, 'components/custom/moz-new'))).toBe(false);
      if (kind === 'nested-directory')
        expect(await readFile(join(root, 'components/custom/moz-old/assets/icon.bin'))).toEqual(
          Buffer.from([0, 0xff, 5])
        );
      else expect(await readFile(join(root, 'peer.bin'), 'utf8')).toBe('unrelated peer asset');
    }
  );

  it('renames package registrations for a register:false library without creating an element registration', async () => {
    await furnaceRenameCommand(root, 'moz-old', 'moz-new');
    const jar = await readFile(join(root, 'engine', jarPath), 'utf8');
    expect(jar).toContain('content/global/elements/moz-new.mjs');
    expect(jar).not.toContain('moz-old');
    expect(await rawFs.pathExists(join(root, 'engine/toolkit/content/customElements.js'))).toBe(
      false
    );
  });

  it('removes stale package lines when an unregistered library deletes a deployed stylesheet', async () => {
    await writeFiles(root, { 'components/custom/moz-old/moz-old.css': ':host {}\n' });
    await furnaceApplyCommand(root);
    expect(await readFile(join(root, 'engine', jarPath), 'utf8')).toContain('moz-old.css');
    await rm(join(root, 'components/custom/moz-old/moz-old.css'));
    await furnaceApplyCommand(root);
    expect(await readFile(join(root, 'engine', jarPath), 'utf8')).not.toContain('moz-old.css');
    expect(await rawFs.pathExists(join(root, 'engine', modulePath, 'moz-old.css'))).toBe(false);
  });

  it.each([
    '# content/global/elements/moz-old.mjs (widgets/moz-old/moz-old.mjs)',
    '   content/global/elements/moz-old.mjs.extra (widgets/moz-old/moz-old.mjs.extra)',
    '   content/global/elements/moz-old.mjs (widgets/somebody-else/moz-old.mjs)',
  ])('refuses a comment, suffix or wrong-source package entry: %s', async (line) => {
    await writeFiles(root, { [`engine/${jarPath}`]: `toolkit.jar:\n${line}\n` });
    const issues = await validateJarMnEntries(root, base);
    expect(issues.some((issue) => issue.check === 'missing-jar-mn-mjs')).toBe(true);
    expect((await checkRegistrationConsistency(root, 'moz-old', component)).jarMnMjs).toBe(false);
    const named = await validateComponent(
      join(root, 'components/custom/moz-old'),
      'moz-old',
      'custom',
      base,
      root
    );
    expect(named.some((issue) => issue.check === 'missing-jar-mn-mjs')).toBe(true);
  });

  it('does not count missing required manifests as a clean validation', async () => {
    await rm(join(root, 'engine', jarPath));
    expect(
      (await validateJarMnEntries(root, base)).some((issue) => issue.check === 'missing-jar-mn-mjs')
    ).toBe(true);
    const registered = { ...base, custom: { 'moz-old': { ...component, register: true } } };
    expect(
      (await validateRegistrationPatterns(root, registered)).some(
        (issue) => issue.check === 'missing-custom-element-registration'
      )
    ).toBe(true);
  });

  it('fixes fresh registration findings under the shared lock while preserving a completed peer entry', async () => {
    await writeFiles(root, { [`engine/${jarPath}`]: 'toolkit.jar:\n' });
    const entered = barrier(),
      release = barrier(),
      checked = barrier();
    const peer = runFurnaceMutation(root, 'apply-rollback', async () => {
      entered.resolve();
      await release.promise;
      await writeFiles(root, {
        [`engine/${jarPath}`]:
          'toolkit.jar:\n   content/global/elements/moz-peer.mjs (widgets/moz-peer/moz-peer.mjs)\n',
      });
    });
    await entered.promise;
    const load = furnaceConfiguration.loadFurnaceConfig;
    vi.spyOn(furnaceConfiguration, 'loadFurnaceConfig').mockImplementation(async (path) => {
      const config = await load(path);
      checked.resolve();
      return config;
    });
    const fixing = furnaceValidateCommand(root, 'moz-old', { fix: true });
    await checked.promise;
    release.resolve();
    await peer;
    await fixing;
    const jar = await readFile(join(root, 'engine', jarPath), 'utf8');
    expect(jar).toContain('moz-peer.mjs (widgets/moz-peer/moz-peer.mjs)');
    expect(jar).toMatch(/moz-old\.mjs\s+\(widgets\/moz-old\/moz-old\.mjs\)/);
  });

  it('rolls back an actual fix publication when the writer reports failure', async () => {
    const original = 'toolkit.jar:\n   content/global/existing.js (existing.js)\n';
    await writeFiles(root, { [`engine/${jarPath}`]: original });
    const write = rawFs.writeText;
    vi.spyOn(rawFs, 'writeText').mockImplementation(async (path, content) => {
      await write(path, content);
      if (path === join(root, 'engine', jarPath))
        throw new Error('fixture IO fault after publication');
    });
    await expect(furnaceValidateCommand(root, 'moz-old', { fix: true })).rejects.toThrow(
      'fixture IO fault'
    );
    expect(await readFile(join(root, 'engine', jarPath), 'utf8')).toBe(original);
  });

  it('does not let synthetic typecheck warnings satisfy the actual component floor', async () => {
    const config = { ...base, minComponents: 2, typecheckTagMap: 'types/furnace-tags.d.ts' };
    await writeFurnaceConfig(root, config);
    const results = await validateAllComponents(root);
    expect(results.has('moz-old')).toBe(true);
    expect(results.has('furnace')).toBe(true);
    await expect(furnaceValidateCommand(root)).rejects.toThrow('Validation failed with 1 error');
  });

  it('uses immutable pinned CSS for inherited variables before and after override deployment', async () => {
    const commit = (await sourceGit(join(root, 'engine'), ['rev-parse', 'HEAD'])).toString().trim();
    const config: FurnaceConfig = {
      ...base,
      tokenPrefix: '--test-',
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'fixture',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
          baseCommit: commit,
        },
      },
    };
    const css = ':host { border: var(--stock-channel); color: var(--intruder); }\n';
    const directory = join(root, 'components/overrides/moz-card');
    await writeFiles(root, { 'components/overrides/moz-card/moz-card.css': css });
    const before = await validateCompatibility(directory, 'moz-card', 'override', config, root);
    await writeFiles(root, { 'engine/toolkit/content/widgets/moz-card/moz-card.css': css });
    const after = await validateCompatibility(directory, 'moz-card', 'override', config, root);
    expect(after).toEqual(before);
    expect(after.filter((issue) => issue.check === 'token-prefix-violation')).toHaveLength(1);
    expect(after.find((issue) => issue.check === 'token-prefix-violation')?.message).toContain(
      '--intruder'
    );
  });
});
