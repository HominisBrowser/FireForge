// SPDX-License-Identifier: EUPL-1.2
/** What an executor watches on the host under a step, against a temporary namespace. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHostWatches } from '../runner.js';
import type { JobStep } from '../schema.js';

let ns: string;
beforeEach(async () => {
  ns = await mkdtemp(join(tmpdir(), 'fireforge-host-watches-'));
});
afterEach(async () => {
  delete process.env['FIREFORGE_DISPLAY_LEASE'];
  delete process.env['FIREFORGE_DISPLAY_STATE'];
  await rm(ns, { recursive: true, force: true });
});

const headed: JobStep = { command: 'test', args: ['browser/a.js'] };
const headless: JobStep = { command: 'test', args: ['--headless', 'browser/a.js'] };
const at = (): { namespace: string; job: string; index: number; directory: string } => ({
  namespace: ns,
  job: 'job-7',
  index: 2,
  directory: ns,
});

describe('startHostWatches', () => {
  it('tells a window step what holds the display and where the foreground is written', async () => {
    const stop = await startHostWatches(headed, at(), false);
    expect(process.env['FIREFORGE_DISPLAY_LEASE']).toBe('job-7:2');
    const file = process.env['FIREFORGE_DISPLAY_STATE'];
    expect(file).toBe(join(ns, 'step-2-display.json'));
    const seen = await stop();
    expect(process.env['FIREFORGE_DISPLAY_LEASE']).toBeUndefined();
    expect(process.env['FIREFORGE_DISPLAY_STATE']).toBeUndefined();
    // No browser of this step ever ran, so the foreground is unknown and nothing was lost.
    expect(JSON.parse(await readFile(join(ns, 'step-2-display.json'), 'utf8'))).toMatchObject({
      lease: { job: 'job-7', step: 2 },
      foreground: 'unknown',
    });
    expect(seen.hostState?.foregroundLost).toBeUndefined();
  });

  it('leaves a headless step and a steady host with no lease to announce', async () => {
    const quiet = await startHostWatches(headless, at(), false);
    expect(process.env['FIREFORGE_DISPLAY_LEASE']).toBeUndefined();
    await quiet();
    const steady = await startHostWatches(headed, at(), true);
    expect(process.env['FIREFORGE_DISPLAY_LEASE']).toBeUndefined();
    expect(await steady()).toEqual({});
  });

  it('reads the configured low-disk bound, so a threshold above the volume records a reading', async () => {
    await writeFile(
      join(ns, 'config.json'),
      JSON.stringify({ schemaVersion: 1, idleMs: 100, capacity: { cpu: 4 }, diskLowGib: 1e9 })
    );
    const seen = await (await startHostWatches(headless, at(), false))();
    // Free space moves under a busy host, so a later, lower sample may be the one kept.
    expect(seen.hostDisk).toMatchObject({ volume: 'namespace' });
    expect(seen.hostDisk?.atSeconds).toBeGreaterThanOrEqual(0);
    expect(seen.hostDisk?.freeBytes).toBeGreaterThan(0);
  });

  it('survives an unreadable configuration, which states no bound', async () => {
    await writeFile(join(ns, 'config.json'), '{ not json');
    await expect((await startHostWatches(headless, at(), false))()).resolves.toBeTypeOf('object');
  });
});
