// SPDX-License-Identifier: EUPL-1.2
/**
 * xpcshell test-harness scaffolder for `fireforge furnace create --xpcshell`.
 * Extracted from `create.ts` so the command entrypoint stays under the
 * per-file LOC budget and the scaffolder is unit-testable in isolation.
 */

import { join } from 'node:path';

import {
  recordCreatedDir,
  type RollbackJournal,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { getLicenseHeader } from '../../core/license-headers.js';
import type { ProjectLicense } from '../../types/config.js';
import { ensureDir, pathExists, writeText } from '../../utils/fs.js';
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
 * Writes `test_<name>_module_loads.js` and an `xpcshell.toml` manifest
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
  journal?: RollbackJournal
): Promise<string[]> {
  const parentDirName = `${forgeConfig.binaryName}-xpcshell`;
  const testDir = join(paths.engine, 'browser/base/content/test', parentDirName, componentName);
  if (journal && !(await pathExists(testDir))) {
    recordCreatedDir(journal, testDir);
  }
  await ensureDir(testDir);

  const jsHeader = getLicenseHeader(license, 'js');
  const hashHeader = getLicenseHeader(license, 'hash');
  const testFiles: string[] = [];

  const testFileName = xpcshellTestFileName(componentName);
  const testFilePath = join(testDir, testFileName);
  if (journal) await snapshotFile(journal, testFilePath);
  await writeText(testFilePath, generateXpcshellTestContent(componentName, jsHeader));
  testFiles.push(testFileName);

  const manifestPath = join(testDir, 'xpcshell.toml');
  if (journal) await snapshotFile(journal, manifestPath);
  await writeText(manifestPath, generateXpcshellManifestContent(componentName, hashHeader));
  testFiles.push('xpcshell.toml');

  warn(
    `xpcshell scaffold written under browser/base/content/test/${parentDirName}/${componentName}/. ` +
      'Add the directory to XPCSHELL_TESTS_MANIFESTS in the nearest moz.build to run it via "fireforge test".'
  );

  return testFiles;
}
