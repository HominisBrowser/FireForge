// SPDX-License-Identifier: EUPL-1.2
/**
 * Owns the kill path of one mach test dispatch for `fireforge test`.
 *
 * Three things the run must do around every `runMachTestSuite` call, kept
 * together because each one exists for the same incident (a supervisor
 * killed the process above FireForge at its bound and the harness httpd it
 * had launched spun for hours):
 *
 *  1. Track the helper pids the harness announces, and after mach has
 *     exited terminate any that outlived it (`harness-helper-pids.ts`).
 *  2. Publish the harness process group (`--pgid-file`), so a supervisor
 *     that can only SIGKILL FireForge can still take the whole tree with
 *     one `kill -- -<pgid>` afterwards.
 *  3. Watch FireForge's own parent (`parent-exit-watchdog.ts`). When it
 *     vanishes mid-run, write the killed verdict, reap the group, and let
 *     the dispatch loop end the run instead of retrying.
 *
 * Every reap adds to the `orphans-reaped=` verdict attribute.
 */

import { unlink, writeFile } from 'node:fs/promises';

import {
  createHelperPidTracker,
  reapTrackedHarnessPids,
  snapshotObjdirHelpers,
} from '../core/harness-helper-pids.js';
import type { MachTestSuiteOptions } from '../core/mach.js';
import { startParentExitWatchdog } from '../core/parent-exit-watchdog.js';
import { toError } from '../utils/errors.js';
import { verbose, warn } from '../utils/logger.js';
import { sweepProcessGroup } from '../utils/process-group.js';
import { addVerdictRunCount, emitKilledVerdict } from './test-verdict.js';

/** Inputs for {@link createHarnessTeardown}. */
export interface HarnessTeardownInputs {
  /** Absolute objdir of this project, when known: the anchor for every kill. */
  objDir: string | undefined;
  /** `--pgid-file`: where to publish the harness process group id. */
  pgidFile: string | undefined;
}

/** One dispatch's teardown: the hooks to spread into `runMachTestSuite`, and its lifecycle. */
export interface HarnessTeardown {
  /** Hooks for {@link MachTestSuiteOptions.teardown}. */
  hooks: NonNullable<MachTestSuiteOptions['teardown']>;
  /**
   * Records the same-objdir helpers alive right now, before the dispatch
   * spawns anything, so the post-close reap can tell this dispatch's
   * unannounced helpers from an earlier run's survivors. Await it before
   * `runMachTestSuite`.
   */
  prepare(): Promise<void>;
  /** Stops the parent watchdog. Call after the dispatch resolved or threw. */
  dispose(): void;
}

/**
 * Builds the teardown for one dispatch (one retry attempt of one shard).
 * The pid tracker and the group id are per dispatch; the parent watchdog
 * runs only while that dispatch is in flight.
 */
export function createHarnessTeardown(inputs: HarnessTeardownInputs): HarnessTeardown {
  const tracker = createHelperPidTracker();
  let pgid: number | undefined;
  let baseline: ReadonlySet<number> | undefined;

  const watchdog = startParentExitWatchdog({
    onParentExit: ({ originalPpid, currentPpid }) => {
      // Verdict first, before anything that can stall: the parent that would
      // have read it is gone, but the run log and any tee of stdout are not.
      emitKilledVerdict('parent-exit');
      warn(
        `Parent process ${originalPpid} exited while the harness was running (this process now ` +
          `reports parent ${currentPpid}); ending the run and terminating the harness tree so it ` +
          'cannot run on unsupervised.'
      );
      if (pgid !== undefined) {
        void sweepProcessGroup(pgid, undefined, 'after the parent process exited').catch(
          (error: unknown) => {
            warn(
              `Reaping harness group ${pgid} after parent exit failed: ${toError(error).message}`
            );
          }
        );
      }
    },
  });

  return {
    hooks: {
      onOutputChunk: (stream, chunk) => {
        tracker.feed(stream, chunk);
      },
      onProcessGroup: (id) => {
        pgid = id;
        verbose(`Harness process group: ${id} (mach is the group leader).`);
        if (inputs.pgidFile !== undefined) void publishPgid(inputs.pgidFile, id);
      },
      postCloseSweep: async () => {
        const reaped = await reapTrackedHarnessPids(tracker.tracked(), inputs.objDir, baseline);
        addVerdictRunCount('orphans-reaped', reaped);
      },
    },
    prepare: async () => {
      baseline = await snapshotObjdirHelpers(inputs.objDir);
    },
    dispose: () => {
      watchdog.stop();
    },
  };
}

/**
 * Writes `<pgid>\n` to the pgid file. Best-effort: a supervisor that asked
 * for the file and cannot get it is warned, and the run proceeds, because
 * the file is a courtesy to the supervisor and not a precondition of the
 * tests.
 */
async function publishPgid(path: string, pgid: number): Promise<void> {
  try {
    await writeFile(path, `${pgid}\n`, 'utf8');
  } catch (error: unknown) {
    warn(`Could not write --pgid-file ${path}: ${toError(error).message}`);
  }
}

/**
 * The pgid file of the run in flight, for the signal pipeline. `testCommand`'s
 * own `finally` removes the file on every path it controls, but on SIGTERM
 * that `finally` races the bin handler's `process.exit` and loses, and a
 * SIGTERM is notice: the file must not outlive a run FireForge itself
 * ended. Set when the run starts, cleared by {@link removePgidFile}.
 */
let activePgidFile: string | undefined;

/** Records the run's pgid file so {@link removeActivePgidFile} can find it from the signal handler. */
export function setActivePgidFile(path: string | undefined): void {
  activePgidFile = path;
}

/**
 * Removes the pgid file at the end of a run that ended under FireForge's
 * control. A file left behind after a normal exit would name a group id
 * the kernel may have reused; the file must only outlive FireForge when
 * FireForge itself was killed without notice, which is what it is for.
 */
export async function removePgidFile(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  if (activePgidFile === path) activePgidFile = undefined;
  try {
    await unlink(path);
  } catch (error: unknown) {
    // ENOENT is the usual case when no dispatch ever spawned.
    verbose(`--pgid-file ${path} not removed: ${toError(error).message}`);
  }
}

/**
 * Signal-pipeline variant of {@link removePgidFile}: removes the run's pgid
 * file, if one is registered. Called by the bin entry point after the child
 * shutdown wait, so the group the file names has already been signalled.
 */
export async function removeActivePgidFile(): Promise<void> {
  await removePgidFile(activePgidFile);
}
