// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { getCliVersion } from '../../utils/build-info.js';
import { getPackageRoot } from '../../utils/package-root.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import type { CancelAttribution, JobRequest, ProcessIdentity } from './schema.js';

/**
 * The coordinator protocol: what a client and a supervisor of different builds
 * must share to work together. It covers the socket requests and replies, the
 * job request, the authored snapshot and the job view. Raise it with any change
 * one side could not read from the other; every other difference between builds
 * is the host's to settle, since the pinned build runs every job.
 */
export const COORDINATOR_PROTOCOL = 1;

export interface Endpoint {
  schemaVersion: 1;
  socket: string;
  epoch: number;
  owner: ProcessIdentity;
  /**
   * The supervisor's executor fingerprint. On a host that pins no build, a
   * client on other FireForge bytes refuses to submit, since every result would
   * read as stale for it. Absent from a supervisor that does not record it.
   */
  executorDigest?: string;
  /** The FireForge package the supervisor runs from, for naming it in that refusal. */
  packageRoot?: string;
  /** That package's version and build identity, as `--version` prints it. */
  version?: string;
  /** The {@link COORDINATOR_PROTOCOL} it speaks. Absent from a supervisor that does not record it. */
  protocol?: number;
}
/** What a supervisor publishes: where to reach it, and which FireForge it runs. */
export function publishedEndpoint(
  socket: string,
  election: { epoch: number; owner: ProcessIdentity },
  executorDigest: string
): Endpoint {
  return {
    schemaVersion: 1,
    socket,
    epoch: election.epoch,
    owner: election.owner,
    executorDigest,
    packageRoot: getPackageRoot(),
    version: getCliVersion(),
    protocol: COORDINATOR_PROTOCOL,
  };
}

export type RpcRequest =
  | { operation: 'submit'; owner?: string; request: JobRequest; snapshot: AuthoredSnapshot }
  | { operation: 'status'; jobId: string }
  | { operation: 'cancel'; jobId: string; by?: CancelAttribution; force?: boolean }
  | { operation: 'list' }
  | { operation: 'host-clear'; forget?: number[] }
  | {
      operation: 'authorize' | 'cleanup-uncertain';
      reason?: string;
      jobId: string;
      token: string;
      command: string;
      phase: string;
    };
export interface RpcReply {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** The refusal's class, when it has one a script can branch on. */
  errorName?: string;
}

/** The kernel's limit on a Unix socket path, less room for the socket's own name. */
const SOCKET_DIRECTORY_LIMIT = 80;

/**
 * Where a namespace's socket lives: inside the 0700 namespace when the path
 * fits, otherwise a fixed per-user directory. It never follows a caller's
 * TMPDIR, so no client's session owns the socket.
 */
export function socketDirectory(namespace: string): string {
  const inside = join(resolve(namespace), 'run');
  if (Buffer.byteLength(inside) <= SOCKET_DIRECTORY_LIMIT) return inside;
  const digest = createHash('sha256').update(resolve(namespace)).digest('hex').slice(0, 16);
  return join('/tmp', `ff-jobs-${String(process.getuid?.())}-${digest}`);
}
