// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn((root: string) => ({ root, engine: `${root}/engine` })),
  loadConfig: vi.fn(() => Promise.resolve({ binaryName: 'mybrowser' })),
}));
vi.mock('../../core/mach.js', () => ({
  hasBuildArtifacts: vi.fn(),
  hasRunnableBundle: vi.fn(),
}));
vi.mock('../../core/marionette-port.js', () => ({
  ensureLaunchableBrowserNotRunning: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/preflight-wait.js', () => ({
  waitBeforeLock: vi.fn((action: () => Promise<void>) => action()),
}));
vi.mock('../../utils/fs.js', () => ({ pathExists: vi.fn(() => Promise.resolve(true)) }));

import { loadConfig } from '../../core/config.js';
import { hasBuildArtifacts, hasRunnableBundle } from '../../core/mach.js';
import { ensureLaunchableBrowserNotRunning } from '../../core/marionette-port.js';
import { waitBeforeLock } from '../../core/preflight-wait.js';
import { pathExists } from '../../utils/fs.js';
import { waitForBuildBrowserBeforeLock } from '../build-prelock.js';

const APP = 'obj-debug/dist/bin/mybrowser';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
  vi.mocked(hasRunnableBundle).mockResolvedValue({ runnable: true, expectedPath: APP });
});

describe('waitForBuildBrowserBeforeLock', () => {
  it('waits out the browser before the lock and strips the spent budget', async () => {
    await expect(
      waitForBuildBrowserBeforeLock('/project', { waitBrowser: 300, ui: true })
    ).resolves.toEqual({ ui: true });
    expect(waitBeforeLock).toHaveBeenCalledWith(expect.any(Function), 300);
    expect(ensureLaunchableBrowserNotRunning).toHaveBeenCalledWith(`/project/engine/${APP}`);
  });

  it('does nothing without --wait-browser', async () => {
    const options = { ui: true };
    await expect(waitForBuildBrowserBeforeLock('/project', options)).resolves.toBe(options);
    expect(hasBuildArtifacts).not.toHaveBeenCalled();
  });

  it.each([
    ['no engine', () => vi.mocked(pathExists).mockResolvedValueOnce(false)],
    ['no objdir', () => vi.mocked(hasBuildArtifacts).mockResolvedValueOnce({ exists: false })],
    ['an unreadable config', () => vi.mocked(loadConfig).mockRejectedValueOnce(new Error('bad'))],
    [
      'no launchable bundle',
      () => vi.mocked(hasRunnableBundle).mockResolvedValueOnce({ runnable: false }),
    ],
  ])('leaves the budget to the in-lock check with %s', async (_label, arrange) => {
    arrange();
    const options = { waitBrowser: true };
    await expect(waitForBuildBrowserBeforeLock('/project', options)).resolves.toBe(options);
    expect(waitBeforeLock).not.toHaveBeenCalled();
  });
});
