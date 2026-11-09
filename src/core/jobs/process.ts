// SPDX-License-Identifier: EUPL-1.2
import {
  groupMembers,
  processHasExitedAsync,
  processIdentityAsync,
  snapshotProcesses,
} from '../../utils/process-birth.js';
import type { ProcessIdentity } from './schema.js';

export { processHasExitedAsync, processIdentityAsync };

/** Whether `identity` is alive. False covers "gone", "replaced" and "the probe failed". */
export async function isSameProcess(identity: ProcessIdentity): Promise<boolean> {
  return (await processIdentityAsync(identity.pid))?.start === identity.start;
}

/**
 * Signals a positively owned detached process group while its leader is
 * identifiable.
 *
 * @param identity - The group leader's exact identity
 * @param signal - Signal to send
 * @returns True when the signal was delivered
 */
export async function signalOwnedProcess(
  identity: ProcessIdentity,
  signal: NodeJS.Signals
): Promise<boolean> {
  if (!(await isSameProcess(identity))) return false;
  try {
    process.kill(-identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether descendants remain in an owned group. A missing leader or a failed
 * census never reads as empty.
 *
 * @param pid - The group id
 */
export async function groupHasLiveMembers(pid: number): Promise<boolean> {
  const snapshot = await snapshotProcesses();
  return snapshot === undefined || groupMembers(snapshot, pid).length > 0;
}
