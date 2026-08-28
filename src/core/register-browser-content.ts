// SPDX-License-Identifier: EUPL-1.2
/**
 * JS/content registration in browser/base/jar.mn.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { insertJarMnEntry } from './moz-manifest-helpers.js';
import type { RegisterResult } from './register-result.js';

/**
 * Tokenizer-based implementation for browser content registration.
 */
function registerBrowserContentTokenized(
  content: string,
  fileName: string,
  entry: string,
  after?: string
): { result: string; previousEntry: string | undefined; afterFallback: boolean } {
  const { result, previousEntry, afterFallback } = insertJarMnEntry(content, entry, {
    sortPattern: /content\/browser\/([^\s]+)/,
    sortKey: fileName,
    missingSectionMessage: 'Could not find content/browser/ section in browser/base/jar.mn',
    after,
  });
  return { result, previousEntry, afterFallback };
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

  const value = registerBrowserContentTokenized(content, fileName, entry, after);

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
