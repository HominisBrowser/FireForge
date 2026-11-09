// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { exec } from '../../utils/process.js';
import { sameProcess } from '../../utils/process-birth.js';
import { PS_BINARY } from '../../utils/process-listing.js';
import {
  createHelperPidTracker,
  isStillTrackedProcess,
  reapTrackedHarnessPids,
} from '../harness-helper-pids.js';
import { terminateHarnessProcesses } from '../harness-orphans.js';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));
vi.mock('../../utils/process-birth.js', () => ({
  processIdentity: vi.fn(() => undefined),
  sameProcess: vi.fn(() => true),
}));
vi.mock('../../utils/logger.js', () => ({ warn: vi.fn(), info: vi.fn(), verbose: vi.fn() }));
vi.mock('../harness-orphans.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness-orphans.js')>()),
  terminateHarnessProcesses: vi.fn(() => Promise.resolve(0)),
}));

const OBJ = '/Users/dev/proj/engine/obj-aarch64-apple-darwin';

// The five announcements `testing/mochitest/runtests.py` makes, with the
// mozlog prefix in front the way they arrive on stdout.
const ANNOUNCEMENTS = [
  ' 0:02.11 INFO runtests.py | Server pid: 19141',
  ' 0:02.12 INFO runtests.py | Websocket server pid: 19142',
  ' 0:02.20 INFO runtests.py | SSL tunnel pid: 19143',
  ' 0:02.31 INFO runtests.py | websocket/process bridge pid: 19144',
  ' 0:05.00 INFO runtests.py | Application pid: 19150',
];

describe('createHelperPidTracker', () => {
  it('collects every announced helper in order, once', () => {
    const tracker = createHelperPidTracker();
    tracker.feed('stdout', `${ANNOUNCEMENTS.join('\n')}\n`);
    tracker.feed('stdout', `${ANNOUNCEMENTS[0]}\n`); // the same line again
    expect(tracker.tracked()).toEqual([
      { pid: 19141, kind: 'Server' },
      { pid: 19142, kind: 'Websocket server' },
      { pid: 19143, kind: 'SSL tunnel' },
      { pid: 19144, kind: 'websocket/process bridge' },
      { pid: 19150, kind: 'Application' },
    ]);
  });

  // execStream hands over whatever the pipe produced, so the announcement
  // can be split anywhere, including inside the number.
  it('reassembles a line split across chunks', () => {
    const tracker = createHelperPidTracker();
    tracker.feed('stdout', ' 0:02.11 INFO runtests.py | Serv');
    tracker.feed('stdout', 'er pid: 191');
    expect(tracker.tracked()).toEqual([]);
    tracker.feed('stdout', '41\n 0:02.12 INFO');
    expect(tracker.tracked()).toEqual([{ pid: 19141, kind: 'Server' }]);
  });

  it('keeps the two streams apart so their half-lines cannot merge', () => {
    const tracker = createHelperPidTracker();
    tracker.feed('stdout', 'runtests.py | Server pid: 1');
    tracker.feed('stderr', '2\n');
    tracker.feed('stdout', '9141\n');
    expect(tracker.tracked()).toEqual([{ pid: 19141, kind: 'Server' }]);
  });

  it('ignores lines that merely mention a pid', () => {
    const tracker = createHelperPidTracker();
    tracker.feed('stdout', 'runtests.py | Application pid 19150 exited\nGECKO(19150) | foo\n');
    expect(tracker.tracked()).toEqual([]);
  });
});

describe('isStillTrackedProcess', () => {
  it('accepts a helper that is still helper-shaped under the objdir', () => {
    expect(
      isStillTrackedProcess(
        { pid: 1, kind: 'Server' },
        `${OBJ}/dist/bin/xpcshell -g ${OBJ}/dist/bin -f ${OBJ}/_tests/testing/mochitest/server.js`,
        OBJ
      )
    ).toBe(true);
  });

  // The browser binary has no helper-shaped name, so the objdir anchor is
  // the attribution: it lives under `<objdir>/dist/`.
  it('accepts the browser on the objdir anchor alone', () => {
    const app = `${OBJ}/dist/Hominis.app/Contents/MacOS/hominis -marionette -profile /tmp/p`;
    expect(isStillTrackedProcess({ pid: 1, kind: 'Application' }, app, OBJ)).toBe(true);
    expect(isStillTrackedProcess({ pid: 1, kind: 'Server' }, app, OBJ)).toBe(false);
  });

  // A pid recycled onto something else between the launch line and the
  // teardown must not be signalled on the strength of the number alone.
  it('rejects a pid that now belongs to an unrelated process', () => {
    expect(
      isStillTrackedProcess({ pid: 1, kind: 'Server' }, 'node /home/dev/app/server.js', OBJ)
    ).toBe(false);
    expect(
      isStillTrackedProcess({ pid: 1, kind: 'Application' }, '/usr/bin/vim notes.md', OBJ)
    ).toBe(false);
  });
});

describe('reapTrackedHarnessPids', () => {
  const originalPlatform = process.platform;
  function stubPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }
  afterAll(() => {
    stubPlatform(originalPlatform);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    stubPlatform('darwin');
  });

  const TRACKED = [
    { pid: 19141, kind: 'Server' as const, identity: { pid: 19141, start: 'owned' } },
    { pid: 19143, kind: 'SSL tunnel' as const, identity: { pid: 19143, start: 'owned' } },
    { pid: 19150, kind: 'Application' as const, identity: { pid: 19150, start: 'owned' } },
  ];

  function stubAlive(alive: readonly number[]): MockInstance<typeof process.kill> {
    return vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (alive.includes(pid)) return true;
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
  }

  it('does nothing when every tracked pid already exited', async () => {
    const kill = stubAlive([]);
    try {
      expect(await reapTrackedHarnessPids(TRACKED, OBJ)).toBe(0);
      expect(exec).not.toHaveBeenCalled();
      expect(terminateHarnessProcesses).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('re-reads survivors from ps and terminates only the attributable ones', async () => {
    const kill = stubAlive([19141, 19143, 19150]);
    vi.mocked(exec).mockResolvedValue({
      stdout: [
        `19141 ${OBJ}/dist/bin/xpcshell -f ${OBJ}/_tests/testing/mochitest/server.js`,
        // 19143 was recycled onto something unrelated.
        '19143 /usr/local/bin/some-daemon --port 9',
        `19150 ${OBJ}/dist/Hominis.app/Contents/MacOS/hominis -marionette`,
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
    vi.mocked(terminateHarnessProcesses).mockResolvedValue(2);
    try {
      expect(await reapTrackedHarnessPids(TRACKED, OBJ)).toBe(2);
      expect(exec).toHaveBeenCalledWith(
        PS_BINARY,
        ['-o', 'pid=,command=', '-p', '19141,19143,19150'],
        expect.anything()
      );
      expect(terminateHarnessProcesses).toHaveBeenCalledWith(
        [TRACKED[0], TRACKED[2]],
        'harness teardown',
        expect.any(Function)
      );
    } finally {
      kill.mockRestore();
    }
  });

  // `ps -p` exits 1 when one of the listed pids is gone but still prints the
  // others, so the exit code must not abort the reap.
  it('tolerates a non-zero ps exit for a pid that vanished mid-probe', async () => {
    const kill = stubAlive([19141, 19143]);
    vi.mocked(exec).mockResolvedValue({
      stdout: `19143 ${OBJ}/dist/bin/ssltunnel -c /tmp/ssltunnel.cfg\n`,
      stderr: '',
      exitCode: 1,
    });
    vi.mocked(terminateHarnessProcesses).mockResolvedValue(1);
    try {
      expect(await reapTrackedHarnessPids(TRACKED, OBJ)).toBe(1);
      expect(terminateHarnessProcesses).toHaveBeenCalledWith(
        [TRACKED[1]],
        'harness teardown',
        expect.any(Function)
      );
    } finally {
      kill.mockRestore();
    }
  });

  it('reaps nothing when ps itself cannot run', async () => {
    const kill = stubAlive([19141]);
    vi.mocked(exec).mockRejectedValue(new Error('ENOENT'));
    try {
      expect(await reapTrackedHarnessPids(TRACKED, OBJ)).toBe(0);
      expect(terminateHarnessProcesses).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('is a no-op on Windows', async () => {
    stubPlatform('win32');
    const kill = vi.spyOn(process, 'kill');
    try {
      expect(await reapTrackedHarnessPids(TRACKED, OBJ)).toBe(0);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('never signals a recycled PID even when it was announced by this run', async () => {
    const kill = stubAlive([19141]);
    vi.mocked(sameProcess).mockReturnValueOnce(false);
    try {
      expect(await reapTrackedHarnessPids(TRACKED.slice(0, 1), OBJ)).toBe(0);
      expect(terminateHarnessProcesses).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('rechecks positive start identity at termination and refuses unknown or recycled targets', async () => {
    const kill = stubAlive([19141]);
    vi.mocked(exec).mockResolvedValue({
      stdout: `19141 ${OBJ}/dist/bin/xpcshell -f ${OBJ}/_tests/testing/mochitest/server.js`,
      stderr: '',
      exitCode: 0,
    });
    vi.mocked(terminateHarnessProcesses).mockImplementationOnce((_targets, _label, owns) => {
      expect(owns(19141)).toBe(true);
      vi.mocked(sameProcess).mockReturnValueOnce(false);
      expect(owns(19141)).toBe(false);
      expect(owns(99999)).toBe(false);
      return Promise.resolve(0);
    });
    try {
      expect(await reapTrackedHarnessPids(TRACKED.slice(0, 1), OBJ)).toBe(0);
    } finally {
      kill.mockRestore();
    }
  });

  // mozserve starts moz-http2 in its own session and never logs its pid, so it
  // is in neither the group nor the tracker. A path-shaped process cannot be told
  // from a peer's, so nothing but an announcement makes it this run's to signal.
  it('never looks beyond what the harness announced', async () => {
    const kill = stubAlive([]);
    try {
      expect(await reapTrackedHarnessPids(TRACKED, OBJ)).toBe(0);
      expect(exec).not.toHaveBeenCalled();
      expect(terminateHarnessProcesses).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
