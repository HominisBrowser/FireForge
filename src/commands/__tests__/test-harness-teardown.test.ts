// SPDX-License-Identifier: EUPL-1.2
import { unlink } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reapTrackedHarnessPids, snapshotObjdirHelpers } from '../../core/harness-helper-pids.js';
import { startParentExitWatchdog } from '../../core/parent-exit-watchdog.js';
import { sweepProcessGroup } from '../../utils/process-group.js';
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
  snapshotObjdirHelpers: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../../core/parent-exit-watchdog.js', () => ({
  startParentExitWatchdog: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../../utils/process-group.js', () => ({
  sweepProcessGroup: vi.fn(() => Promise.resolve({ survivors: [] })),
}));
vi.mock('../../utils/logger.js', () => ({ warn: vi.fn(), verbose: vi.fn() }));
vi.mock('../test-verdict.js', () => ({
  addVerdictRunCount: vi.fn(),
  emitKilledVerdict: vi.fn(() => true),
}));

const OBJ = '/proj/engine/obj-debug';

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

  it('feeds tracked pids and the pre-dispatch baseline to the post-close reap and stamps the count', async () => {
    const teardown = createHarnessTeardown({ objDir: OBJ, pgidFile: undefined });
    vi.mocked(snapshotObjdirHelpers).mockResolvedValueOnce(new Set([19144]));
    await teardown.prepare();
    teardown.hooks.onOutputChunk?.('stdout', 'INFO runtests.py | Server pid: 4242\n');
    vi.mocked(reapTrackedHarnessPids).mockResolvedValueOnce(1);

    await teardown.hooks.postCloseSweep?.();

    expect(snapshotObjdirHelpers).toHaveBeenCalledWith(OBJ);
    expect(reapTrackedHarnessPids).toHaveBeenCalledWith(
      [{ pid: 4242, kind: 'Server' }],
      OBJ,
      new Set([19144])
    );
    expect(addVerdictRunCount).toHaveBeenCalledWith('orphans-reaped', 1);
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
    teardown.hooks.onProcessGroup?.(555);

    parentExitCallback()({ originalPpid: 4000, currentPpid: 1 });

    expect(emitKilledVerdict).toHaveBeenCalledWith('parent-exit');
    expect(sweepProcessGroup).toHaveBeenCalledWith(
      555,
      undefined,
      'after the parent process exited'
    );
    expect(vi.mocked(emitKilledVerdict).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sweepProcessGroup).mock.invocationCallOrder[0] ?? 0
    );
    teardown.dispose();
  });

  it('on parent exit before any spawn still writes the verdict and sweeps nothing', () => {
    createHarnessTeardown({ objDir: OBJ, pgidFile: undefined });
    parentExitCallback()({ originalPpid: 4000, currentPpid: 1 });
    expect(emitKilledVerdict).toHaveBeenCalledWith('parent-exit');
    expect(sweepProcessGroup).not.toHaveBeenCalled();
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
