// SPDX-License-Identifier: EUPL-1.2
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type { FurnaceConfig } from '../types/furnace.js';
import { getNodeErrorCode } from '../utils/errors.js';
import { CUSTOM_ELEMENTS_JS, JAR_MN } from './furnace-constants.js';

/** Checks all component destinations before an apply starts writing. */
export async function assertComponentWriteBoundaries(
  engineDir: string,
  config: FurnaceConfig,
  ftlDir: string
): Promise<void> {
  const destinations = new Set([
    ftlDir,
    dirname(JAR_MN),
    dirname(CUSTOM_ELEMENTS_JS),
    ...Object.values(config.custom).map((entry) => entry.targetPath),
    ...Object.values(config.overrides).map((entry) => entry.basePath),
  ]);
  for (const destination of destinations) {
    await assertEngineWriteBoundary(engineDir, join(engineDir, destination));
  }
}

/** Resolves the nearest existing parent before any mkdir/copy can write through an alias. */
export async function assertEngineWriteBoundary(
  engineDir: string,
  directory: string
): Promise<void> {
  const root = await realpath(engineDir);
  let parent = resolve(directory);
  for (;;) {
    try {
      const canonical = await realpath(parent);
      if (canonical !== root && !canonical.startsWith(root + sep)) {
        throw new FurnaceError(
          `Engine destination ${directory} resolves outside engine/ (${canonical}). Refusing to write through into component sources or another checkout.`
        );
      }
      return;
    } catch (error: unknown) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}
