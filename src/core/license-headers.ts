// SPDX-License-Identifier: EUPL-1.2
import type { ProjectLicense } from '../types/config.js';
import { readText, writeText } from '../utils/fs.js';

/**
 * Comment style for license header formatting.
 * - `js`:   `// ...` line comments
 * - `css`:  block comments
 * - `hash`: `# ...` line comments (FTL, shell, etc.)
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
 * file-mode marker (`-*-`) or a vim modeline (`vim:`). These are Mozilla's
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
 * lines 1 and 2, with the canonical license header following on lines 3+.
 * The raw `content.startsWith(...)` check used by {@link hasAnyLicenseHeader}
 * never matches in that shape. This helper lets the caller test the
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
 * Collapses all whitespace runs to single spaces and trims, so header
 * comparisons ignore the exact line-break/wrap positions.
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The canonical upstream MPL-2.0 notice as a single normalized sentence
 * (including the `http://mozilla.org/MPL/2.0/.` URL). Wrap-agnostic
 * header checks match against this instead of an exact rendering.
 */
const MPL_HEADER_NORMALIZED = normalizeText(HEADER_LINES['MPL-2.0'].join(' '));

/**
 * Extracts only the leading comment span of `content` for the given
 * comment style and returns it whitespace-normalized:
 *
 * - `js`:   a leading run of `//` lines (markers stripped), or (when the
 *           file opens with a block comment instead) the first
 *           `/* … *\/` block.
 * - `css`:  the first `/* … *\/` block, with the ` * ` continuation-line
 *           prefixes stripped (same collapsing
 *           {@link normalizeLicenseHeadForScan} does).
 * - `hash`: a leading run of `#` lines (markers stripped).
 *
 * A non-comment first line yields `''`. This lets callers accept a known
 * header text regardless of where upstream wrapped its lines (e.g. the
 * older Mozilla wrap that breaks after "file,"), without ever matching
 * text beyond the leading comment.
 */
function normalizeCommentHead(content: string, style: CommentStyle): string {
  const src = content.replace(/\r\n?/g, '\n');

  const collectLineRun = (marker: RegExp): string => {
    const parts: string[] = [];
    for (const line of src.split('\n')) {
      const m = marker.exec(line);
      if (!m) break;
      parts.push(m[1] ?? '');
    }
    return normalizeText(parts.join(' '));
  };

  if (style === 'hash') {
    return collectLineRun(/^[ \t]*#[ \t]?(.*)$/);
  }
  if (style === 'js' && /^[ \t]*\/\//.test(src)) {
    return collectLineRun(/^[ \t]*\/\/[ \t]?(.*)$/);
  }
  const block = /^[ \t]*\/\*([\s\S]*?)\*\//.exec(src);
  if (!block) return '';
  return normalizeText((block[1] ?? '').replace(/\n[ \t]*\*[ \t]*/g, ' '));
}

/**
 * Returns true if `content` starts with any known license header for the
 * given comment style.
 *
 * For `js` files, MPL-2.0 is also accepted in the upstream Mozilla block-
 * comment form (`/* ... *\/`) used by the Firefox source tree, not just the
 * `// ` line-comment form `getLicenseHeader` emits. Otherwise a new JS file
 * copied from upstream Firefox hits `missing-license-header` even with a
 * verbatim standard MPL header.
 *
 * Editor-directive block comments (`/* -*- ... -*- *\/`, `/* vim: ... *\/`)
 * leading the file are tolerated: Mozilla's canonical layout puts those on
 * lines 1 and 2 with the MPL header on lines 3+, which a raw `startsWith` check
 * would miss.
 *
 * The MPL-2.0 header is additionally matched on normalized whitespace (see
 * {@link normalizeCommentHead}) so upstream files using the older Mozilla
 * wrap (breaking after "file," instead of "with this") are accepted too.
 * Only the wrap position differs, never the wording.
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
    if (normalizeCommentHead(candidate, style).startsWith(MPL_HEADER_NORMALIZED)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if `content` starts with the verbatim upstream Mozilla
 * MPL-2.0 block header (`/* This Source Code Form … *\/`), optionally
 * preceded by editor-directive comments, the exact shape a JS file copied
 * from the Firefox source tree carries.
 *
 * Independent of the project license: a new JS file that
 * legitimately keeps its upstream MPL block header is valid in an
 * EUPL/GPL/0BSD project too.
 *
 * Matching is wrap-agnostic: after the exact `startsWith` fast path, the
 * leading block comment is compared on normalized whitespace (see
 * {@link normalizeCommentHead}) so the older upstream wrap (breaking after
 * "file," instead of "with this", as `ext-browser.js` ships) passes too.
 * Only the line-break position may differ. Altered wording still rejects.
 *
 * @param content - File content to check
 */
export function hasUpstreamMplBlockHeader(content: string): boolean {
  const blockHeader = getLicenseHeader('MPL-2.0', 'css');
  const candidates = [content, stripLeadingEditorDirectives(content)];
  for (const candidate of candidates) {
    if (candidate.startsWith(blockHeader)) return true;
    if (normalizeCommentHead(candidate, 'css').startsWith(MPL_HEADER_NORMALIZED)) return true;
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
 * Collapses block-comment continuation lines (`\n` + ` * ` prefixes) so
 * substring markers like `Mozilla Public License` match Mozilla's wrapped
 * MPL boilerplate.
 */
function normalizeLicenseHeadForScan(head: string): string {
  let s = head.replace(/\r\n?/g, '\n');
  s = s.replace(/\n[ \t]*\*[ \t]*/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Recognizes the CC0 public-domain dedication Mozilla puts on most of its
 * test files, in every spelling the tree carries:
 *
 * - the prose (`Any copyright is dedicated to the Public Domain.`), which
 *   the block, `//` and `#` comment forms all reduce to after
 *   {@link normalizeLicenseHeadForScan}.
 * - the dedication URL (`creativecommons.org/publicdomain/zero/1.0/`, with
 *   either scheme).
 * - the SPDX identifier `CC0-1.0`.
 *
 * Narrow on purpose: a bare "public domain" mention, a different Creative
 * Commons license (`licenses/by/4.0/`, `CC-BY-4.0`) or a made-up
 * `publicdomain/zero/2.0/` is not a CC0 dedication and must not be
 * accepted as one. `scanText` must already be normalized (and may be
 * lowercased, since the match is case-insensitive).
 */
function hasCc0Dedication(scanText: string): boolean {
  return /dedicated to the public domain|creativecommons\.org\/publicdomain\/zero\/1\.0|spdx-license-identifier:\s*cc0-1\.0\b/i.test(
    scanText
  );
}

/**
 * Returns true if the first few lines of `content` contain a recognized
 * upstream license identifier string: Mozilla's MPL boilerplate, an SPDX
 * tag, the common permissive/copyleft license names, or the CC0
 * public-domain dedication upstream test files carry.
 *
 * @param content  - File content to check
 * @param maxLines - Number of leading lines to inspect (default 10)
 */
export function containsUpstreamLicenseText(content: string, maxLines = 10): boolean {
  const head = content.split('\n').slice(0, maxLines).join('\n');
  const scanText = normalizeLicenseHeadForScan(head);
  const markers = [
    'Mozilla Public License',
    'SPDX-License-Identifier',
    'Apache License',
    'MIT License',
    'GNU General Public License',
  ];
  return markers.some((marker) => scanText.includes(marker)) || hasCc0Dedication(scanText);
}

/**
 * Returns true when the head of `content` carries a recognized third-party
 * permissive license banner (MIT / ISC / BSD-2 / BSD-3 / Apache-2.0) or the
 * CC0 public-domain dedication, in any comment style. Used by `export` to
 * treat such files as vendored: offering to prepend the project's own
 * license header onto a byte-identity-pinned upstream bundle, or onto a
 * test file Mozilla dedicated to the public domain, would mislicense code
 * the project does not own.
 *
 * @param content  - File content to check
 * @param maxLines - Number of leading lines to inspect (default 30, because
 *   full MIT/BSD license texts run longer than the 10-line project-header
 *   scan)
 */
export function hasThirdPartyPermissiveBanner(content: string, maxLines = 30): boolean {
  const head = content.split('\n').slice(0, maxLines).join('\n');
  const scanText = normalizeLicenseHeadForScan(head).toLowerCase();
  const markers = [
    'mit license',
    'permission is hereby granted, free of charge',
    'isc license',
    'permission to use, copy, modify',
    'redistribution and use in source and binary forms',
    'apache license',
    'licensed under the apache license',
  ];
  if (markers.some((marker) => scanText.includes(marker))) return true;
  if (hasCc0Dedication(scanText)) return true;
  return /spdx-license-identifier:\s*(mit|isc|bsd-2-clause|bsd-3-clause|apache-2\.0|cc0-1\.0)\b/.test(
    scanText
  );
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
