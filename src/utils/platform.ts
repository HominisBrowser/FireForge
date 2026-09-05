// SPDX-License-Identifier: EUPL-1.2
import { platform } from 'node:os';

import { GeneralError } from '../errors/base.js';

/**
 * Supported operating system platforms.
 */
export type Platform = 'darwin' | 'linux' | 'win32';

/**
 * Gets the current operating system platform.
 * @throws Error if running on an unsupported platform
 */
export function getPlatform(): Platform {
  const p = platform();
  if (p === 'darwin' || p === 'linux' || p === 'win32') {
    return p;
  }
  throw new GeneralError(
    `Unsupported platform: ${p}. FireForge supports darwin, linux, and win32.`
  );
}
