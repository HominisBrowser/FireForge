// SPDX-License-Identifier: EUPL-1.2
import { unlink, writeFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reapTrackedHarnessPids } from '../../core/harness-helper-pids.js';
import { startParentExitWatchdog } from '../../core/parent-exit-watchdog.js';
import { warn } from '../../utils/logger.js';
import type { ProcessOwnership, ProcessTeardown } from '../../utils/process-group.js';
import {
  createHarnessTeardown,
  removeActivePgidFile,
  removePgidFile,
  setActivePgidFile,
} from '../test-harness-teardown.js';
import { addVerdictRunCount, emitKilledVerdict } from '../test-verdict.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(() => Promise.resolve()),
  unlink: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/harness-helper-pids.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/harness-helper-pids.js')>()),
  reapTrackedHarnessPids: vi.fn(() => Promise.resolve(0)),
}));
vi.mock('../../core/parent-exit-watchdog.js', () => ({
  startParentExitWatchdog: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../../utils/logger.js', () => ({ warn: vi.fn(), verbose: vi.fn() }));
vi.mock('../test-verdict.js', () => ({
  addVerdictRunCount: vi.fn(),
  emitKilledVerdict: vi.fn(() => true),
}));

const OBJ = '/proj/engine/obj-debug';

const QUIET_TEARDOWN: ProcessTeardown = { signalled: [], detached: [], stillAlive: [] };
const finishOwned = vi.fn(() => Promise.resolve(QUIET_TEARDOWN));
const anchorTo = vi.fn();

function owner(pid: number): ProcessOwnership {
  return {
    pid,
    finish: finishOwned,
    signal: vi.fn(),
    anchorTo,
    owns: vi.fn(() => Promise.resolve(false)),
    dispose: vi.fn(),
  };
}

/** Pulls the watchdog callback the teardown registered. */
function parentExitCallback(): (info: { originalPpid: number; currentPpid: number }) => void {
  const call = vi.mocked(startParentExitWatchdog).mock.calls.at(-1);
  if (!call) throw new Error('watchdog not started');
  return call[0].onParentExit;
}

describe('createHarnessTeardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('feeds tracked pids to the post-close reap and stamps what both teardowns terminated', async () => {
    const teardown = createHarnessTeardown({ objDir: OBJ, pgidFile: undefined });
    teardown.hooks.onProcessGroup?.(555, owner(555));
    teardown.hooks.onOutputChunk?.('stdout', 'INFO runtests.py | Server pid: 4242\n');
    finishOwned.mockResolvedValueOnce({
      ...QUIET_TEARDOWN,
      signalled: [{ pid: 556, start: 'x', parent: 555, group: 555 }],
    });
    vi.mocked(reapTrackedHarnessPids).mockResolvedValueOnce(1);

    await teardown.hooks.postCloseSweep?.();

    expect(anchorTo).toHaveBeenCalledWith([OBJ]);
    // A live process at that pid on the host adds its birth identity; the tracked pid and kind are what must reach the reap.
    expect(reapTrackedHarnessPids).toHaveBeenCalledWith(
      [expect.objectContaining({ pid: 4242, kind: 'Server' })],
      OBJ
    );
    expect(addVerdictRunCount).toHaveBeenCalledWith('orphans-reaped', 2);
    teardown.dispose();
  });

  it('publishes the process group id to the pgid file when asked', async () => {
    const { writeFile } = await import('node:fs/promises');
    const teardown = createHarnessTeardown({ objDir: OBJ, pgidFile: '/tmp/ff.pgid' });
    teardown.hooks.onProcessGroup?.(31337);
    await vi.waitFor(() => {
      expect(writeFile).toHaveBeenCalledWith('/tmp/ff.pgid', '31337\n', 'utf8');
    });
    teardown.dispose();
  });

  it('writes no file when no pgid file was requested', async () => {
    const { writeFile } = await import('node:fs/promises');
    const teardown = createHarnessTeardown({ objDir: OBJ, pgidFile: undefined });
    teardown.hooks.onProcessGroup?.(31337);
    await Promise.resolve();
    expect(writeFile).not.toHaveBeenCalled();
    teardown.dispose();
  });

  // The incident path: the supervisor killed the process above FireForge.
  // Verdict first, then the group, in that order, because the verdict is
  // the one line a log tail keeps and the sweep can take seconds.
  it('on parent exit writes the killed verdict and reaps the harness group', () => {
    const teardown = createHarnessTeardown({ objDir: OBJ, pgidFile: undefined });
    teardown.hooks.onProcessGroup?.(555, owner(555));

    parentExitCallback()({ originalPpid: 4000, currentPpid: 1 });

    expect(emitKilledVerdict).toHaveBeenCalledWith('parent-exit');
    expect(finishOwned).toHaveBeenCalledOnce();
    expect(vi.mocked(emitKilledVerdict).mock.invocationCallOrder[0]).toBeLessThan(
      finishOwned.mock.invocationCallOrder[0] ?? 0
    );
    teardown.dispose();
  });

  it('on parent exit before any spawn still writes the verdict and sweeps nothing', () => {
    createHarnessTeardown({ objDir: OBJ, pgidFile: undefined });
    parentExitCallback()({ originalPpid: 4000, currentPpid: 1 });
    expect(emitKilledVerdict).toHaveBeenCalledWith('parent-exit');
    expect(finishOwned).not.toHaveBeenCalled();
  });

  it('warns and carries on when the reap after a parent exit fails', async () => {
    finishOwned.mockRejectedValueOnce(new Error('census gone'));
    const teardown = createHarnessTeardown({ objDir: OBJ, pgidFile: undefined });
    teardown.hooks.onProcessGroup?.(4242, owner(4242));
    const { onParentExit } = vi.mocked(startParentExitWatchdog).mock.calls.at(-1)?.[0] ?? {};
    onParentExit?.({ originalPpid: 1, currentPpid: 2 });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('census gone'));
    });
  });

  it('warns and carries on when the pgid file cannot be written', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('read-only'));
    const teardown = createHarnessTeardown({ objDir: undefined, pgidFile: '/run/pgid' });
    teardown.hooks.onProcessGroup?.(4242, owner(4242));
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });
    expect(anchorTo).not.toHaveBeenCalled();
  });

  it('stops the watchdog on dispose', () => {
    const stop = vi.fn();
    vi.mocked(startParentExitWatchdog).mockReturnValueOnce({ stop });
    const teardown = createHarnessTeardown({ objDir: OBJ, pgidFile: undefined });
    teardown.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('removePgidFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes the file and tolerates a missing one', async () => {
    await removePgidFile('/tmp/ff.pgid');
    expect(unlink).toHaveBeenCalledWith('/tmp/ff.pgid');
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(removePgidFile('/tmp/ff.pgid')).resolves.toBeUndefined();
  });

  it('does nothing without a path', async () => {
    await removePgidFile(undefined);
    expect(unlink).not.toHaveBeenCalled();
  });

  // On SIGTERM the command's own finally loses the race to process.exit, so
  // the bin handler removes the registered file itself; once the command
  // has removed it, the signal path finds nothing registered.
  it('lets the signal pipeline remove the registered file exactly once', async () => {
    setActivePgidFile('/tmp/ff.pgid');
    await removeActivePgidFile();
    expect(unlink).toHaveBeenCalledWith('/tmp/ff.pgid');
    vi.mocked(unlink).mockClear();
    await removeActivePgidFile();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('forgets the registration when the command removes the file itself', async () => {
    setActivePgidFile('/tmp/ff.pgid');
    await removePgidFile('/tmp/ff.pgid');
    vi.mocked(unlink).mockClear();
    await removeActivePgidFile();
    expect(unlink).not.toHaveBeenCalled();
  });
});
