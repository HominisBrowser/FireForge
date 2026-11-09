// SPDX-License-Identifier: EUPL-1.2
/** Free disk under a step, and what a red step says about it. */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  annotateDiskLow,
  diskLowSentence,
  diskLowThreshold,
  diskUsage,
  gibText,
  readVolumeSpace,
  watchHostDisk,
} from '../host-disk.js';
import type { PhaseVerdict } from '../phase-outcome.js';
import { judgeUnderLoad } from '../phase-report.js';
import type { JobRecord } from '../schema.js';

const GIB = 1024 ** 3;

describe('diskLowThreshold', () => {
  it('is the larger of the configured GiB and 3% of the volume, defaulting to 10 GiB', () => {
    expect(diskLowThreshold(100 * GIB)).toBe(10 * GIB);
    expect(diskLowThreshold(1000 * GIB)).toBe(30 * GIB);
    expect(diskLowThreshold(100 * GIB, 20)).toBe(20 * GIB);
    expect(diskLowThreshold(1000 * GIB, 20)).toBe(30 * GIB);
  });
});

describe('watchHostDisk', () => {
  /** Reads that answer per path from a script, one entry per sample; the last repeats. */
  function scripted(script: Record<string, number[]>): {
    read: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>;
    clock: { now: number };
  } {
    const seen: Record<string, number> = {};
    return {
      clock: { now: 5_000_000 },
      read: (path) => {
        const list = script[path] ?? [];
        const at = seen[path] ?? 0;
        seen[path] = at + 1;
        const free = list[Math.min(at, list.length - 1)];
        return free === undefined
          ? Promise.reject(new Error('unreadable'))
          : Promise.resolve({ freeBytes: free * GIB, totalBytes: 500 * GIB });
      },
    };
  }

  async function run(
    script: Record<string, number[]>,
    at: number
  ): Promise<Awaited<ReturnType<ReturnType<typeof watchHostDisk>>>> {
    const { read, clock } = scripted(script);
    const start = clock.now;
    const stop = watchHostDisk(
      { namespace: '/ns', slot: '/slot' },
      { tickMs: 3_600_000, now: () => clock.now, read }
    );
    clock.now = start + at * 1000;
    return stop();
  }

  it('says nothing while free space stays above the threshold', async () => {
    expect(await run({ '/ns': [200], '/slot': [100] }, 30)).toBeUndefined();
  });

  it('keeps the lowest reading below the threshold and when it came', async () => {
    // 500 GiB volume: 3% is 15 GiB, so 12 is low and 40 is not.
    expect(await run({ '/ns': [40, 12], '/slot': [90] }, 30)).toEqual({
      freeBytes: 12 * GIB,
      atSeconds: 30,
      volume: 'namespace',
    });
  });

  it("reports the slot's volume when it is the low one, and skips an unreadable volume", async () => {
    expect(await run({ '/ns': [90], '/slot': [90, 8] }, 5)).toEqual({
      freeBytes: 8 * GIB,
      atSeconds: 5,
      volume: 'slot',
    });
    expect(await run({ '/slot': [90, 8] }, 5)).toMatchObject({ volume: 'slot' });
  });

  it('reports a shared volume once, as the namespace, by device rather than by reading', async () => {
    // Two directories on one device; the slot's read drifts lower, as a busy disk does between reads.
    const shared = await mkdtemp(join(tmpdir(), 'fireforge-disk-shared-'));
    const slot = join(shared, 'slot');
    await mkdir(slot);
    try {
      const { read, clock } = scripted({ [shared]: [90, 6], [slot]: [90, 5] });
      const stop = watchHostDisk(
        { namespace: shared, slot },
        { tickMs: 3_600_000, now: () => clock.now, read }
      );
      clock.now += 2000;
      expect(await stop()).toMatchObject({ volume: 'namespace', freeBytes: 6 * GIB });
    } finally {
      await rm(shared, { recursive: true, force: true });
    }
  });

  it('reads this host through statfs', async () => {
    const space = await readVolumeSpace(tmpdir());
    expect(space.totalBytes).toBeGreaterThan(0);
    expect(space.freeBytes).toBeGreaterThanOrEqual(0);
  });
});

describe('what a low reading adds to a red', () => {
  const low = { freeBytes: 5.5 * GIB, atSeconds: 42, volume: 'namespace' as const };
  const usage = { slotBytes: 70 * GIB, slots: 3, artifactBytes: 5 * GIB };

  it('names the figure, the volume and what holds the space', () => {
    const text = diskLowSentence(low, usage);
    expect(text).toContain('5.5 GiB');
    expect(text).toContain("coordinator's volume");
    expect(text).toContain('42s in');
    expect(text).toContain('disk pressure');
    expect(text).toContain('70.0 GiB in 3 slots');
    expect(text).toContain('5.0 GiB in job artifacts');
    expect(diskLowSentence({ ...low, volume: 'slot' })).toContain("slot's volume");
    expect(gibText(9.99 * GIB)).toBe('9.9');
  });

  it('appends to a red, interrupted or cancelled reason and leaves a pass alone', () => {
    const red: PhaseVerdict = { advance: false, state: 'failed', reason: 'Executor exited 8' };
    const bare: PhaseVerdict = { advance: false, state: 'failed' };
    const annotated = annotateDiskLow(red, low);
    expect(annotated.state).toBe('failed');
    expect(annotated.reason).toMatch(/^Executor exited 8\. Free disk fell to 5\.5 GiB/);
    expect(annotateDiskLow({ ...red, state: 'cancelled' }, low).reason).toContain('disk pressure');
    expect(annotateDiskLow(bare, low).reason).toMatch(/^Free disk/);
    const pass: PhaseVerdict = { advance: true, state: 'running' };
    expect(annotateDiskLow(pass, low)).toBe(pass);
    expect(annotateDiskLow(red, undefined)).toBe(red);
  });
});

describe('a red phase whose step ran low on disk', () => {
  let ns: string;
  beforeEach(async () => {
    ns = await mkdtemp(join(tmpdir(), 'fireforge-host-disk-'));
  });
  afterEach(async () => {
    await rm(ns, { recursive: true, force: true });
  });

  it('records the reading and says so in the reason, sizing slots and artifacts', async () => {
    await mkdir(join(ns, 'artifacts', 'j1'), { recursive: true });
    await writeFile(
      join(ns, 'artifacts', 'j1', 'step-0-execution.json'),
      JSON.stringify({
        steps: [{ hostDisk: { freeBytes: 4 * GIB, atSeconds: 9, volume: 'namespace' } }],
      })
    );
    await mkdir(join(ns, 'slots', 'a'), { recursive: true });
    await writeFile(
      join(ns, 'slots', 'a', 'slot.json'),
      JSON.stringify({ storage: { consumedBytes: 20 * GIB } })
    );
    const job = {
      id: 'j1',
      phase: { index: 0 },
      request: { quiet: false, steps: [{ command: 'test', args: ['--headless'] }] },
      stepResources: [{ cpu: 2, memory: 1, build: 0, browser: 0, display: 0 }],
    } as unknown as JobRecord;
    const red: PhaseVerdict = { advance: false, state: 'failed', reason: 'Executor exited 8' };
    const { judged, hostDisk } = await judgeUnderLoad(ns, job, red);
    expect(hostDisk).toEqual({ freeBytes: 4 * GIB, atSeconds: 9, volume: 'namespace' });
    expect(judged.state).toBe('failed');
    expect(judged.reason).toContain('disk pressure');
    expect(judged.reason).toContain('20.0 GiB in 1 slot ');
    const usage = await diskUsage(ns);
    expect(usage).toMatchObject({ slots: 1, slotBytes: 20 * GIB });
    expect(usage.artifactBytes).toBeGreaterThan(0);
  });

  it('still says disk ran low when what the coordinator holds cannot be measured', async () => {
    await mkdir(join(ns, 'artifacts', 'j2', 'sealed'), { recursive: true });
    await writeFile(
      join(ns, 'artifacts', 'j2', 'step-0-execution.json'),
      JSON.stringify({
        steps: [{ hostDisk: { freeBytes: 3 * GIB, atSeconds: 4, volume: 'slot' } }],
      })
    );
    // An unreadable directory under the artifacts stops the walk that sizes them.
    await chmod(join(ns, 'artifacts', 'j2', 'sealed'), 0o000);
    try {
      const job = {
        id: 'j2',
        phase: { index: 0 },
        request: { quiet: false, steps: [{ command: 'test', args: ['--headless'] }] },
        stepResources: [{ cpu: 2, memory: 1, build: 0, browser: 0, display: 0 }],
      } as unknown as JobRecord;
      const red: PhaseVerdict = { advance: false, state: 'failed', reason: 'Executor exited 8' };
      const { judged } = await judgeUnderLoad(ns, job, red);
      expect(judged.reason).toContain('disk pressure');
      expect(judged.reason).not.toContain('the coordinator holds');
    } finally {
      await chmod(join(ns, 'artifacts', 'j2', 'sealed'), 0o755);
    }
  });

  it('measures nothing for a red whose disk never ran low', async () => {
    const job = {
      id: 'j3',
      phase: { index: 0 },
      request: { quiet: false, steps: [{ command: 'test', args: ['--headless'] }] },
      stepResources: [{ cpu: 2, memory: 1, build: 0, browser: 0, display: 0 }],
    } as unknown as JobRecord;
    const red: PhaseVerdict = { advance: false, state: 'failed', reason: 'Executor exited 8' };
    const { judged, hostDisk } = await judgeUnderLoad(ns, job, red);
    expect(hostDisk).toBeUndefined();
    expect(judged.reason).toBe('Executor exited 8');
  });
});
