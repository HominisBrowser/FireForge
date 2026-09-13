// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { warn } from '../../utils/logger.js';
import { exec } from '../../utils/process.js';
import {
  findOrphanedHarnessProcesses,
  formatOrphanReport,
  isObjdirAnchored,
  matchesHarnessHelper,
  reportOrphanedHarnessProcesses,
  terminateHarnessProcesses,
} from '../harness-orphans.js';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ warn: vi.fn(), info: vi.fn(), verbose: vi.fn() }));
vi.mock('../../utils/sleep.js', () => ({ sleep: vi.fn(() => Promise.resolve()) }));

const NONE = { orphans: [], reaped: 0 };

const OBJ = '/Users/dev/proj/engine/obj-aarch64-apple-darwin';

function ps(lines: string[]): string {
  return lines.join('\n');
}

describe('findOrphanedHarnessProcesses', () => {
  // The four survivors from the field incident, in `ps` shape.
  const INCIDENT = ps([
    `  411     1 01:02:11 ${OBJ}/dist/bin/xpcshell -g ${OBJ}/dist/bin -f ${OBJ}/_tests/testing/mochitest/server.js`,
    `  412     1 01:02:10 /usr/bin/python3 ${OBJ}/_tests/testing/mochitest/pywebsocket_wrapper.py`,
    `  413     1 01:02:10 ${OBJ}/dist/bin/ssltunnel -c /tmp/ssltunnel.cfg`,
    `  414     1 01:02:09 /usr/bin/python3 ${OBJ}/_tests/testing/mochitest/moz-http2/moz-http2.js`,
  ]);

  it('finds every objdir-anchored harness helper', () => {
    const found = findOrphanedHarnessProcesses(INCIDENT, OBJ, 99999);
    expect(found.map((p) => p.pid)).toEqual([411, 412, 413, 414]);
    expect(found[0]?.elapsedSeconds).toBe(3731);
  });

  // `xpcshell` and `server.js` are far too generic to report on their own.
  // A developer's unrelated Node service must never be offered up for a kill.
  it('ignores a helper-shaped process with no objdir provenance', () => {
    const found = findOrphanedHarnessProcesses(
      ps(['  500     1 10:00 node /Users/dev/side-project/server.js']),
      OBJ,
      99999
    );
    expect(found).toEqual([]);
  });

  it('matches a generic obj- path even without a configured objdir', () => {
    const found = findOrphanedHarnessProcesses(
      ps(['  501     1 05:00 /src/obj-x86_64/dist/bin/ssltunnel -c cfg']),
      undefined,
      99999
    );
    expect(found).toHaveLength(1);
  });

  // FireForge must never report itself or a child it just spawned.
  it('excludes this process and its direct children', () => {
    const found = findOrphanedHarnessProcesses(
      ps([
        `  600   700 05:00 ${OBJ}/dist/bin/xpcshell -f x`,
        `  700     1 05:00 ${OBJ}/dist/bin/xpcshell -f y`,
      ]),
      OBJ,
      700
    );
    expect(found).toEqual([]);
  });

  it('names each process, its age and the kill command in the report', () => {
    const report = formatOrphanReport(findOrphanedHarnessProcesses(INCIDENT, OBJ, 99999));
    expect(report).toContain('PID 411 (up 01:02:11)');
    expect(report).toContain('kill 411 412 413 414');
    expect(report).toContain('--reap-orphans');
    expect(report).toContain('test.reapOrphans');
    // The census runs before this run spawns anything, so it must say so.
    // Every hit is then a survivor rather than a suspicion.
    expect(report).toContain('EARLIER run');
  });
});

describe('reportOrphanedHarnessProcesses', () => {
  const LIVE = `  411     1 01:02:11 ${OBJ}/dist/bin/xpcshell -f ${OBJ}/_tests/testing/mochitest/server.js`;

  // The census branches on `process.platform` directly and skips itself on
  // Windows, so the `ps`-driven expectations below only hold when the
  // branch is pinned to a POSIX host rather than inherited from the runner.
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

  // There is no `ps -axo` on Windows. The preflight must step aside without
  // even trying, because a failed probe there would be noise on every run.
  it('skips the census on Windows without probing', async () => {
    stubPlatform('win32');
    expect(await reportOrphanedHarnessProcesses(OBJ)).toEqual(NONE);
    expect(exec).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the census when survivors are found', async () => {
    vi.mocked(exec).mockResolvedValue({ stdout: LIVE, stderr: '', exitCode: 0 });
    const census = await reportOrphanedHarnessProcesses(OBJ);
    expect(census.orphans).toHaveLength(1);
    expect(census.reaped).toBe(0);
    expect(vi.mocked(warn).mock.calls[0]?.[0]).toContain('PID 411');
  });

  // `reap` is the opt-in kill: SIGTERM, a grace period, SIGKILL for a
  // holdout, and the count on the result is what the verdict line prints,
  // so it must count processes that are gone, not signals that were sent.
  it('terminates survivors under reap and counts the ones confirmed gone', async () => {
    vi.mocked(exec).mockResolvedValue({ stdout: LIVE, stderr: '', exitCode: 0 });
    const alive = new Set([411]);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (!alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') alive.delete(pid);
      return true;
    });
    try {
      const census = await reportOrphanedHarnessProcesses(OBJ, { reap: true });
      expect(census.reaped).toBe(1);
      const signals = kill.mock.calls.filter(([pid]) => pid === 411).map(([, sig]) => sig);
      // TERM, probe (still alive), KILL, probe (gone).
      expect(signals).toEqual(['SIGTERM', 0, 'SIGKILL', 0]);
    } finally {
      kill.mockRestore();
    }
  });

  it('says nothing when the objdir is clean', async () => {
    vi.mocked(exec).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    expect(await reportOrphanedHarnessProcesses(OBJ)).toEqual(NONE);
    expect(warn).not.toHaveBeenCalled();
  });

  // A host without a usable `ps` runs exactly as before: the census is a
  // visibility aid, never a gate, so a probe failure must not surface.
  it('degrades silently when ps cannot be run', async () => {
    vi.mocked(exec).mockRejectedValue(new Error('ENOENT'));
    expect(await reportOrphanedHarnessProcesses(OBJ)).toEqual(NONE);
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades silently when ps exits non-zero', async () => {
    vi.mocked(exec).mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });
    expect(await reportOrphanedHarnessProcesses(OBJ)).toEqual(NONE);
  });
});

describe('terminateHarnessProcesses', () => {
  it('does not count a process that ignores SIGKILL, and warns about it', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const reaped = await terminateHarnessProcesses([{ pid: 4242 }], 'teardown');
      expect(reaped).toBe(0);
      expect(vi.mocked(warn).mock.calls.at(-1)?.[0]).toContain('4242 is still alive after SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('skips a process that vanished before SIGTERM without escalating', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      expect(await terminateHarnessProcesses([{ pid: 1 }], 'teardown')).toBe(0);
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
    }
  });

  it('stops the SIGTERM, grace, SIGKILL sequence once the process is gone', async () => {
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGTERM') alive = false;
      return true;
    });
    try {
      expect(await terminateHarnessProcesses([{ pid: 7 }], 'teardown')).toBe(1);
      // TERM, the post-grace probe, the final probe that counts it; no SIGKILL.
      expect(kill.mock.calls.map(([, sig]) => sig)).toEqual(['SIGTERM', 0, 0]);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('exported attribution primitives', () => {
  // The match is structural: the executable IS a helper binary, or an
  // interpreter running a helper script. Merely mentioning a helper path
  // (an editor, a shell's command text, a grep) is not being one. Under the
  // reap posture the substring version terminated the operator's own shell.
  it('matches the real helper shapes from the 2026-09-13 census', () => {
    const shapes = [
      `/Users/u/.mozbuild/srcdirs/x/_virtualenvs/common/bin/python ${OBJ}/_tests/testing/mochitest/pywebsocket_wrapper.py -H 0.0.0.0 -p 9988`,
      `/Users/u/.mozbuild/node/bin/node ${OBJ}/_tests/testing/mochitest/xpcshell/moz-http2/moz-http2.js`,
      `${OBJ}/dist/bin/xpcshell -g ${OBJ}/dist/bin -f ${OBJ}/_tests/testing/mochitest/server.js`,
      `${OBJ}/dist/bin/ssltunnel /var/folders/x/ssltunnel.cfg`,
      `python3.12 ${OBJ}/_tests/testing/mochitest/websocketprocessbridge/websocketprocessbridge.py --port 8191`,
      `${OBJ}/dist/bin/http3server /tmp/db`,
    ];
    for (const shape of shapes) expect(matchesHarnessHelper(shape), shape).toBe(true);
  });

  it('does not match processes that only mention a helper path', () => {
    const bystanders = [
      `/bin/zsh -c python3 -c 'import time; time.sleep(9)' ${OBJ}/_tests/testing/mochitest/server.js &`,
      `vim ${OBJ}/_tests/testing/mochitest/server.js`,
      `grep -rn server.js ${OBJ}/_tests`,
      `${OBJ}/dist/Hominis.app/Contents/MacOS/hominis -marionette`,
      `/opt/homebrew/bin/python3 -c import time ${OBJ}/_tests/testing/mochitest/server.js`,
      `python3.12 ${OBJ}/../mach mochitest browser/x.js`,
    ];
    for (const shape of bystanders) expect(matchesHarnessHelper(shape), shape).toBe(false);
  });

  // The terminal FireForge runs under is an ancestor whose command text can
  // quote the helper paths. It must never be a candidate, however it reads.
  it('never reports an ancestor of this process', () => {
    const found = findOrphanedHarnessProcesses(
      ps([
        `  100     1 05:00 ${OBJ}/dist/bin/ssltunnel -c cfg`, // grandparent, helper-shaped
        `  200   100 05:00 /bin/zsh -c fireforge test`,
        `  300   200 00:01 node fireforge`,
        `  400     1 05:00 ${OBJ}/dist/bin/ssltunnel -c other`, // a real survivor
      ]),
      OBJ,
      300
    );
    expect(found.map((p) => p.pid)).toEqual([400]);
  });

  it('matches helper names and anchors on the objdir, obj- segment or _tests/', () => {
    expect(matchesHarnessHelper(`${OBJ}/dist/bin/ssltunnel -c x`)).toBe(true);
    expect(matchesHarnessHelper(`${OBJ}/dist/Hominis.app/Contents/MacOS/hominis`)).toBe(false);
    expect(isObjdirAnchored(`${OBJ}/dist/Hominis.app/Contents/MacOS/hominis`, OBJ)).toBe(true);
    expect(isObjdirAnchored('/src/obj-x86_64/dist/bin/ssltunnel', undefined)).toBe(true);
    expect(isObjdirAnchored('/tmp/_tests/x/server.js', undefined)).toBe(true);
    expect(isObjdirAnchored('node /home/dev/app/server.js', OBJ)).toBe(false);
  });
});
