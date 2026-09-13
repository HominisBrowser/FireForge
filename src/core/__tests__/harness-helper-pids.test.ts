// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { exec } from '../../utils/process.js';
import {
  createHelperPidTracker,
  isStillTrackedProcess,
  reapTrackedHarnessPids,
  snapshotObjdirHelpers,
} from '../harness-helper-pids.js';
import { terminateHarnessProcesses } from '../harness-orphans.js';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));
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
    { pid: 19141, kind: 'Server' as const },
    { pid: 19143, kind: 'SSL tunnel' as const },
    { pid: 19150, kind: 'Application' as const },
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
        'ps',
        ['-o', 'pid=,command=', '-p', '19141,19143,19150'],
        expect.anything()
      );
      expect(terminateHarnessProcesses).toHaveBeenCalledWith(
        [TRACKED[0], TRACKED[2]],
        'harness teardown'
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
      expect(terminateHarnessProcesses).toHaveBeenCalledWith([TRACKED[1]], 'harness teardown');
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

  // mozserve starts moz-http2 in its own session and never logs its pid, so
  // it is in neither the group nor the tracker. It was the incident's
  // second survivor. The post-close scan finds it as a helper under THIS
  // objdir that appeared since the baseline and has lost its parent.
  describe('unannounced survivors', () => {
    const OLD_SURVIVOR = `19144     1 /Users/user/.mozbuild/node/bin/node ${OBJ}/_tests/testing/mochitest/xpcshell/moz-http2/moz-http2.js`;
    const NEW_SURVIVOR = `75376     1 /Users/user/.mozbuild/node/bin/node ${OBJ}/_tests/testing/mochitest/xpcshell/moz-http2/moz-http2.js`;
    // A sibling checkout's live harness: same shape, different absolute objdir, parent alive.
    const SIBLING = `80001 80000 /Users/dev/other/engine/obj-aarch64-apple-darwin/dist/bin/ssltunnel -c x`;
    // This objdir's httpd still parented by a live runtests.py (a peer's run mid-flight).
    const LIVE_CHILD = `80011 80010 ${OBJ}/dist/bin/xpcshell -f ${OBJ}/_tests/testing/mochitest/server.js`;

    it('snapshots the same-objdir helpers alive before the dispatch', async () => {
      vi.mocked(exec).mockResolvedValueOnce({
        stdout: [OLD_SURVIVOR, SIBLING, LIVE_CHILD].join('\n'),
        stderr: '',
        exitCode: 0,
      });
      expect(await snapshotObjdirHelpers(OBJ)).toEqual(new Set([19144, 80011]));
      expect(exec).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,command='], expect.anything());
    });

    it('returns no baseline without an objdir or without ps', async () => {
      expect(await snapshotObjdirHelpers(undefined)).toBeUndefined();
      vi.mocked(exec).mockRejectedValueOnce(new Error('ENOENT'));
      expect(await snapshotObjdirHelpers(OBJ)).toBeUndefined();
    });

    it('reaps a new reparented same-objdir helper and leaves the baseline, siblings and live children alone', async () => {
      const kill = stubAlive([]); // nothing announced is alive
      vi.mocked(exec).mockResolvedValueOnce({
        stdout: [OLD_SURVIVOR, NEW_SURVIVOR, SIBLING, LIVE_CHILD].join('\n'),
        stderr: '',
        exitCode: 0,
      });
      vi.mocked(terminateHarnessProcesses).mockResolvedValueOnce(1);
      try {
        expect(await reapTrackedHarnessPids(TRACKED, OBJ, new Set([19144]))).toBe(1);
        expect(terminateHarnessProcesses).toHaveBeenCalledWith(
          [
            {
              pid: 75376,
              kind: 'unannounced',
              command: expect.stringContaining('moz-http2.js') as string,
            },
          ],
          'harness teardown'
        );
      } finally {
        kill.mockRestore();
      }
    });

    // With no baseline there is no way to tell this dispatch's survivor from
    // an earlier run's, and the earlier run's is the census's call.
    it('reaps no unannounced process without a baseline', async () => {
      const kill = stubAlive([]);
      vi.mocked(exec).mockResolvedValueOnce({ stdout: NEW_SURVIVOR, stderr: '', exitCode: 0 });
      try {
        expect(await reapTrackedHarnessPids(TRACKED, OBJ)).toBe(0);
        expect(terminateHarnessProcesses).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    });
  });
});
