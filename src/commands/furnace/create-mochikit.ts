// SPDX-License-Identifier: EUPL-1.2
/**
 * MochiKit (chrome://mochikit) test-harness scaffolder for
 * `fireforge furnace create --test-style=mochikit`.
 *
 * Browser-chrome mochitests require a `tabbrowser` in the top-level chrome
 * document, so forks with a bespoke chrome document that deliberately omits
 * one cannot run them. MochiKit tests load the component module directly via
 * `chrome://global/` and assert against `customElements`, so they work
 * against any fork that registers the upstream toolkit test manifest tree —
 * including those without a tabbrowser.
 */

import { join } from 'node:path';

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
  generateMochikitChromeTomlEntry,
  generateMochikitChromeTomlSkeleton,
  generateMochikitTestContent,
  mochikitTestFileName,
} from './create-templates.js';

/**
 * Scaffolds a MochiKit test for a newly created custom component under
 * `engine/toolkit/content/tests/widgets/`. Mirrors the layout stock
 * Firefox widgets (moz-button, moz-toggle, etc.) use, so an operator who
 * already added the `widgets/` tree to their test-manifest registration
 * picks the new test up automatically.
 *
 * Appends a per-test entry to the existing `chrome.toml` when present,
 * writes a fresh `[DEFAULT]`-headed one otherwise. The caller is still
 * responsible for ensuring the `toolkit/content/tests/widgets/chrome.toml`
 * path is registered somewhere in the moz.build tree; most forks inherit
 * this from upstream via `TEST_HARNESS_FILES += [...]`.
 */
export async function scaffoldMochikitTestFiles(
  componentName: string,
  license: ProjectLicense,
  paths: { engine: string },
  journal?: RollbackJournal
): Promise<string[]> {
  const testDir = join(paths.engine, 'toolkit/content/tests/widgets');
  if (journal && !(await pathExists(testDir))) {
    recordCreatedDir(journal, testDir);
  }
  await ensureDir(testDir);

  const hashHeader = getLicenseHeader(license, 'hash');
  const writtenFiles: string[] = [];

  const testFileName = mochikitTestFileName(componentName);
  const testFilePath = join(testDir, testFileName);
  if (await pathExists(testFilePath)) {
    // Never clobber an existing test implementation, matching the
    // browser-chrome and xpcshell scaffolds.
    warn(
      `toolkit/content/tests/widgets/${testFileName} already exists — keeping the existing file.`
    );
  } else {
    if (journal) await snapshotFile(journal, testFilePath);
    await writeText(testFilePath, generateMochikitTestContent(componentName));
    writtenFiles.push(testFileName);
  }

  // chrome.toml — append entry if the file already exists, otherwise write
  // a fresh skeleton + entry. Idempotency: if the entry is already present
  // the manifest is left untouched so re-runs don't double-register.
  const manifestPath = join(testDir, 'chrome.toml');
  const entry = generateMochikitChromeTomlEntry(componentName);

  if (await pathExists(manifestPath)) {
    const existing = await readText(manifestPath);
    if (!existing.includes(`["${testFileName}"]`)) {
      if (journal) await snapshotFile(journal, manifestPath);
      await writeText(manifestPath, existing.trimEnd() + '\n\n' + entry);
    }
  } else {
    if (journal) await snapshotFile(journal, manifestPath);
    await writeText(manifestPath, generateMochikitChromeTomlSkeleton(hashHeader) + entry);
    writtenFiles.push('chrome.toml');
  }

  warn(
    `MochiKit scaffold written under toolkit/content/tests/widgets/. ` +
      'Ensure `toolkit/content/tests/widgets/chrome.toml` is reachable from an existing test-harness registration (upstream TEST_HARNESS_FILES entries handle this by default).'
  );

  return writtenFiles;
}
