// SPDX-License-Identifier: EUPL-1.2
/**
 * Test manifest registration in browser/base/moz.build.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { insertMozBuildListEntry } from './moz-manifest-helpers.js';
import type { RegisterResult } from './register-result.js';

/**
 * Tokenizer-based implementation for test manifest registration.
 */
function registerTestManifestTokenized(
  content: string,
  testDir: string,
  entry: string
): { result: string; previousEntry: string | undefined } {
  return insertMozBuildListEntry(content, entry, {
    listPattern: /BROWSER_CHROME_MANIFESTS/,
    sortKey: `content/test/${testDir}/browser.toml`,
    missingListMessage: 'Could not find BROWSER_CHROME_MANIFESTS in browser/base/moz.build',
  });
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

  const entry = normalizePathSlashes(`    "content/test/${testDir}/browser.toml",`);

  const content = await readText(manifestPath);

  // Idempotency check
  if (content.includes(`content/test/${testDir}/browser.toml`)) {
    return { manifest, entry, skipped: true };
  }

  const value = registerTestManifestTokenized(content, testDir, entry);

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
