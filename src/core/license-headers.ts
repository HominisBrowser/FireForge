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
 * Single-line `/* ... *\/` block comments containing either an Emacs
 * file-mode marker (`-*-`) or a vim modeline (`vim:`) — Mozilla's
 * canonical first-line editor directives that legitimately precede the
 * license header in many Firefox source files.
 *
 * Restricted to single-line blocks so a multi-line license header never
 * gets accidentally consumed.
 */
const EDITOR_DIRECTIVE_BLOCK_COMMENT =
  /^[ \t]*\/\*[^\r\n]*?(?:-\*-|\bvim:)[^\r\n]*?\*\/[ \t]*\r?\n?/;

/**
 * Strips any leading run of editor-directive block comments and blank
 * lines, returning the remaining content.
 *
 * Mozilla's coding convention places editor directives like
 * `/* -*- Mode: javascript; ... -*- *\/` and `/* vim: set ... *\/` on
 * lines 1–2, with the canonical license header following on lines 3+.
 * The raw `content.startsWith(...)` check used by {@link hasAnyLicenseHeader}
 * never matches in that shape; this helper lets the caller test the
 * post-directive prefix as a fallback.
 *
 * @param content - File content to strip
 */
function stripLeadingEditorDirectives(content: string): string {
  let result = content;
  let prev: string;
  do {
    prev = result;
    result = result.replace(/^[ \t]*\r?\n/, '');
    result = result.replace(EDITOR_DIRECTIVE_BLOCK_COMMENT, '');
  } while (result !== prev);
  return result;
}

/**
 * Returns true if `content` starts with any known license header for the
 * given comment style.
 *
 * For `js` files, MPL-2.0 is also accepted in the upstream Mozilla block-
 * comment form (`/* ... *\/`) used by the Firefox source tree, not just the
 * `// ` line-comment form `getLicenseHeader` emits. Without that, a new JS
 * file copied from upstream Firefox (or written to match the surrounding
 * code's convention) hit `missing-license-header` even with a verbatim
 * standard MPL header — operators were forced to `--skip-lint` over a real
 * false positive.
 *
 * Editor-directive block comments (`/* -*- ... -*- *\/`, `/* vim: ... *\/`)
 * leading the file are tolerated — Mozilla's canonical layout puts those
 * on lines 1–2 with the MPL header on lines 3+, which the raw
 * `startsWith` check would otherwise miss.
 *
 * @param content - File content to check
 * @param style   - Comment syntax of the file
 */
export function hasAnyLicenseHeader(content: string, style: CommentStyle): boolean {
  const candidates = [content, stripLeadingEditorDirectives(content)];
  const licenses = Object.keys(HEADER_LINES) as ProjectLicense[];
  for (const candidate of candidates) {
    if (licenses.some((license) => candidate.startsWith(getLicenseHeader(license, style)))) {
      return true;
    }
    if (style === 'js' && candidate.startsWith(getLicenseHeader('MPL-2.0', 'css'))) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if `content` starts with any known license header in any
 * comment style (js, css, hash).
 *
 * @param content - File content to check
 */
export function hasAnyLicenseHeaderAnyStyle(content: string): boolean {
  const styles: CommentStyle[] = ['js', 'css', 'hash'];
  return styles.some((style) => hasAnyLicenseHeader(content, style));
}

/**
 * Returns true if the first few lines of `content` contain a recognized
 * upstream license identifier string.
 *
 * @param content  - File content to check
 * @param maxLines - Number of leading lines to inspect (default 10)
 */
export function containsUpstreamLicenseText(content: string, maxLines = 10): boolean {
  const head = content.split('\n').slice(0, maxLines).join('\n');
  const markers = [
    'Mozilla Public License',
    'SPDX-License-Identifier',
    'Apache License',
    'MIT License',
    'GNU General Public License',
  ];
  return markers.some((marker) => head.includes(marker));
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
