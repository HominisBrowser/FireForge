// SPDX-License-Identifier: EUPL-1.2
/**
 * Test manifest registration in browser/base/moz.build.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { findAlphabeticalMozBuildPosition, findAlphabeticalPosition } from './manifest-helpers.js';
import type { RegisterResult } from './manifest-register.js';
import { tokenizeMozBuildList } from './manifest-tokenizers.js';
import { withParserFallback } from './parser-fallback.js';

/**
 * Tokenizer-based implementation for test manifest registration.
 */
function registerTestManifestTokenized(
  content: string,
  testDir: string,
  entry: string
): { result: string; previousEntry: string | undefined } {
  const lines = content.split('\n');
  const listResult = tokenizeMozBuildList(lines, /BROWSER_CHROME_MANIFESTS/);

  if (!listResult) {
    throw new GeneralError('Could not find BROWSER_CHROME_MANIFESTS in browser/base/moz.build');
  }

  const { insertIndex, previousEntry } = findAlphabeticalMozBuildPosition(
    listResult.tokens,
    `content/test/${testDir}/browser.toml`
  );

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), previousEntry };
}

/**
 * Legacy line-based implementation preserved as fallback.
 */
function legacyRegisterTestManifest(
  content: string,
  testDir: string,
  entry: string
): { result: string; previousEntry: string | undefined } {
  const lines = content.split('\n');

  const extractKey = (line: string): string | undefined => {
    const match = /"content\/test\/([^/]+)\/browser\.toml"/.exec(line);
    return match?.[1];
  };

  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^\s+"content\/test\/.*browser\.toml"/.test(line)) {
      if (sectionStart === -1) sectionStart = i;
      sectionEnd = i + 1;
    }
  }

  if (sectionStart === -1) {
    throw new GeneralError('Could not find test manifest section in browser/base/moz.build');
  }

  const { insertIndex, previousEntry } = findAlphabeticalPosition(
    lines,
    sectionStart,
    sectionEnd,
    testDir,
    extractKey
  );

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), previousEntry };
}

/**
 * Registers a test manifest (browser.toml) in browser/base/moz.build.
 *
 * Entry format:
 *     "content/test/{dir}/browser.toml",
 */
export async function registerTestManifest(
  engineDir: string,
  testDir: string,
  dryRun = false
): Promise<RegisterResult> {
  const manifest = 'browser/base/moz.build';
  const manifestPath = join(engineDir, manifest);

  if (!(await pathExists(manifestPath))) {
    throw new GeneralError(`Manifest not found: ${manifest}`);
  }

  const entry = `    "content/test/${testDir}/browser.toml",`.replace(/\\/g, '/');

  const content = await readText(manifestPath);

  // Idempotency check
  if (content.includes(`content/test/${testDir}/browser.toml`)) {
    return { manifest, entry, skipped: true };
  }

  const { value } = withParserFallback(
    () => registerTestManifestTokenized(content, testDir, entry),
    () => legacyRegisterTestManifest(content, testDir, entry),
    manifest
  );

  if (!dryRun) {
    await writeText(manifestPath, value.result);
  }
  return { manifest, entry, previousEntry: value.previousEntry, skipped: false };
}

/**
 * Deregisters a test manifest (browser.toml) from browser/base/moz.build.
 * @param engineDir - Path to the engine directory
 * @param testDir - Test directory name (e.g. 'mybrowser')
 * @returns Whether the entry was removed
 */
export async function deregisterTestManifest(engineDir: string, testDir: string): Promise<boolean> {
  const manifest = 'browser/base/moz.build';
  const manifestPath = join(engineDir, manifest);

  if (!(await pathExists(manifestPath))) {
    return false;
  }

  const content = await readText(manifestPath);
  const entryPattern = `content/test/${testDir}/browser.toml`;

  if (!content.includes(entryPattern)) {
    return false;
  }

  // Remove the line containing the entry (including trailing newline)
  const lines = content.split('\n');
  const filtered = lines.filter((line) => !line.includes(entryPattern));
  await writeText(manifestPath, filtered.join('\n'));
  return true;
}
