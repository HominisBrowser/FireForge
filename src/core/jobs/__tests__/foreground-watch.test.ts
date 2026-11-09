// SPDX-License-Identifier: EUPL-1.2
/** Whether a display step's own browser is in front, from injected host tools. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type DisplayState, watchForeground } from '../foreground-watch.js';
import type { FrontTools } from '../hold-front.js';

const SLOT = '/slots/a';
const BROWSER = `${SLOT}/engine/obj-x/dist/Nightly.app/Contents/MacOS/firefox --profile /p`;

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fireforge-foreground-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function tools(fronts: Array<number | undefined>, browserUp = true): FrontTools {
  let at = 0;
  return {
    frontmost: () => Promise.resolve(fronts[Math.min(at++, fronts.length - 1)]),
    raise: () => Promise.resolve(false),
    processes: () => Promise.resolve(browserUp ? [{ pid: 500, ppid: 100, args: BROWSER }] : []),
  };
}

const read = async (file: string): Promise<DisplayState> =>
  JSON.parse(await readFile(file, 'utf8')) as DisplayState;

describe('watchForeground', () => {
  const lease = { job: 'job-1', step: 2 };

  it('reports no loss while the step own browser is in front, and publishes own', async () => {
    const stateFile = join(directory, 'display.json');
    const watch = watchForeground(
      { root: 100, slotRoot: SLOT, lease, stateFile, pollMs: 5 },
      tools([500])
    );
    await new Promise((settle) => setTimeout(settle, 30));
    expect(await watch.finish()).toBeUndefined();
    expect(await read(stateFile)).toMatchObject({ lease, foreground: 'own' });
  });

  it('reports when another application first took the front, in seconds from the start', async () => {
    const clock = { now: 1_000_000 };
    const stateFile = join(directory, 'display.json');
    const watch = watchForeground(
      { root: 100, slotRoot: SLOT, lease, stateFile, pollMs: 5, now: () => clock.now },
      {
        ...tools([500, 700]),
        frontmost: (() => {
          const fronts = [500, 700];
          let at = 0;
          return () => {
            clock.now += 7_000;
            return Promise.resolve(fronts[Math.min(at++, 1)]);
          };
        })(),
      }
    );
    await new Promise((settle) => setTimeout(settle, 30));
    expect(await watch.finish()).toBe(14);
    expect(await read(stateFile)).toMatchObject({ foreground: 'other' });
  });

  it('reads a host that will not say, or no browser yet, as unknown rather than lost', async () => {
    const unsure = join(directory, 'unsure.json');
    const silent = watchForeground(
      { root: 100, slotRoot: SLOT, lease, stateFile: unsure, pollMs: 5 },
      tools([undefined])
    );
    expect(await silent.finish()).toBeUndefined();
    expect(await read(unsure)).toMatchObject({ foreground: 'unknown' });
    const early = join(directory, 'early.json');
    const waiting = watchForeground(
      { root: 100, slotRoot: SLOT, lease, stateFile: early, pollMs: 5 },
      tools([700], false)
    );
    expect(await waiting.finish()).toBeUndefined();
    expect(await read(early)).toMatchObject({ foreground: 'unknown' });
  });

  it('with no way to ask, publishes unknown once and never reports a loss', async () => {
    const stateFile = join(directory, 'none.json');
    const watch = watchForeground({ root: 100, slotRoot: SLOT, lease, stateFile }, undefined);
    expect(await watch.finish()).toBeUndefined();
    expect(await read(stateFile)).toMatchObject({ lease, foreground: 'unknown' });
  });
});
