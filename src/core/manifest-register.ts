// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest registration barrel — re-exports all registration targets
 * and provides the shared RegisterResult interface.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { findAlphabeticalPosition } from './manifest-helpers.js';

/**
 * Result of a manifest registration operation.
 */
export interface RegisterResult {
  /** The manifest file that was modified */
  manifest: string;
  /** The entry that was inserted */
  entry: string;
  /** The entry after which the new entry was inserted (for user display) */
  previousEntry?: string | undefined;
  /** Whether the entry already existed (skipped) */
  skipped: boolean;
  /** Whether --after target was not found and fell back to alphabetical */
  afterFallback?: boolean | undefined;
}

// Re-export from split modules so existing import sites continue working
export { registerBrowserContent } from './register-browser-content.js';
export { registerFireForgeModule } from './register-module.js';
export { registerSharedCSS } from './register-shared-css.js';
export { deregisterTestManifest, registerTestManifest } from './register-test-manifest.js';

// ---------------------------------------------------------------------------
// toolkit/content/jar.mn — widget registration
// ---------------------------------------------------------------------------

/**
 * Registers a widget file (mjs or css) in toolkit/content/jar.mn.
 *
 * Entry format (3-space indent):
 *    content/global/elements/{file}  (widgets/{tagName}/{file})
 */
export async function registerToolkitWidget(
  engineDir: string,
  tagName: string,
  fileName: string,
  dryRun = false
): Promise<RegisterResult> {
  const manifest = 'toolkit/content/jar.mn';
  const manifestPath = join(engineDir, manifest);

  if (!(await pathExists(manifestPath))) {
    throw new GeneralError(`Manifest not found: ${manifest}`);
  }

  const entry = `   content/global/elements/${fileName}  (widgets/${tagName}/${fileName})`.replace(
    /\\/g,
    '/'
  );

  let content = await readText(manifestPath);

  // Idempotency check
  if (content.includes(`content/global/elements/${fileName}`)) {
    return { manifest, entry, skipped: true };
  }

  const lines = content.split('\n');

  // Find insertion point among existing content/global/elements/ lines
  const extractKey = (line: string): string | undefined => {
    const match = /^\s+content\/global\/elements\/([^\s]+)/.exec(line);
    return match?.[1];
  };

  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^\s+content\/global\/elements\//.test(line)) {
      if (sectionStart === -1) sectionStart = i;
      sectionEnd = i + 1;
    }
  }

  if (sectionStart === -1) {
    throw new GeneralError(
      'Could not find content/global/elements/ section in toolkit/content/jar.mn'
    );
  }

  const { insertIndex, previousEntry } = findAlphabeticalPosition(
    lines,
    sectionStart,
    sectionEnd,
    fileName,
    extractKey
  );

  lines.splice(insertIndex, 0, entry);
  content = lines.join('\n');
  if (!dryRun) {
    await writeText(manifestPath, content);
  }

  return { manifest, entry, previousEntry, skipped: false };
}
