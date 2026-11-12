// SPDX-License-Identifier: EUPL-1.2
/**
 * What every project and checkout on one host shares besides the workspace
 * pool: the host configuration file, and the two locks that keep parallel
 * sessions from fighting over the screen and the CPU.
 */
import { isAbsolute, join } from 'node:path';

import { ExitCode } from '../kernel/errors.js';
import { readJsonIfExists } from '../kernel/json.js';
import { COMMAND_WAIT_MS, withLock } from '../kernel/lock.js';
import { type Infer, s } from '../kernel/schema.js';
import type { HostPaths } from '../project/index.js';

const HostConfigSchema = s.object({
  buildSlots: s
    .int({ min: 1 })
    .describe('How many compiles may run at once on this host')
    .default(1),
  releaseSecrets: s
    .string({ min: 1 })
    .refine((path) => (isAbsolute(path) ? undefined : 'must be an absolute path'))
    .describe('Directory holding the secret files release builds read')
    .optional(),
});

/** The host configuration, `host.json` in the FireForge home. */
export type HostConfig = Infer<typeof HostConfigSchema>;

/**
 * Reads `host.json`. A host without one has the defaults.
 *
 * @param host - The host locations
 * @throws `host-config-invalid` (exit code 2) when the file does not match its schema
 */
export async function readHostConfig(host: Pick<HostPaths, 'root'>): Promise<HostConfig> {
  const path = join(host.root, 'host.json');
  const config = await readJsonIfExists(path, HostConfigSchema, {
    code: 'host-config-invalid',
    exitCode: ExitCode.CONFIG_ERROR,
    hint: `Fix ${path}: it takes "buildSlots" (a count) and "releaseSecrets" (a directory).`,
  });
  return config ?? HostConfigSchema.parse({});
}

/**
 * Runs `body` as the one command on this host showing a browser window.
 *
 * @param host - The host locations
 * @param waitMs - How long to wait for the display (default {@link COMMAND_WAIT_MS})
 * @param body - The work
 * @throws `lock-timeout` (exit code 15) naming the holder when the wait expires
 */
export function withDisplay<T>(
  host: Pick<HostPaths, 'locks'>,
  waitMs: number | undefined,
  body: () => Promise<T>
): Promise<T> {
  return withLock(
    join(host.locks, 'display'),
    { label: 'display', waitMs: waitMs ?? COMMAND_WAIT_MS },
    body
  );
}

/**
 * Runs `body` holding one of the host's build slots, so no more compiles run
 * at once than `host.json` allows.
 *
 * @param host - The host locations
 * @param waitMs - How long to wait for a slot (default {@link COMMAND_WAIT_MS})
 * @param body - The compile
 * @throws `lock-timeout` (exit code 15) naming the holders when the wait expires
 */
export async function withBuildSlot<T>(
  host: Pick<HostPaths, 'root' | 'locks'>,
  waitMs: number | undefined,
  body: () => Promise<T>
): Promise<T> {
  const { buildSlots } = await readHostConfig(host);
  return withLock(
    join(host.locks, 'build'),
    {
      mode: 'shared',
      limit: buildSlots,
      label: 'build',
      waitMs: waitMs ?? COMMAND_WAIT_MS,
    },
    body
  );
}
