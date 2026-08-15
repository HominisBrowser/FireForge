// SPDX-License-Identifier: EUPL-1.2
/**
 * CSS registration in browser/themes/shared/jar.inc.mn.
 */

import { basename, join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { escapeRegex } from '../utils/regex.js';
import { findAlphabeticalPosition, findAlphabeticalTokenPosition } from './manifest-helpers.js';
import { tokenizeJarMn } from './manifest-tokenizers.js';
import { withParserFallback } from './parser-fallback.js';
import type { RegisterResult } from './register-result.js';

/**
 * Tokenizer-based implementation for shared CSS registration.
 */
function registerSharedCSSTokenized(
  content: string,
  name: string,
  entry: string,
  after?: string
): {
  result: string;
  insertIndex: number;
  previousEntry: string | undefined;
  afterFallback: boolean;
} {
  const lines = content.split('\n');
  const tokens = tokenizeJarMn(lines);
  let afterFallback = false;

  let insertIndex: number;
  let previousEntry: string | undefined;

  if (after) {
    const afterPattern = new RegExp(`(?:^|/)${escapeRegex(after)}(?:\\s|\\)|$)`);
    const afterToken = tokens.find((t) => afterPattern.test(t.raw));
    if (afterToken) {
      insertIndex = afterToken.lineIndex + 1;
      previousEntry = afterToken.raw.trim();
    } else {
      afterFallback = true;
      ({ insertIndex, previousEntry } = findAlphabeticalTokenPosition(
        tokens,
        /skin\/classic\/browser\/([^.]+)\.css/,
        name
      ));
    }
  } else {
    ({ insertIndex, previousEntry } = findAlphabeticalTokenPosition(
      tokens,
      /skin\/classic\/browser\/([^.]+)\.css/,
      name
    ));
  }

  if (insertIndex === -1) {
    throw new GeneralError('Could not find skin/classic/browser/ section in jar.inc.mn');
  }

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), insertIndex, previousEntry, afterFallback };
}

/**
 * Legacy line-based implementation preserved as fallback.
 */
function legacyRegisterSharedCSS(
  content: string,
  name: string,
  entry: string,
  after?: string
): { result: string; previousEntry: string | undefined; afterFallback: boolean } {
  const lines = content.split('\n');
  let afterFallback = false;

  const extractKey = (line: string): string | undefined => {
    const match = /skin\/classic\/browser\/([^.]+)\.css/.exec(line);
    return match?.[1];
  };

  let insertIndex: number;
  let previousEntry: string | undefined;

  // Find skin/classic/browser/ section boundaries
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/skin\/classic\/browser\//.test(line)) {
      if (sectionStart === -1) sectionStart = i;
      sectionEnd = i + 1;
    }
  }

  if (sectionStart === -1) {
    throw new GeneralError('Could not find skin/classic/browser/ section in jar.inc.mn');
  }

  if (after) {
    const afterLineIdx = lines.findIndex((l) => l.includes(after));
    if (afterLineIdx !== -1) {
      insertIndex = afterLineIdx + 1;
      previousEntry = lines[afterLineIdx]?.trim();
    } else {
      afterFallback = true;
      ({ insertIndex, previousEntry } = findAlphabeticalPosition(
        lines,
        sectionStart,
        sectionEnd,
        name,
        extractKey
      ));
    }
  } else {
    ({ insertIndex, previousEntry } = findAlphabeticalPosition(
      lines,
      sectionStart,
      sectionEnd,
      name,
      extractKey
    ));
  }

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), previousEntry, afterFallback };
}

/** Minimum gap between the target path and the source parenthesis. */
const MIN_SOURCE_GAP = 4;

/**
 * Measures the column at which the `(source)` parenthesis opens in
 * adjacent `skin/classic/browser/<x>.css (...)` entries inside an
 * existing jar.inc.mn body, and returns the maximum so a newly inserted
 * entry can align its source column to match.
 *
 * 2026-04-26 eval Finding 3: pre-fix `registerSharedCSS` always emitted
 * a four-space gap between the target path and the parenthesis,
 * regardless of how the rest of the file was aligned. Adjacent Firefox
 * entries are typically padded to a wider column, so a freshly
 * registered file landed at the wrong column and produced avoidable
 * formatting churn. Returns `undefined` when no existing entries
 * provide an alignment signal — callers fall back to the four-space
 * default in that case.
 */
export function measureSourceColumn(content: string): number | undefined {
  const lines = content.split('\n');
  let maxColumn = 0;
  let sampled = 0;
  // The regex guarantees `(` appears in the matched line, so the index
  // lookup below is always >= 0. The `match` body's leading-whitespace
  // and target-path captures are likewise guaranteed by the pattern, so
  // we can take the literal `match[0]` (full match) length minus one to
  // locate the `(` column without a fragile per-group lookup.
  const lineRe = /^\s*skin\/classic\/browser\/[^\s()]+\s+\(/;
  for (const line of lines) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const parenIndex = match[0].length - 1;
    if (parenIndex > maxColumn) maxColumn = parenIndex;
    sampled++;
  }
  return sampled > 0 ? maxColumn : undefined;
}

/**
 * Builds a `skin/classic/browser/<name>.css   (../shared/<name>.css)`
 * line padded so the parenthesis lands at {@link sourceColumn} (when
 * supplied) or at the default four-space gap (when {@link sourceColumn}
 * is `undefined` or would force the parenthesis closer to the target
 * than {@link MIN_SOURCE_GAP}).
 */
export function buildEntry(name: string, sourceColumn: number | undefined): string {
  const indent = '  ';
  const target = `${indent}skin/classic/browser/${name}.css`;
  const minColumn = target.length + MIN_SOURCE_GAP;
  const column = sourceColumn !== undefined && sourceColumn >= minColumn ? sourceColumn : minColumn;
  const padding = ' '.repeat(column - target.length);
  return `${target}${padding}(../shared/${name}.css)`.replace(/\\/g, '/');
}

/**
 * Registers a CSS file in browser/themes/shared/jar.inc.mn.
 *
 * Entry format:
 *   skin/classic/browser/{name}.css    (../shared/{name}.css)
 *
 * The gap between target and source is sized to align with adjacent
 * entries when the manifest already uses a wider column; falls back to
 * a four-space minimum otherwise.
 */
export async function registerSharedCSS(
  engineDir: string,
  fileName: string,
  after?: string,
  dryRun = false
): Promise<RegisterResult> {
  const manifest = 'browser/themes/shared/jar.inc.mn';
  const manifestPath = join(engineDir, manifest);

  if (!(await pathExists(manifestPath))) {
    throw new GeneralError(`Manifest not found: ${manifest}`);
  }

  const name = basename(fileName, '.css');
  const content = await readText(manifestPath);
  const sourceColumn = measureSourceColumn(content);
  const entry = buildEntry(name, sourceColumn);

  // Idempotency check. `furnace chrome-doc create` writes its CSS as a
  // `content/browser/<name>.css` entry rather than the canonical
  // `skin/classic/browser/<name>.css` form `register` produces; recognise
  // both shapes so a follow-up `register` invocation against an
  // already-chrome-doc-registered file reports `skipped` instead of
  // appending a duplicate `skin/classic/browser/...` row.
  if (
    content.includes(`skin/classic/browser/${name}.css`) ||
    content.includes(`content/browser/${name}.css`)
  ) {
    return { manifest, entry, skipped: true };
  }

  const { value } = withParserFallback(
    () => registerSharedCSSTokenized(content, name, entry, after),
    () => legacyRegisterSharedCSS(content, name, entry, after),
    manifest
  );

  if (!dryRun) {
    await writeText(manifestPath, value.result);
  }
  return {
    manifest,
    entry,
    previousEntry: value.previousEntry,
    skipped: false,
    afterFallback: value.afterFallback,
  };
}
