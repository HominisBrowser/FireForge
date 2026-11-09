// SPDX-License-Identifier: EUPL-1.2
/**
 * Where an interactive run's kept browser profile may live. A kept profile
 * carries one session's state into the next, so it sits outside everything a
 * job proves or reads: every slot, the coordinator namespace and tracked source.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';

/** The checks a request can carry without touching disk: an absolute, normal, plain path. */
export function assertKeptProfileShape(profile: unknown): asserts profile is string {
  if (
    typeof profile !== 'string' ||
    profile.length === 0 ||
    profile.includes('\0') ||
    !isAbsolute(profile) ||
    normalize(profile) !== profile ||
    (profile.length > 1 && profile.endsWith('/'))
  )
    throw new Error('Step profile must be an absolute, normalized directory path');
}

/** The path with every existing ancestor's links resolved, so a symlink cannot hide where it lands. */
export async function physicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

/** Whether `path` is `root` or lies under it. Both are physical paths. */
export function within(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

/**
 * Refuses a kept profile inside any of the named places, each by what it is.
 *
 * @param profile - The absolute profile directory
 * @param places - What each forbidden root is called, by its path
 */
export async function assertKeptProfileOutside(
  profile: string,
  places: Readonly<Record<string, string>>
): Promise<void> {
  const physical = await physicalPath(profile);
  for (const [label, root] of Object.entries(places)) {
    const inside = within(await physicalPath(root), physical);
    if (inside)
      throw new Error(
        `A kept profile cannot live inside ${label} (${root}): name a directory outside every slot, the coordinator namespace and tracked source`
      );
  }
}
