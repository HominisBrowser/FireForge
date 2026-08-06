// SPDX-License-Identifier: EUPL-1.2
/**
 * Copy-on-write cloning for `fireforge tree` (FORGE G15).
 *
 * Capability is probed BY DOING — a tiny `cp -c` (APFS clonefile) or
 * `cp --reflink=always` (btrfs/XFS) in the actual destination directory —
 * so the verdict is truthful for the volume the trees will live on. A
 * filesystem without CoW support REFUSES honestly; `--force-copy` opts
 * into a full physical copy but is never implied (a Firefox tree can be
 * tens of gigabytes).
 *
 * The exec layer is injected so unit tests assert the exact `cp` argv per
 * platform without touching the filesystem.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';

/** Runs a clone command; throws on non-zero exit. */
export type CloneExecutor = (command: string, args: string[]) => Promise<void>;

/** How this host can materialise a tree. */
export type CowCapability = 'clonefile' | 'reflink' | 'none';

const defaultExecutor: CloneExecutor = async (command, args) => {
  const result = await exec(command, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${String(result.exitCode)}): ${result.stderr}`
    );
  }
};

/** Per-platform `cp` argv prefix for a CoW copy of one entry. */
export function cowCopyArgs(capability: Exclude<CowCapability, 'none'>): string[] {
  return capability === 'clonefile' ? ['-c', '-R', '-p'] : ['--reflink=always', '-a'];
}

/**
 * Probes CoW support in `dir` by cloning a tiny probe file there.
 * Non-darwin/linux platforms report 'none' without probing.
 */
export async function detectCowSupport(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  executor: CloneExecutor = defaultExecutor
): Promise<CowCapability> {
  if (platform !== 'darwin' && platform !== 'linux') return 'none';
  const capability: Exclude<CowCapability, 'none'> =
    platform === 'darwin' ? 'clonefile' : 'reflink';

  let probeDir: string | undefined;
  try {
    probeDir = await mkdtemp(join(dir, '.fireforge-cow-probe-'));
    const src = join(probeDir, 'src');
    const dst = join(probeDir, 'dst');
    await writeFile(src, 'probe');
    const flag = capability === 'clonefile' ? '-c' : '--reflink=always';
    await executor('cp', [flag, src, dst]);
    return capability;
  } catch (error: unknown) {
    verbose(`CoW probe in ${dir} failed: ${toError(error).message}`);
    return 'none';
  } finally {
    if (probeDir !== undefined) {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Copies one directory entry (file or directory, recursively) from
 * `sourcePath` to `destinationPath` using the given capability —
 * clonefile/reflink when available, a plain physical copy under
 * 'none' (the `--force-copy` path; the CALLER gates on the flag).
 */
export async function cloneEntry(
  capability: CowCapability,
  sourcePath: string,
  destinationPath: string,
  platform: NodeJS.Platform = process.platform,
  executor: CloneExecutor = defaultExecutor
): Promise<void> {
  const args =
    capability === 'none'
      ? platform === 'darwin'
        ? ['-R', '-p']
        : ['-a']
      : cowCopyArgs(capability);
  await executor('cp', [...args, sourcePath, destinationPath]);
}
