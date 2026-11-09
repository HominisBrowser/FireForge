// SPDX-License-Identifier: EUPL-1.2
/** Whether a display step's own browser is the application in front, watched while it runs. */
import { writeFile } from 'node:fs/promises';

import { type FrontTools, ownedBrowser } from './hold-front.js';

/** How often the frontmost application is read. */
const WATCH_POLL_MS = 2_000;

/** Whose window is in front: the step's own browser, another application, or not known. */
export type ForegroundState = 'own' | 'other' | 'unknown';

/** What a harness reads to know it holds the display and whether its window is in front. */
export interface DisplayState {
  /** The job and step holding the display. */
  lease: { job: string; step: number };
  foreground: ForegroundState;
  /** When `foreground` last changed, as an ISO time. */
  since: string;
}

export interface ForegroundWatch {
  /** Stops watching and gives the seconds after the start that another application was first in front, if one was. */
  finish: () => Promise<number | undefined>;
}

/**
 * Watches the frontmost application at once and every poll while a step with a
 * window runs. It only reads: it needs no permission beyond what `lsappinfo`
 * answers, and a host that will not say, or a browser not yet started, reads as
 * unknown rather than as a loss. With no tools (a platform with no way to ask)
 * the state stays unknown.
 *
 * @param options.stateFile - Rewritten whenever the state changes, for the harness
 */
export function watchForeground(
  options: {
    root: number;
    slotRoot: string;
    lease: { job: string; step: number };
    stateFile?: string;
    pollMs?: number;
    now?: () => number;
  },
  tools: FrontTools | undefined
): ForegroundWatch {
  const now = options.now ?? Date.now;
  const started = now();
  const canAsk = tools !== undefined;
  let lostAt: number | undefined;
  let current: ForegroundState | undefined;
  const state = { stopped: false };
  let wake: (() => void) | undefined;
  const publish = async (state: ForegroundState): Promise<void> => {
    if (state === current) return;
    current = state;
    if (options.stateFile === undefined) return;
    const body: DisplayState = {
      lease: options.lease,
      foreground: state,
      since: new Date(now()).toISOString(),
    };
    await writeFile(options.stateFile, `${JSON.stringify(body)}\n`).catch(() => undefined);
  };
  const tick = async (): Promise<void> => {
    if (tools === undefined) return publish('unknown');
    const browser = ownedBrowser(await tools.processes(), options.root, options.slotRoot);
    const front = browser === undefined ? undefined : await tools.frontmost();
    if (front === undefined) return publish('unknown');
    if (front === browser) return publish('own');
    lostAt ??= Math.max(0, Math.round((now() - started) / 1000));
    return publish('other');
  };
  const pause = (ms: number): Promise<void> =>
    new Promise((settle) => {
      if (state.stopped) {
        settle();
        return;
      }
      const timer = setTimeout(settle, ms);
      wake = () => {
        clearTimeout(timer);
        settle();
      };
    });
  const watching = (async () => {
    while (!state.stopped) {
      await tick().catch(() => undefined);
      // With no way to ask, the one reading says all there is to say.
      if (!canAsk) return;
      await pause(options.pollMs ?? WATCH_POLL_MS);
    }
  })();
  return {
    finish: async () => {
      state.stopped = true;
      wake?.();
      await watching;
      await tick().catch(() => undefined);
      return lostAt;
    },
  };
}
