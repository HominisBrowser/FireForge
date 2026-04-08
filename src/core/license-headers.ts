// SPDX-License-Identifier: EUPL-1.2
import type { ProjectLicense } from '../types/config.js';
import { readText, writeText } from '../utils/fs.js';

/**
 * Comment style for license header formatting.
 * - `js`   — `// ...` line comments
 * - `css`  — block comments
 * - `hash` — `# ...` line comments (FTL, shell, etc.)
 */
export type CommentStyle = 'js' | 'css' | 'hash';

/** Default license when fireforge.json omits the license field. */
export const DEFAULT_LICENSE: ProjectLicense = 'MPL-2.0';

/**
 * Raw (unwrapped) header lines per license.
 *
 * Each entry uses the community-recommended file notice for the license.
 */
const HEADER_LINES: Record<ProjectLicense, string[]> = {
  'MPL-2.0': [
    'This Source Code Form is subject to the terms of the Mozilla Public',
    'License, v. 2.0. If a copy of the MPL was not distributed with this',
    'file, You can obtain one at http://mozilla.org/MPL/2.0/.',
  ],
  'EUPL-1.2': ['SPDX-License-Identifier: EUPL-1.2'],
  'GPL-2.0-or-later': [
    'SPDX-License-Identifier: GPL-2.0-or-later',
    'This file is free software; you can redistribute it and/or modify it',
    'under the terms of the GNU General Public License as published by the',
    'Free Software Foundation; either version 2 of the License, or (at your',
    'option) any later version.',
  ],
  '0BSD': ['SPDX-License-Identifier: 0BSD'],
};

/**
 * Returns a formatted license header comment for the given license and
 * comment style.
 *
 * @param license - SPDX identifier of the project license
 * @param style   - Comment syntax to wrap the header in
 * @returns Multi-line string ready to be placed at the top of a source file
 */
export function getLicenseHeader(license: ProjectLicense, style: CommentStyle): string {
  const lines = HEADER_LINES[license];

  switch (style) {
    case 'js':
      if (lines.length === 1) {
        return `/* ${lines[0]} */`;
      }
      return lines.map((l) => `// ${l}`).join('\n');
    case 'css':
      if (lines.length === 1) {
        return `/* ${lines[0]} */`;
      }
      return (
        `/* ${lines[0]}\n` +
        lines
          .slice(1, -1)
          .map((l) => ` * ${l}`)
          .join('\n') +
        (lines.length > 2 ? '\n' : '') +
        ` * ${lines[lines.length - 1]} */`
      );
    case 'hash':
      return lines.map((l) => `# ${l}`).join('\n');
  }
}

/**
 * Returns true if `content` starts with any known license header for the
 * given comment style.
 *
 * @param content - File content to check
 * @param style   - Comment syntax of the file
 */
export function hasAnyLicenseHeader(content: string, style: CommentStyle): boolean {
  const licenses = Object.keys(HEADER_LINES) as ProjectLicense[];
  return licenses.some((license) => content.startsWith(getLicenseHeader(license, style)));
}

/**
 * Prepends the license header to a file on disk if it is not already present.
 *
 * @param filePath - Absolute path to the file
 * @param license  - SPDX identifier of the license to add
 * @param style    - Comment syntax matching the file type
 * @returns true if the header was added, false if already present
 */
export async function addLicenseHeaderToFile(
  filePath: string,
  license: ProjectLicense,
  style: CommentStyle
): Promise<boolean> {
  const content = await readText(filePath);
  const header = getLicenseHeader(license, style);
  if (content.startsWith(header)) return false;
  await writeText(filePath, header + '\n' + content);
  return true;
}
