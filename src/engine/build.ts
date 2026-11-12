// SPDX-License-Identifier: EUPL-1.2
/**
 * Building a workspace: write the mozconfig, discard an object directory
 * that was configured at another path, pick the smallest build that is
 * correct, run it under a host build slot, and record the baseline staleness
 * is measured from.
 */
import { constants as osConstants } from 'node:os';

import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import { exists, freeDiskSpace } from '../kernel/fs.js';
import { info, verbose, warn } from '../kernel/log.js';
import { formatDuration } from '../kernel/time.js';
import { unpackagedChanges } from './audit.js';
import { withBuildSlot } from './hostLocks.js';
import { machFailure, type MachResult, runMach } from './mach.js';
import { writeMozconfig } from './mozconfig.js';
import { discardMovedObjdir } from './objdir.js';
import {
  type BuildKind,
  buildStaleness,
  readBuildBaseline,
  recordBuild,
  snapshotEngine,
} from './staleness.js';
import type { Workspace } from './workspace.js';

/** A first full build writes about this much. */
const FULL_BUILD_BYTES = 20 * 1024 ** 3;

/** How {@link build} builds. */
export interface BuildOptions {
  /**
   * Rebuild the front end only (`mach build faster`), keeping the compiled
   * browser. A full build runs instead when the workspace needs one.
   */
  ui?: boolean | undefined;
  /** Parallel compile jobs; default `build.jobs`, else mach's choice. */
  jobs?: number | undefined;
  /** How long to wait for a host build slot, in milliseconds (default: as long as a build takes). */
  waitMs?: number | undefined;
}

/** What {@link build} did. */
export interface BuildResult {
  /** The build that ran. */
  kind: BuildKind;
  /** Why a requested UI build ran as a full build. */
  escalated?: string;
  /**
   * The source directory the object directory had been configured for, when
   * that was another path: it was removed and this build started from nothing.
   */
  discardedObjdirOf?: string;
  durationMs: number;
  /** Changed front-end files that nothing packages (see `audit.ts`). */
  unpackaged: string[];
}

/**
 * An exit status of 128 + N means the process died of signal N: it was
 * interrupted from outside rather than failing, and its log may stop mid-step.
 */
function signalNote(exitCode: number): string {
  if (exitCode <= 128 || exitCode > 192) return '';
  const signal = Object.entries(osConstants.signals).find(([, value]) => value === exitCode - 128);
  return ` (killed by ${signal?.[0] ?? `signal ${exitCode - 128}`}: interrupted from outside, not a compile error)`;
}

function buildFailure(command: string, result: MachResult, durationMs: number): FireForgeError {
  const how = result.timedOut
    ? 'timed out'
    : `exited ${result.exitCode}${signalNote(result.exitCode)}`;
  return new FireForgeError(
    'build-failed',
    `${command} ${how} after ${formatDuration(durationMs)}`,
    { exitCode: ExitCode.BUILD_ERROR, hint: 'The first error in the output above is the cause.' }
  );
}

/** What changed since the build, with the first few paths. */
function describeStaleness(staleness: { why: string; paths: readonly string[] }): string {
  const sample = staleness.paths.slice(0, 5).join(', ');
  return `${staleness.why}${sample === '' ? '' : ` (${sample}${staleness.paths.length > 5 ? ', ...' : ''})`}`;
}

/** The build that is correct for what was asked: a UI build only when nothing needs more. */
async function chooseBuild(
  workspace: Workspace,
  ui: boolean
): Promise<{ kind: BuildKind; escalated?: string }> {
  if (!ui) return { kind: 'full' };
  const staleness = await buildStaleness(workspace);
  if (staleness.state === 'fresh' || staleness.needs === 'ui') return { kind: 'ui' };
  const escalated = describeStaleness(staleness);
  warn(`Running a full build instead of a UI build: ${escalated}.`);
  return { kind: 'full', escalated };
}

/**
 * Builds the workspace's engine.
 *
 * @param workspace - The workspace
 * @param options - See {@link BuildOptions}
 * @throws `build-failed` (exit code 5) when mach fails, `mozconfig-invalid`
 *   (exit code 2), `lock-timeout` (exit code 15) when no build slot came free
 */
export async function build(
  workspace: Workspace,
  options: BuildOptions = {}
): Promise<BuildResult> {
  const { project } = workspace;
  await writeMozconfig(workspace);
  const discardedObjdirOf = await discardMovedObjdir(workspace);
  if (discardedObjdirOf !== undefined) {
    warn(
      `The object directory of workspace "${workspace.name}" was configured for ${discardedObjdirOf}, ` +
        `not ${workspace.engineDir}. A build cannot be moved to another path, so it was removed and this is a full build from nothing.`
    );
  }
  const { kind, escalated } = await chooseBuild(workspace, options.ui === true);
  const previous = await readBuildBaseline(workspace);

  if (kind === 'full' && !(await exists(workspace.objDir))) {
    const free = await freeDiskSpace(workspace.engineDir);
    if (free !== undefined && free < FULL_BUILD_BYTES) {
      warn(
        `Only ${Math.floor(free / 1024 ** 3)} GB are free at ${workspace.engineDir}; a first full build needs about 20 GB.`
      );
    }
  }
  const jobs = options.jobs ?? project.config.build?.jobs;
  const args =
    kind === 'ui'
      ? ['build', 'faster']
      : ['build', ...(jobs === undefined ? [] : ['-j', String(jobs)])];
  const startedAt = Date.now();
  const { result, snapshot } = await withBuildSlot(project.host, options.waitMs, async () => {
    const taken = await snapshotEngine(workspace);
    info(`Running mach ${args.join(' ')} in workspace "${workspace.name}".`);
    return { result: await runMach(workspace, args), snapshot: taken };
  });
  const durationMs = Date.now() - startedAt;
  if (result.exitCode !== 0) throw buildFailure(`mach ${args.join(' ')}`, result, durationMs);

  let unpackaged: string[] = [];
  try {
    unpackaged = await unpackagedChanges(workspace, previous?.tree);
  } catch (error: unknown) {
    verbose(`The packaging audit did not run: ${toError(error).message}`);
  }
  if (unpackaged.length > 0) {
    warn(
      `${unpackaged.length} changed file(s) are not packaged into the browser: ${unpackaged.join(', ')}. ` +
        'Register each in a jar.mn or moz.build ("fireforge register <path>"), or declare it in buildAudit.unpackaged.'
    );
  }
  await recordBuild(workspace, kind, snapshot);
  return {
    kind,
    ...(escalated === undefined ? {} : { escalated }),
    ...(discardedObjdirOf === undefined ? {} : { discardedObjdirOf }),
    durationMs,
    unpackaged,
  };
}

/**
 * Installs Firefox's build dependencies with `mach bootstrap`, which prompts
 * and may ask for elevated rights, so it gets the terminal.
 *
 * @param workspace - Any workspace on the project's pin
 * @throws `mach-failed` (exit code 5) when mach fails
 */
export async function bootstrap(workspace: Workspace): Promise<void> {
  const result = await runMach(workspace, ['bootstrap', '--application-choice', 'browser'], {
    terminal: true,
  });
  if (result.exitCode !== 0) {
    throw machFailure(
      'mach bootstrap',
      result,
      'Fix what the output above names, then run "fireforge bootstrap" again.'
    );
  }
}

/**
 * Makes sure the workspace's build matches its engine before a command uses
 * it. A stale build is refused with the command that fixes it, unless
 * `build` asks for that build to run now, once, as the smallest one that
 * catches up.
 *
 * @param workspace - The workspace
 * @param options - `build` builds instead of refusing; `waitMs` is for the host build slot
 * @returns The build that ran, or undefined when the build was fresh
 * @throws `build-stale` naming what changed and the build that catches up
 */
export async function ensureBuilt(
  workspace: Workspace,
  options: { build?: boolean | undefined; waitMs?: number | undefined } = {}
): Promise<BuildResult | undefined> {
  const staleness = await buildStaleness(workspace);
  if (staleness.state === 'fresh') return undefined;
  const why = describeStaleness(staleness);
  const ui = staleness.needs === 'ui';
  if (options.build === true) {
    info(`Building first: ${why}.`);
    return build(workspace, { ui, waitMs: options.waitMs });
  }
  throw new FireForgeError(
    'build-stale',
    `The build of workspace "${workspace.name}" is older than its engine: ${why}.`,
    {
      exitCode: ExitCode.GENERAL_ERROR,
      hint: `Run "fireforge build${ui ? ' --ui' : ''}", or pass --build to build first.`,
    }
  );
}
