// SPDX-License-Identifier: EUPL-1.2
/**
 * Module registration in browser/modules/{binaryName}/moz.build.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { insertMozBuildListEntry } from './moz-manifest-helpers.js';
import type { RegisterResult } from './register-result.js';
import { scaffoldModuleMozBuild } from './register-scaffold.js';

/**
 * Tokenizer-based implementation for module registration.
 */
function registerFireForgeModuleTokenized(
  content: string,
  fileName: string,
  entry: string
): { result: string; previousEntry: string | undefined } {
  return insertMozBuildListEntry(content, entry, {
    listPattern: /EXTRA_JS_MODULES/,
    sortKey: fileName,
    missingListMessage: 'Could not find EXTRA_JS_MODULES in moz.build',
  });
}

/**
 * Registers a module in browser/modules/{binaryName}/moz.build.
 *
 * Entry format:
 *     "{name}.sys.mjs",
 */
export async function registerFireForgeModule(
  engineDir: string,
  fileName: string,
  moduleDir: string,
  dryRun = false,
  createManifest = false
): Promise<RegisterResult> {
  const manifest = `${moduleDir}/moz.build`;
  const manifestPath = join(engineDir, manifest);

  if (!(await pathExists(manifestPath))) {
    if (createManifest) {
      // Registering a module under a directory with no moz.build otherwise
      // fails with "Manifest not found". Scaffold the directory manifest and
      // wire the parent DIRS chain.
      const scaffoldActions = await scaffoldModuleMozBuild(engineDir, moduleDir, fileName, dryRun);
      return {
        manifest,
        entry: `    "${fileName}",`,
        skipped: false,
        scaffoldActions,
      };
    }
    throw new GeneralError(
      `Manifest not found: ${manifest}. Pass --create-manifest to scaffold it and wire the parent DIRS entry.`
    );
  }

  const entry = normalizePathSlashes(`    "${fileName}",`);

  const content = await readText(manifestPath);

  // Idempotency check
  if (content.includes(`"${fileName}"`)) {
    return { manifest, entry, skipped: true };
  }

  const value = registerFireForgeModuleTokenized(content, fileName, entry);

  if (!dryRun) {
    await writeText(manifestPath, value.result);
  }
  return { manifest, entry, previousEntry: value.previousEntry, skipped: false };
}
