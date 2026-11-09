// SPDX-License-Identifier: EUPL-1.2
import type { ChildProcess } from 'node:child_process';

/** A failed spawn has no signal target; never call Node's native kill with an undefined PID. */
export function signalDirectChild(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM'
): boolean {
  if (
    child.pid === undefined ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 1 ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
