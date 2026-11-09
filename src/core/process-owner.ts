// SPDX-License-Identifier: EUPL-1.2
import { isExplicitAbsolutePath, isPathInsideRoot } from '../utils/paths.js';
import { listProcesses } from '../utils/process-list.js';

/** Parent evidence; an unreadable parent is never proof of an orphan. */
export async function readProcessOwner(
  pid: number
): Promise<{ parentPid: number; owner: string } | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const [row] = await listProcesses(['ppid'] as const, { pids: [pid], timeoutMs: 5000 });
    const parentPid = row?.ppid;
    if (parentPid === undefined || parentPid < 1) return undefined;
    if (parentPid === 1) return { parentPid, owner: 'init/launchd (parent exited)' };
    const [parent] = await listProcesses(['args'] as const, {
      pids: [parentPid],
      timeoutMs: 5000,
    });
    return parent === undefined ? undefined : { parentPid, owner: parent.args };
  } catch {
    return undefined;
  }
}

/** Harness arguments alone never prove abandonment: require a dead parent too. */
export function isOrphanedHarness(commandLine: string, parentPid?: number): boolean {
  return (
    parentPid === 1 &&
    (/\s-marionette(?:\s|$)/.test(commandLine) ||
      /\s-profile(?:\s|=)[^\n]*(?:fireforge-|mochitest|rust_mozprofile)/.test(commandLine))
  );
}

/** Refreshes the exact command and orphan evidence immediately before signaling. */
export async function isStillOrphanedProcess(pid: number, commandLine: string): Promise<boolean> {
  // Windows ownership has no verified implementation; never infer it from
  // command-line appearance or enable a destructive PowerShell fallback.
  if (process.platform === 'win32') return false;
  try {
    const [row] = await listProcesses(['ppid', 'args'] as const, {
      pids: [pid],
      timeoutMs: 5000,
      requireCleanExit: true,
    });
    return row?.ppid === 1 && row.args === commandLine;
  } catch {
    return false;
  }
}

/**
 * Whether a holder's command line points into this checkout: any absolute
 * token inside the engine directory or the objdir (a relocated objdir sits
 * outside the engine). A token test, so `/a/x/engine` does not claim a holder
 * under `/a/x-2/engine`.
 *
 * @param commandLine - The holder's full command line
 * @param roots - This checkout's absolute directories
 */
export function commandIsInCheckout(
  commandLine: string,
  roots: readonly (string | undefined)[]
): boolean {
  const tokens = commandLine.split(/\s+/).filter(isExplicitAbsolutePath);
  return roots.some(
    (root) => root !== undefined && tokens.some((token) => isPathInsideRoot(root, token))
  );
}
