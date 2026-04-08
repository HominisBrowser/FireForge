// SPDX-License-Identifier: EUPL-1.2
/**
 * JS/content registration in browser/base/jar.mn.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { findAlphabeticalPosition, findAlphabeticalTokenPosition } from './manifest-helpers.js';
import type { RegisterResult } from './manifest-register.js';
import { tokenizeJarMn } from './manifest-tokenizers.js';
import { withParserFallback } from './parser-fallback.js';

/**
 * Tokenizer-based implementation for browser content registration.
 */
function registerBrowserContentTokenized(
  content: string,
  fileName: string,
  entry: string,
  after?: string
): { result: string; previousEntry: string | undefined; afterFallback: boolean } {
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
        /content\/browser\/([^\s]+)/,
        fileName
      ));
    }
  } else {
    ({ insertIndex, previousEntry } = findAlphabeticalTokenPosition(
      tokens,
      /content\/browser\/([^\s]+)/,
      fileName
    ));
  }

  if (insertIndex === -1) {
    throw new GeneralError('Could not find content/browser/ section in browser/base/jar.mn');
  }

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), previousEntry, afterFallback };
}

/**
 * Legacy line-based implementation preserved as fallback.
 */
function legacyRegisterBrowserContent(
  content: string,
  fileName: string,
  entry: string,
  after?: string
): { result: string; previousEntry: string | undefined; afterFallback: boolean } {
  const lines = content.split('\n');
  let afterFallback = false;

  const extractKey = (line: string): string | undefined => {
    const match = /content\/browser\/([^\s]+)/.exec(line);
    return match?.[1];
  };

  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^\s+content\/browser\//.test(line)) {
      if (sectionStart === -1) sectionStart = i;
      sectionEnd = i + 1;
    }
  }

  if (sectionStart === -1) {
    throw new GeneralError('Could not find content/browser/ section in browser/base/jar.mn');
  }

  let insertIndex: number;
  let previousEntry: string | undefined;

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
        fileName,
        extractKey
      ));
    }
  } else {
    ({ insertIndex, previousEntry } = findAlphabeticalPosition(
      lines,
      sectionStart,
      sectionEnd,
      fileName,
      extractKey
    ));
  }

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), previousEntry, afterFallback };
}

/**
 * Registers a JS/content file in browser/base/jar.mn.
 *
 * Entry format (8-space indent):
 *         content/browser/{name}.js    (content/{name}.js)
 */
export async function registerBrowserContent(
  engineDir: string,
  fileName: string,
  after?: string,
  sourcePath?: string,
  dryRun = false
): Promise<RegisterResult> {
  const manifest = 'browser/base/jar.mn';
  const manifestPath = join(engineDir, manifest);

  if (!(await pathExists(manifestPath))) {
    throw new GeneralError(`Manifest not found: ${manifest}`);
  }

  const source = (sourcePath ?? `content/${fileName}`).replace(/\\/g, '/');
  const entry = `        content/browser/${fileName}    (${source})`.replace(/\\/g, '/');

  const content = await readText(manifestPath);

  // Idempotency check
  if (content.includes(`content/browser/${fileName}`)) {
    return { manifest, entry, skipped: true };
  }

  const { value } = withParserFallback(
    () => registerBrowserContentTokenized(content, fileName, entry, after),
    () => legacyRegisterBrowserContent(content, fileName, entry, after),
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
