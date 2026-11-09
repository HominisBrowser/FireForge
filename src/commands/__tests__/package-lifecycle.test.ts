// SPDX-License-Identifier: EUPL-1.2
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assessBuildProvenance } from '../../core/build-provenance.js';
import {
  readEngineSessionLockStatus,
  withEngineSessionLock,
} from '../../core/engine-session-lock.js';
import { machPackageCapture, withBuildLock } from '../../core/mach.js';
import { ensureLaunchableBrowserNotRunning } from '../../core/marionette-port.js';
import { PreflightRefusalError } from '../../errors/base.js';
import {
  createTempProject,
  DEFAULT_CONFIG,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import { packageCommand } from '../package.js';

vi.mock('../../core/build-prepare.js', () => ({
  assertNoPendingFurnaceRepair: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/build-provenance.js', () => ({ assessBuildProvenance: vi.fn() }));
vi.mock('../../core/furnace-staleness.js', () => ({
  listStaleFurnaceComponents: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../core/mach.js', async (original) => ({
  ...(await original<typeof import('../../core/mach.js')>()),
  hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-fixture' })),
  machPackageCapture: vi.fn(),
}));
vi.mock('../../core/mach-build-artifacts.js', async (original) => ({
  ...(await original<typeof import('../../core/mach-build-artifacts.js')>()),
  hasRunnableBundle: vi.fn(() =>
    Promise.resolve({ runnable: true, expectedPath: 'obj-fixture/dist/bin/mybrowser' })
  ),
}));
vi.mock('../../core/marionette-port.js', () => ({ ensureLaunchableBrowserNotRunning: vi.fn() }));
vi.mock('../../utils/logger.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createLoggerMock()
);
let root: string;
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  root = await createTempProject('ff-package-lifecycle-');
  await mkdir(join(root, 'engine'));
  await writeFiles(root, { 'fireforge.json': JSON.stringify(DEFAULT_CONFIG) });
  vi.clearAllMocks();
  vi.mocked(assessBuildProvenance).mockResolvedValue({});
  vi.mocked(machPackageCapture).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  vi.mocked(ensureLaunchableBrowserNotRunning).mockResolvedValue(undefined);
  vi.stubEnv('FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST', '1');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTempProject(root);
});

describe('whole packaging lifecycle serialization', () => {
  it('does not judge the build or dispatch while a peer owns the engine', async () => {
    const entered = deferred(),
      release = deferred();
    const peer = withEngineSessionLock(root, 'peer-build', async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const packaging = packageCommand(root, { waitLock: 5 });
    try {
      await vi.waitFor(async () => {
        expect((await readEngineSessionLockStatus(root)).queueDepth).toBe(1);
      });
      expect(assessBuildProvenance).not.toHaveBeenCalled();
      expect(machPackageCapture).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([peer, packaging]);
    }
    expect(machPackageCapture).toHaveBeenCalledOnce();
  });

  it('takes the engine before waiting for the build lock, and judges the build only once both are held', async () => {
    const entered = deferred(),
      release = deferred();
    const peer = withBuildLock(root, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const packaging = packageCommand(root, {});
    try {
      await vi.waitFor(async () => {
        expect((await readEngineSessionLockStatus(root)).held).toBe(true);
      });
      expect(assessBuildProvenance).not.toHaveBeenCalled();
      expect(machPackageCapture).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([peer, packaging]);
    }
    expect(assessBuildProvenance).toHaveBeenCalledOnce();
  });

  it('refuses a running browser before judging the build', async () => {
    vi.mocked(ensureLaunchableBrowserNotRunning).mockRejectedValueOnce(
      new PreflightRefusalError('Browser is running', 'browser-running')
    );
    await expect(packageCommand(root, {})).rejects.toThrow('Browser is running');
    expect(assessBuildProvenance).not.toHaveBeenCalled();
    expect(machPackageCapture).not.toHaveBeenCalled();
    expect((await readEngineSessionLockStatus(root)).held).toBe(false);
  });
});
