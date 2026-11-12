// SPDX-License-Identifier: EUPL-1.2
/**
 * License headers of the fork's files: the header text of each project
 * license per comment style, and recognising a header at the top of a file.
 */
import { PROJECT_LICENSES } from '../config/index.js';

/** A project license. */
export type License = (typeof PROJECT_LICENSES)[number];

/** How a file kind writes comments. */
export type CommentStyle = 'js' | 'css' | 'hash';

const HEADER_LINES: Readonly<Record<License, readonly string[]>> = {
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
 * The header the project writes at the top of a new file.
 *
 * @param license - The project license
 * @param style - The file's comment style
 */
export function licenseHeader(license: License, style: CommentStyle): string {
  const lines = HEADER_LINES[license];
  if (style === 'hash') return lines.map((line) => `# ${line}`).join('\n');
  if (lines.length === 1) return `/* ${lines[0] ?? ''} */`;
  if (style === 'js') return lines.map((line) => `// ${line}`).join('\n');
  const [first, ...rest] = lines;
  return [`/* ${first ?? ''}`, ...rest.map((line) => ` * ${line}`)].join('\n') + ' */';
}

const EDITOR_DIRECTIVE = /^[ \t]*\/\*[^\r\n]*?(?:-\*-|\bvim:)[^\r\n]*?\*\/[ \t]*\r?\n?/;

/** Drops leading blank lines and `-*- … -*-` / `vim:` directive comments. */
function withoutDirectives(content: string): string {
  let result = content;
  for (let previous = ''; result !== previous;) {
    previous = result;
    result = result.replace(/^[ \t]*\r?\n/, '').replace(EDITOR_DIRECTIVE, '');
  }
  return result;
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** Upstream writes the MPL address with either scheme; headers are compared with one. */
const oneScheme = (text: string): string =>
  text.replace('https://mozilla.org/MPL/2.0/', 'http://mozilla.org/MPL/2.0/');
const MPL_TEXT = normalize(HEADER_LINES['MPL-2.0'].join(' '));

/** The text of the leading comment, continuation markers removed, whitespace collapsed. */
function leadingCommentText(content: string, style: CommentStyle): string {
  const source = content.replace(/\r\n?/g, '\n');
  const lineRun = (marker: RegExp): string => {
    const parts: string[] = [];
    for (const line of source.split('\n')) {
      const match = marker.exec(line);
      if (!match) break;
      parts.push(match[1] ?? '');
    }
    return normalize(parts.join(' '));
  };
  if (style === 'hash') return lineRun(/^[ \t]*#[ \t]?(.*)$/);
  if (style === 'js' && /^[ \t]*\/\//.test(source)) return lineRun(/^[ \t]*\/\/[ \t]?(.*)$/);
  const block = /^[ \t]*\/\*([\s\S]*?)\*\//.exec(source);
  if (!block) return '';
  return normalize(
    (block[1] ?? '').replace(/^[ \t]*-[ \t]+/, '').replace(/\n[ \t]*[*-][ \t]*/g, ' ')
  );
}

/**
 * Whether content starts with any project license's header in the style,
 * or with the MPL text however it is wrapped, behind any editor directives.
 *
 * @param content - File content
 * @param style - The comment style to read
 */
export function hasLicenseHeader(content: string, style: CommentStyle): boolean {
  const text = oneScheme(content);
  return [text, withoutDirectives(text)].some(
    (candidate) =>
      PROJECT_LICENSES.some((license) => candidate.startsWith(licenseHeader(license, style))) ||
      (style === 'js' && candidate.startsWith(licenseHeader('MPL-2.0', 'css'))) ||
      leadingCommentText(candidate, style).startsWith(MPL_TEXT)
  );
}

/**
 * Whether content starts with the upstream MPL block header (`/* … *\/`),
 * however wrapped, behind any editor directives: what a file copied from
 * Firefox keeps for provenance.
 *
 * @param content - File content
 */
export function hasUpstreamMplHeader(content: string): boolean {
  const text = oneScheme(content);
  return [text, withoutDirectives(text)].some(
    (candidate) =>
      candidate.startsWith(licenseHeader('MPL-2.0', 'css')) ||
      leadingCommentText(candidate, 'css').startsWith(MPL_TEXT)
  );
}

/** The start of a comment's continuation line: `//`, `*`, `#` or the `-` of a markup comment. */
const CONTINUATION = /\n[ \t]*(?:\/\/+|[*#-])[ \t]*/g;

/**
 * Whether a license notice is mentioned anywhere near the top of a file,
 * in any comment form and however the notice is wrapped across lines.
 *
 * @param content - File content
 */
export function mentionsLicense(content: string): boolean {
  const head = normalize(
    content.replace(/\r\n?/g, '\n').split('\n').slice(0, 10).join('\n').replace(CONTINUATION, ' ')
  );
  return (
    [
      'Mozilla Public License',
      'SPDX-License-Identifier',
      'Apache License',
      'MIT License',
      'GNU General Public License',
    ].some((marker) => head.includes(marker)) ||
    /dedicated to the public domain|creativecommons\.org\/publicdomain\/zero\/1\.0|spdx-license-identifier:\s*cc0-1\.0\b/i.test(
      head
    )
  );
}
