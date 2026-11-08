// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';

import { signalDirectChild } from '../../utils/child-process.js';
import type { StepDeclaration } from './step-environment.js';
import { stepTraits } from './step-traits.js';

/** Part of the base system, named in full because a phase's PATH can be a qualified toolchain's. */
const CAFFEINATE = '/usr/bin/caffeinate';

/** The grace `caffeinate` gets between SIGTERM and SIGKILL. */
const RELEASE_GRACE_MS = 2_000;

/** Whether a step holds the assertion: as it declares, otherwise when it has a window to keep visible. */
export const wantsKeepAwake = (step: StepDeclaration): boolean =>
  step.keepAwake ?? stepTraits(step).display;

export interface KeepAwakeHold {
  /** Ends the assertion. Resolves once its process is gone, so a phase's census never sees it. */
  release: () => Promise<void>;
}

/**
 * Holds a display, idle and system assertion while this process lives, on darwin.
 * It runs as this process's child in this process group, so the phase owns it:
 * a cancel signals it with the group, a normal end releases it, and `-w` ends it
 * by itself if this process is killed outright. Elsewhere there is nothing to hold.
 * Failing to start is a diagnostic: a test that needs the display says so by going red.
 */
export function holdKeepAwake(binary = CAFFEINATE): KeepAwakeHold | undefined {
  if (process.platform !== 'darwin') return undefined;
  const child = spawn(binary, ['-disu', '-w', String(process.pid)], { stdio: 'ignore' });
  if (child.pid !== undefined) process.stdout.write(`FIREFORGE-KEEP-AWAKE: pid=${child.pid}\n`);
  const gone = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.once('error', (error) => {
      process.stderr.write(`Keep-awake is not held: ${error.message}\n`);
      resolve();
    });
  });
  return {
    release: async () => {
      signalDirectChild(child, 'SIGTERM');
      const timer = setTimeout(() => {
        signalDirectChild(child, 'SIGKILL');
      }, RELEASE_GRACE_MS);
      await gone;
      clearTimeout(timer);
    },
  };
}
