// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { warn } from '../../utils/logger.js';
import { exec } from '../../utils/process.js';
import {
  findOrphanedHarnessProcesses,
  formatOrphanReport,
  reportOrphanedHarnessProcesses,
} from '../harness-orphans.js';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ warn: vi.fn(), info: vi.fn(), verbose: vi.fn() }));

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
    expect(await reportOrphanedHarnessProcesses(OBJ)).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the census when survivors are found', async () => {
    vi.mocked(exec).mockResolvedValue({ stdout: LIVE, stderr: '', exitCode: 0 });
    const orphans = await reportOrphanedHarnessProcesses(OBJ);
    expect(orphans).toHaveLength(1);
    expect(vi.mocked(warn).mock.calls[0]?.[0]).toContain('PID 411');
  });

  it('says nothing when the objdir is clean', async () => {
    vi.mocked(exec).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    expect(await reportOrphanedHarnessProcesses(OBJ)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  // A host without a usable `ps` runs exactly as before: the census is a
  // visibility aid, never a gate, so a probe failure must not surface.
  it('degrades silently when ps cannot be run', async () => {
    vi.mocked(exec).mockRejectedValue(new Error('ENOENT'));
    expect(await reportOrphanedHarnessProcesses(OBJ)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades silently when ps exits non-zero', async () => {
    vi.mocked(exec).mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });
    expect(await reportOrphanedHarnessProcesses(OBJ)).toEqual([]);
  });
});
