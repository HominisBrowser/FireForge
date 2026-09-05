// SPDX-License-Identifier: EUPL-1.2
/**
 * xpcshell test-file registration. Without it, xpcshell test files (e.g.
 * `<module-dir>/test/unit/test_*.js`) are rejected by `fireforge register`
 * as "Unknown file pattern". This writer inserts the `["test_*.js"]` section
 * into the directory's `xpcshell.toml` (alphabetically, idempotently). With
 * `--create-manifest` it also creates the manifest and wires
 * `XPCSHELL_TESTS_MANIFESTS` into the nearest moz.build.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { mozbuildSortCompare } from './moz-manifest-helpers.js';
import type { RegisterResult } from './register-result.js';
import { ensureXpcshellManifestWiring, type ScaffoldAction } from './register-scaffold.js';

function manifestMissingError(manifestRel: string): GeneralError {
  return new GeneralError(
    `Manifest not found: ${manifestRel}. ` +
      'Pass --create-manifest to scaffold the xpcshell.toml and wire XPCSHELL_TESTS_MANIFESTS ' +
      'into the nearest moz.build.'
  );
}

/**
 * Checks whether the test file is listed in its directory's
 * `xpcshell.toml`. Throws a "Manifest not found" error when the manifest
 * does not exist (status catches that prefix and reports the manifest as
 * missing rather than the file as unregistered).
 */
export async function isXpcshellTestRegistered(
  engineDir: string,
  dirRel: string,
  fileName: string
): Promise<boolean> {
  const manifestRel = `${dirRel}/xpcshell.toml`;
  const manifestPath = join(engineDir, manifestRel);
  if (!(await pathExists(manifestPath))) {
    throw manifestMissingError(manifestRel);
  }
  const content = await readText(manifestPath);
  return content.includes(`["${fileName}"]`);
}

/**
 * Inserts the `["<fileName>"]` section into the manifest content in
 * mozbuild's case-insensitive sort order relative to the other test
 * sections, keeping one blank line between sections. Exported for direct
 * unit testing.
 */
export function insertXpcshellManifestSection(content: string, fileName: string): string {
  const lines = content.split('\n');
  const sectionHeaderPattern = /^\["([^"]+)"\]\s*$/;

  let insertIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = sectionHeaderPattern.exec(lines[i] ?? '');
    if (!match) continue;
    if (insertIndex === -1 && mozbuildSortCompare(fileName, match[1] ?? '') < 0) {
      insertIndex = i;
    }
  }

  if (insertIndex !== -1) {
    lines.splice(insertIndex, 0, `["${fileName}"]`, '');
    return lines.join('\n');
  }

  // Append after the last section (or at end of file when there are no
  // sections yet), keeping exactly one trailing newline.
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  return [...lines, '', `["${fileName}"]`, ''].join('\n');
}

/**
 * Registers an xpcshell test file in its directory's `xpcshell.toml`.
 * With `createManifest`, a missing manifest is scaffolded and wired into
 * the nearest moz.build via `XPCSHELL_TESTS_MANIFESTS`.
 */
export async function registerXpcshellTest(
  engineDir: string,
  dirRel: string,
  fileName: string,
  dryRun = false,
  createManifest = false
): Promise<RegisterResult> {
  const manifestRel = `${dirRel}/xpcshell.toml`;
  const manifestPath = join(engineDir, manifestRel);
  const entry = `["${fileName}"]`;

  if (!(await pathExists(manifestPath))) {
    if (!createManifest) {
      throw manifestMissingError(manifestRel);
    }
    const scaffoldActions: ScaffoldAction[] = [
      { manifest: manifestRel, change: `created with ${entry}` },
    ];
    if (!dryRun) {
      await writeText(manifestPath, `[DEFAULT]\n\n${entry}\n`);
    }
    scaffoldActions.push(...(await ensureXpcshellManifestWiring(engineDir, manifestRel, dryRun)));
    return { manifest: manifestRel, entry, skipped: false, scaffoldActions };
  }

  const content = await readText(manifestPath);
  if (content.includes(entry)) {
    return { manifest: manifestRel, entry, skipped: true };
  }

  const updated = insertXpcshellManifestSection(content, fileName);
  if (!dryRun) {
    await writeText(manifestPath, updated);
  }
  return { manifest: manifestRel, entry, skipped: false };
}
