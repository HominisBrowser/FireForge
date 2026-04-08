// SPDX-License-Identifier: EUPL-1.2
/**
 * CSS registration in browser/themes/shared/jar.inc.mn.
 */

import { basename, join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { findAlphabeticalPosition, findAlphabeticalTokenPosition } from './manifest-helpers.js';
import type { RegisterResult } from './manifest-register.js';
import { tokenizeJarMn } from './manifest-tokenizers.js';
import { withParserFallback } from './parser-fallback.js';

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
    const afterPattern = new RegExp(
      `(?:^|/)${after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|\\)|$)`
    );
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

/**
 * Registers a CSS file in browser/themes/shared/jar.inc.mn.
 *
 * Entry format:
 *   skin/classic/browser/{name}.css    (../shared/{name}.css)
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
  const entry = `  skin/classic/browser/${name}.css    (../shared/${name}.css)`.replace(/\\/g, '/');

  const content = await readText(manifestPath);

  // Idempotency check
  if (content.includes(`skin/classic/browser/${name}.css`)) {
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
