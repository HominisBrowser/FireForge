// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest registration barrel. Re-exports all registration targets
 * and the shared RegisterResult interface (which lives in
 * `register-result.ts` so the leaf modules can import it without
 * creating a cycle through this barrel).
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { insertJarMnEntry } from './moz-manifest-helpers.js';
import type { RegisterResult } from './register-result.js';

export type { RegisterResult } from './register-result.js';

// Re-export from split modules so existing import sites continue working
export { registerBrowserContent } from './register-browser-content.js';
export { deregisterTestManifest, registerTestManifest } from './register-browser-test.js';
export { registerFireForgeModule } from './register-module.js';
export { registerSharedCSS } from './register-shared-css.js';

// ---------------------------------------------------------------------------
// toolkit/content/jar.mn: widget registration
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

  const content = await readText(manifestPath);

  // Idempotency check
  if (content.includes(`content/global/elements/${fileName}`)) {
    return { manifest, entry, skipped: true };
  }

  // Tokenized like the other three jar.mn registrars. The hand-rolled
  // line scan this replaced re-derived the section bounds and the sort
  // key with its own regexes, so it was the one jar.mn target that did
  // not inherit fixes made to the shared path.
  const { result, previousEntry } = insertJarMnEntry(content, entry, {
    sortPattern: /content\/global\/elements\/([^\s]+)/,
    sortKey: fileName,
    missingSectionMessage:
      'Could not find content/global/elements/ section in toolkit/content/jar.mn',
  });

  if (!dryRun) {
    await writeText(manifestPath, result);
  }

  return { manifest, entry, previousEntry, skipped: false };
}
