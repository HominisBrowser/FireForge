// SPDX-License-Identifier: EUPL-1.2
import type { ChildProcess } from 'node:child_process';

import { signalDirectChild } from '../../utils/child-process.js';
import type { ProcessOwnership } from '../../utils/process-group.js';
import { sleep } from '../../utils/sleep.js';
import { groupHasLiveMembers, signalOwnedProcess } from './process.js';
import type { OwnedProcessTracker } from './process-tracker.js';
import type { ProcessIdentity } from './schema.js';

/**
 * Tears down an executor whose launch failed. The caller must await this before
 * releasing admission, and holds what it reports as uncertain.
 *
 * @returns Why the teardown could not be established, when it could not
 */
export async function cleanupFailedExecutor(options: {
  child: ChildProcess;
  identity?: ProcessIdentity;
  ownership?: ProcessOwnership;
  tracker?: OwnedProcessTracker;
}): Promise<string | undefined> {
  const { child, identity, ownership, tracker } = options;
  if (child.pid === undefined) {
    if (child.connected) child.disconnect();
    return undefined;
  }
  const alive = (): boolean => child.exitCode === null && child.signalCode === null;
  const signal = async (value: NodeJS.Signals): Promise<void> => {
    if (ownership) ownership.signal(value);
    else if (identity) await signalOwnedProcess(identity, value);
    else signalDirectChild(child, value);
  };
  let uncertainty: string | undefined;
  try {
    await signal('SIGTERM');
    if (alive()) await sleep(200);
    await signal('SIGKILL');
    if (alive()) await sleep(200);
    const teardown = await ownership?.finish(100);
    if (teardown?.uncertain !== undefined) uncertainty = teardown.uncertain;
    const cleanup = await tracker?.finish();
    if (
      cleanup?.clean === false ||
      alive() ||
      (identity !== undefined && (await groupHasLiveMembers(identity.pid)))
    ) {
      uncertainty = 'Failed executor launch left unconfirmed process cleanup';
    }
    if (identity === undefined) {
      uncertainty = 'Launched executor has no authenticated birth identity';
    }
  } catch (error: unknown) {
    uncertainty = String(error);
  } finally {
    ownership?.dispose();
    if (child.connected) child.disconnect();
  }
  return uncertainty;
}
