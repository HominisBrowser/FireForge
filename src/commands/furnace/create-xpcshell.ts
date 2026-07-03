// SPDX-License-Identifier: EUPL-1.2
/**
 * xpcshell test-harness scaffolder for `fireforge furnace create --xpcshell`.
 * Extracted from `create.ts` so the command entrypoint stays under the
 * per-file LOC budget and the scaffolder is unit-testable in isolation.
 */

import { join } from 'node:path';

import { xpcshellTestParentDir } from '../../core/furnace-constants.js';
import {
  recordCreatedDir,
  type RollbackJournal,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { getLicenseHeader } from '../../core/license-headers.js';
import type { ProjectLicense } from '../../types/config.js';
import { ensureDir, pathExists, readText, writeText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import {
  generateXpcshellManifestContent,
  generateXpcshellTestContent,
  xpcshellTestFileName,
} from './create-templates.js';

/**
 * Scaffolds an xpcshell test harness for a newly created custom component.
 *
 * xpcshell is the appropriate harness for storage-layer code on forks
 * without a `tabbrowser` (no `openLinkIn` → `URILoadingHelper`). Browser
 * chrome mochitests require tabbrowser; xpcshell does not, so storage,
 * observers, and ESM-loading logic can be covered headless.
 *
 * Writes `test_<name>_packaged.js` and an `xpcshell.toml` manifest
 * into `engine/browser/base/content/test/<binary-name>-xpcshell/
 * <component-name>/`. moz.build registration is intentionally left to the
 * operator — wiring an `XPCSHELL_TESTS_MANIFESTS` entry requires a
 * deliberate choice about which moz.build should own it, and an
 * auto-insertion that guessed wrong would be worse than a note.
 */
export async function scaffoldXpcshellTestFiles(
  componentName: string,
  license: ProjectLicense,
  forgeConfig: { binaryName: string },
  paths: { engine: string },
  journal?: RollbackJournal,
  testDirOverride?: string
): Promise<string[]> {
  const parentRelDir = xpcshellTestParentDir(forgeConfig.binaryName);
  const parentDirName =
    parentRelDir.split('/').slice(-1)[0] ?? `${forgeConfig.binaryName}-xpcshell`;
  // --test-dir names the FINAL directory (no per-component segment is
  // appended) so the operator controls the exact scaffold target.
  const testDirRel = testDirOverride ?? `${parentRelDir}/${componentName}`;
  const testDir = join(paths.engine, testDirRel);
  if (journal && !(await pathExists(testDir))) {
    recordCreatedDir(journal, testDir);
  }
  await ensureDir(testDir);

  const jsHeader = getLicenseHeader(license, 'js');
  const hashHeader = getLicenseHeader(license, 'hash');
  const testFiles: string[] = [];

  const testFileName = xpcshellTestFileName(componentName);
  const testFilePath = join(testDir, testFileName);
  if (await pathExists(testFilePath)) {
    // Never clobber an existing test implementation (0.34.0 field report:
    // the scaffold overwrote files owned by a different patch).
    warn(`${testDirRel}/${testFileName} already exists — keeping the existing file.`);
  } else {
    if (journal) await snapshotFile(journal, testFilePath);
    await writeText(testFilePath, generateXpcshellTestContent(componentName, jsHeader));
    testFiles.push(testFileName);
  }

  // xpcshell.toml — append the test entry to an existing manifest instead
  // of scaffolding over it; write a fresh one only when absent.
  const manifestPath = join(testDir, 'xpcshell.toml');
  if (await pathExists(manifestPath)) {
    const existing = await readText(manifestPath);
    if (!existing.includes(`["${testFileName}"]`)) {
      if (journal) await snapshotFile(journal, manifestPath);
      await writeText(manifestPath, existing.trimEnd() + `\n\n["${testFileName}"]\n`);
      warn(
        `Appended ["${testFileName}"] to the existing ${testDirRel}/xpcshell.toml — the manifest is shared; existing entries were left untouched.`
      );
    }
  } else {
    if (journal) await snapshotFile(journal, manifestPath);
    await writeText(manifestPath, generateXpcshellManifestContent(componentName, hashHeader));
    testFiles.push('xpcshell.toml');
  }

  warn(
    `xpcshell scaffold written under ${testDirRel}/ ` +
      '(default: browser/base/content/test/' +
      parentDirName +
      '/<component>/). ' +
      'Add the directory to XPCSHELL_TESTS_MANIFESTS in the nearest moz.build to run it via "fireforge test".'
  );

  return testFiles;
}
