// SPDX-License-Identifier: EUPL-1.2
/**
 * CSS registration in browser/themes/shared/jar.inc.mn.
 */

import { basename, join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { insertJarMnEntry } from './moz-manifest-helpers.js';
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
  return insertJarMnEntry(content, entry, {
    sortPattern: /skin\/classic\/browser\/([^.]+)\.css/,
    sortKey: name,
    missingSectionMessage: 'Could not find skin/classic/browser/ section in jar.inc.mn',
    after,
  });
}

/** Minimum gap between the target path and the source parenthesis. */
const MIN_SOURCE_GAP = 4;

/**
 * Measures the column at which the `(source)` parenthesis opens in adjacent
 * `skin/classic/browser/<x>.css (...)` entries inside an existing
 * jar.inc.mn body, and returns the maximum so a newly inserted entry can
 * align its source column to match.
 *
 * A fixed four-space gap regardless of the surrounding alignment lands a
 * freshly registered file at the wrong column and produces avoidable
 * formatting churn, since adjacent Firefox entries are typically padded to a
 * wider column. Returns `undefined` when no existing entries provide an
 * alignment signal — callers fall back to the four-space default.
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

  const value = registerSharedCSSTokenized(content, name, entry, after);

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
