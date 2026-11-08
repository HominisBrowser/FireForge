// SPDX-License-Identifier: EUPL-1.2
import { resolve } from 'node:path';

import { toError } from '../../utils/errors.js';
import { ElectionLostError } from './election.js';
import { LocalSupervisor } from './supervisor.js';

/** Start only an explicit owned namespace; absence must never initialize a host default accidentally. */
export async function startOwnedCoordinator(namespace: string | undefined): Promise<void> {
  if (namespace === undefined) throw new Error('Missing coordinator namespace');
  await LocalSupervisor.start(resolve(namespace));
}

// Guarded work records its own failures. Whatever still escapes is logged rather than
// allowed to take every active job down with this process.
process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`Unhandled supervisor rejection: ${String(reason)}\n`);
});

// A loser of the election is how a second start is meant to end, and one line says so.
await startOwnedCoordinator(process.argv[2]).catch((error: unknown) => {
  process.stderr.write(`Supervisor did not start: ${toError(error).message}\n`);
  process.exitCode = error instanceof ElectionLostError ? 0 : 1;
});
