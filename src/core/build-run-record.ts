// SPDX-License-Identifier: EUPL-1.2
/**
 * A record of the mach build in flight, kept in `.fireforge/build-run.json`
 * so any session on the checkout can see why the bundle is missing.
 *
 * An interrupted `fireforge build` (a killed peer session, a closed
 * terminal) can leave `dist/<App>.app/Contents/MacOS/` without its
 * executable. Every later `fireforge test`, in every session, then failed
 * at launch with nothing saying a build had died there, and the sessions
 * that had not run the build had no way to find out.
 *
 * The record is written when a protected mach build starts and removed when
 * it succeeds. A failed build leaves it with `status: "failed"` and the exit
 * code. A build that never reached either end, because its process died,
 * leaves `status: "running"` with a PID that no longer exists, which is how
 * an interrupted run is recognized. The next build that runs to the end
 * replaces whatever was there.
 *
 * Best-effort throughout: a build never fails because its record could not
 * be written, and an unreadable record reads as "no record".
 */

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { writeFileAtomic } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { isLockOwnerAlive, readProcessStartTick } from './file-lock-owner.js';

/** File name of the record under `.fireforge/`. */
const BUILD_RUN_RECORD = 'build-run.json';

/** The persisted record. */
interface BuildRunRecord {
  /** Whether the build is (or was last seen) running, or ended in failure. */
  status: 'running' | 'failed';
  /** PID of the FireForge process that ran the build. */
  pid: number;
  /** That process's boot-relative start tick, where procfs exposes one. */
  startTick?: number;
  /** The FireForge invocation, e.g. `fireforge build --ui`. */
  command: string;
  /** The mach command, e.g. `mach build faster`. */
  machCommand: string;
  /** ISO time the mach build started. */
  startedAt: string;
  /** ISO time a failed build ended. */
  endedAt?: string;
  /** Exit code of a failed build, when mach returned one. */
  exitCode?: number;
}

/** What the record says about the last build. */
export type BuildRunState =
  { kind: 'none' } | { kind: 'running' | 'interrupted' | 'failed'; record: BuildRunRecord };

function recordPath(projectRoot: string): string {
  return join(projectRoot, FIREFORGE_DIR, BUILD_RUN_RECORD);
}

async function writeRecord(projectRoot: string, record: BuildRunRecord): Promise<void> {
  try {
    await writeFileAtomic(recordPath(projectRoot), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error: unknown) {
    verbose(`Build run record not written: ${toError(error).message}`);
  }
}

/**
 * Runs a mach build with its run record maintained around it. The record
 * is removed on a zero exit and kept as `failed` on a non-zero exit or a
 * throw, so only a build whose process died mid-run is left `running`.
 *
 * @param projectRoot - Project root holding `.fireforge/`
 * @param machCommand - The mach command being run
 * @param build - The build itself
 * @returns Whatever the build returned
 */
export async function withBuildRunRecord<T extends { exitCode: number }>(
  projectRoot: string,
  machCommand: string,
  build: () => Promise<T>
): Promise<T> {
  const startTick = readProcessStartTick(process.pid);
  const started: BuildRunRecord = {
    status: 'running',
    pid: process.pid,
    ...(startTick !== undefined ? { startTick } : {}),
    command: ['fireforge', ...process.argv.slice(2)].join(' '),
    machCommand,
    startedAt: new Date().toISOString(),
  };
  await writeRecord(projectRoot, started);
  let result: T;
  try {
    result = await build();
  } catch (error: unknown) {
    await writeRecord(projectRoot, {
      ...started,
      status: 'failed',
      endedAt: new Date().toISOString(),
    });
    throw error;
  }
  if (result.exitCode === 0) {
    await rm(recordPath(projectRoot), { force: true }).catch(() => undefined);
  } else {
    await writeRecord(projectRoot, {
      ...started,
      status: 'failed',
      endedAt: new Date().toISOString(),
      exitCode: result.exitCode,
    });
  }
  return result;
}

/**
 * Reads the last build's record and decides whether its process is still
 * running.
 *
 * @param projectRoot - Project root holding `.fireforge/`
 */
export async function readBuildRunState(projectRoot: string): Promise<BuildRunState> {
  let record: BuildRunRecord;
  try {
    record = JSON.parse(await readFile(recordPath(projectRoot), 'utf8')) as BuildRunRecord;
  } catch {
    return { kind: 'none' };
  }
  if (typeof record.pid !== 'number' || typeof record.startedAt !== 'string') {
    return { kind: 'none' };
  }
  if (record.status === 'failed') return { kind: 'failed', record };
  return {
    kind: isLockOwnerAlive({ pid: record.pid, startTick: record.startTick })
      ? 'running'
      : 'interrupted',
    record,
  };
}

/**
 * One sentence naming why the bundle may be missing, or undefined when
 * there is no record to go on.
 *
 * @param state - From {@link readBuildRunState}
 */
export function describeBuildRunState(state: BuildRunState): string | undefined {
  if (state.kind === 'none') return undefined;
  const { record } = state;
  const who = `"${record.command}" (${record.machCommand}, PID ${record.pid}, started ${record.startedAt})`;
  switch (state.kind) {
    case 'running':
      return `A build is running right now: ${who}. The bundle is incomplete until it finishes.`;
    case 'interrupted':
      return (
        `The last build never finished: ${who} is gone without recording an end, so it was ` +
        'interrupted (killed, or its terminal closed) part-way, which leaves the bundle without ' +
        'its executable.'
      );
    case 'failed':
      return (
        `The last build failed: ${who} ended ${record.endedAt ?? 'at an unrecorded time'}` +
        `${record.exitCode !== undefined ? ` with exit code ${record.exitCode}` : ''}.`
      );
  }
}
