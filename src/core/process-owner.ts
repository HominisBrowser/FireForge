// SPDX-License-Identifier: EUPL-1.2
import { exec } from '../utils/process.js';

/** Parent evidence; an unreadable parent is never proof of an orphan. */
export async function readProcessOwner(
  pid: number
): Promise<{ parentPid: number; owner: string } | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const result = await exec('ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 5000 });
    const parentPid = Number(result.stdout.trim());
    if (result.exitCode !== 0 || !Number.isSafeInteger(parentPid) || parentPid < 1)
      return undefined;
    if (parentPid === 1) return { parentPid, owner: 'init/launchd (parent exited)' };
    const parent = await exec('ps', ['-p', String(parentPid), '-o', 'args='], { timeout: 5000 });
    if (parent.exitCode !== 0 || !parent.stdout.trim()) return undefined;
    return { parentPid, owner: parent.stdout.trim() };
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
    const result = await exec('ps', ['-p', String(pid), '-o', 'ppid=,args='], { timeout: 5000 });
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(result.stdout);
    return result.exitCode === 0 && match?.[1] === '1' && match[2] === commandLine;
  } catch {
    return false;
  }
}
