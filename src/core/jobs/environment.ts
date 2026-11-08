// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getPackageRoot } from '../../utils/package-root.js';

/**
 * The shipped CLI adapter, as bytes: a phase runs this file and sealing compares
 * it. Read when a phase needs it, because every command imports this module's
 * callers and most of them never launch a phase.
 */
export const readCliCacheHook = (): Promise<string> =>
  readFile(join(getPackageRoot(), 'runtime', 'qualified-node-bootstrap.cjs'), 'utf8');

/**
 * What crosses from a client into the supervisor, and from the supervisor into a
 * job. Nothing else does: one agent's `NODE_OPTIONS`, `MOZ_*` or sandbox settings
 * must not decide how another agent's job runs. Node and PATH are recorded when
 * the namespace is initialized, so they do not depend on which client spawned
 * the supervisor. TMPDIR stays out because a caller's may belong to its session.
 */
const ALLOWED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'FIREFORGE_COORDINATOR',
  'FIREFORGE_TOOLCHAINS',
  // How FireForge's own launcher runs a phase's Node: see `sourceLoaderCacheEnvironment`.
  'TSX_DISABLE_CACHE',
  'NODE_DISABLE_COMPILE_CACHE',
  'JITI_FS_CACHE',
]);

/** The allowed subset of an environment. */
export function allowedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) =>
      value !== undefined && ALLOWED.has(key) ? [[key, value]] : []
    )
  );
}
