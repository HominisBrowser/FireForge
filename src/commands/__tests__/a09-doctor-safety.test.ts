// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getProjectPaths } from '../../core/config.js';
import { readLockStatus, withFileLock } from '../../core/file-lock.js';
import { loadFurnaceState, updateFurnaceState } from '../../core/furnace-config.js';
import { getFurnaceLockPath } from '../../core/furnace-operation.js';
import {
  createRollbackJournal,
  removeEmptyDirectory,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { validateAllComponents } from '../../core/furnace-validate.js';
import {
  createTempProject,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { FurnaceConfig, FurnacePendingRepair } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import type { DoctorCheckContext, DoctorCheckDefinition } from '../doctor-check-core.js';
import { FURNACE_DOCTOR_CHECKS } from '../doctor-furnace.js';
import { furnaceStaleJarRegistrationCheck } from '../doctor-furnace-jar.js';
import { runDoctorFurnaceRepair } from '../doctor-furnace-transaction.js';

vi.mock('../../core/furnace-apply-helpers.js', () => ({
  hasCustomEngineDrift: () => Promise.resolve(false),
  hasOverrideEngineDrift: () => Promise.resolve(false),
}));
vi.mock('../../core/furnace-validate.js', () => ({
  validateAllComponents: vi.fn(() => Promise.resolve(new Map())),
}));

let root: string;
const oldMarker: FurnacePendingRepair = {
  operation: 'create-rollback',
  timestamp: '2026-01-01T00:00:00.000Z',
  reason: 'old',
};
const newMarker: FurnacePendingRepair = {
  ...oldMarker,
  timestamp: '2026-01-02T00:00:00.000Z',
  reason: 'new owner',
};
const config: FurnaceConfig = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {},
  custom: {},
};
beforeEach(async () => {
  root = await createTempProject('ff-a09-doctor-');
  await writeFireForgeConfig(root);
  await mkdir(join(root, 'engine'), { recursive: true });
  await writeFile(join(root, 'furnace.json'), JSON.stringify(config));
  await updateFurnaceState(root, (state) => ({ ...state, pendingRepair: oldMarker }));
  vi.mocked(validateAllComponents).mockReset().mockResolvedValue(new Map());
});
afterEach(async () => {
  await removeTempProject(root);
});
function context(furnaceConfig = config): DoctorCheckContext {
  return {
    projectRoot: root,
    paths: getProjectPaths(root),
    state: {},
    options: { repairFurnace: true },
    engineExists: true,
    config: undefined,
    furnaceConfigExists: true,
    furnaceConfig,
    mutations: [],
  };
}
function engineCheck(): DoctorCheckDefinition {
  const check = FURNACE_DOCTOR_CHECKS.find((entry) => entry.name === 'Furnace engine state');
  if (!check) throw new Error('missing check');
  return check;
}
async function blockedRepair(run: () => unknown, mutate: () => Promise<void>): Promise<unknown> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const lock = withFileLock(getFurnaceLockPath(root), async () => {
    acquired();
    await released;
  });
  await ready;
  const result = run();
  await vi.waitFor(async () => {
    expect((await readLockStatus(getFurnaceLockPath(root))).queueDepth).toBeGreaterThan(0);
  });
  await mutate();
  release();
  await lock;
  return result;
}
it('retains a different pending marker installed while Doctor waits for the Furnace lock', async () => {
  const result = await blockedRepair(
    () => engineCheck().run(context()),
    async () => {
      await updateFurnaceState(root, (state) => ({ ...state, pendingRepair: newMarker }));
    }
  );
  expect(result).toMatchObject({
    severity: 'error',
    message: expect.stringContaining('changed while waiting') as string,
  });
  expect((await loadFurnaceState(root)).pendingRepair).toEqual(newMarker);
  expect(validateAllComponents).not.toHaveBeenCalled();
});
it('holds ownership through validation and refuses to clear a later marker without rolling it back', async () => {
  vi.mocked(validateAllComponents).mockImplementation(async () => {
    expect(await pathExists(getFurnaceLockPath(root))).toBe(true);
    await updateFurnaceState(root, (state) => ({ ...state, pendingRepair: newMarker }));
    return new Map();
  });
  const result = await engineCheck().run(context());
  expect(result).toMatchObject({
    severity: 'error',
    message: expect.stringContaining('changed during repair') as string,
  });
  expect((await loadFurnaceState(root)).pendingRepair).toEqual(newMarker);
});
it('clears the exact validated authoring marker while still inside the repair transaction', async () => {
  vi.mocked(validateAllComponents).mockImplementation(async () => {
    expect(await pathExists(getFurnaceLockPath(root))).toBe(true);
    return new Map();
  });
  expect(await engineCheck().run(context())).toMatchObject({
    severity: 'warning',
    message: expect.stringContaining('after validation passed') as string,
  });
  expect((await loadFurnaceState(root)).pendingRepair).toBeUndefined();
});
it('recomputes jar managed tags after acquiring ownership instead of pruning a stale snapshot', async () => {
  const custom = {
    description: 'fixture',
    targetPath: 'toolkit/content/widgets/moz-old',
    localized: false,
    register: true,
  };
  const stale: FurnaceConfig = { ...config, custom: { 'moz-old': custom } };
  const jar = join(root, 'engine/toolkit/content/jar.mn');
  await mkdir(join(root, 'engine/toolkit/content'), { recursive: true });
  const text = 'toolkit.jar:\n   content/global/elements/old.mjs (widgets/moz-old/old.mjs)\n';
  await writeFile(jar, text);
  await writeFile(join(root, 'furnace.json'), JSON.stringify(stale));
  await blockedRepair(
    () => furnaceStaleJarRegistrationCheck.run(context(stale)),
    async () => {
      await writeFile(join(root, 'furnace.json'), JSON.stringify(config));
    }
  );
  expect(await readFile(jar, 'utf8')).toBe(text);
});
it('restores journaled config, engine bytes and a removed empty directory when repair fails', async () => {
  const path = join(root, 'engine/jar.mn'),
    empty = join(root, 'components/custom/empty');
  await writeFile(path, 'before');
  await mkdir(empty, { recursive: true, mode: 0o750 });
  await expect(
    runDoctorFurnaceRepair(root, async (operation) => {
      const journal = createRollbackJournal();
      await snapshotFile(journal, path);
      operation.registerJournal(journal);
      await writeFile(path, 'after');
      await writeFile(
        join(root, 'furnace.json'),
        JSON.stringify({ ...config, tokenPrefix: '--changed-' })
      );
      await removeEmptyDirectory(journal, empty);
      throw new Error('injected repair failure');
    })
  ).rejects.toThrow('injected repair failure');
  expect(await readFile(path, 'utf8')).toBe('before');
  expect(JSON.parse(await readFile(join(root, 'furnace.json'), 'utf8'))).toEqual(config);
  expect((await stat(empty)).mode & 0o777).toBe(0o750);
});

it('recomputes stale checksums from the config acquired under ownership', async () => {
  await updateFurnaceState(root, (state) => ({
    ...state,
    appliedChecksums: { 'custom/moz-new/new.mjs': 'digest' },
  }));
  const check = FURNACE_DOCTOR_CHECKS.find((entry) => entry.name === 'Furnace state consistency');
  if (!check) throw new Error('missing consistency check');
  await blockedRepair(
    () => check.run(context()),
    async () => {
      await writeFile(
        join(root, 'furnace.json'),
        JSON.stringify({
          ...config,
          custom: {
            'moz-new': {
              targetPath: 'toolkit/content/widgets/moz-new',
              localized: false,
              register: false,
              description: 'new owner',
            },
          },
        })
      );
    }
  );
  expect((await loadFurnaceState(root)).appliedChecksums).toEqual({
    'custom/moz-new/new.mjs': 'digest',
  });
});
