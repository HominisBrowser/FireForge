// SPDX-License-Identifier: EUPL-1.2
/**
 * Browser-chrome test scaffolding for `furnace create --with-tests`,
 * including the `--test-dir` redirect and collision safety (existing
 * manifests are appended to; head.js and test implementations are never
 * overwritten). Split out of `create.ts` to keep that command file within
 * the per-file line budget.
 */

import { join } from 'node:path';

import {
  BROWSER_TEST_SCAFFOLD_ROOT,
  resolveBrowserChromeTestDir,
} from '../../core/furnace-constants.js';
import {
  recordCreatedDir,
  type RollbackJournal,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { getLicenseHeader } from '../../core/license-headers.js';
import { registerTestManifest } from '../../core/moz-manifest-register.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type { ProjectLicense } from '../../types/config.js';
import type { ResolvedTestStyle } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { ensureDir, pathExists, readText, writeText } from '../../utils/fs.js';
import { info, success, warn } from '../../utils/logger.js';
import { stripEnginePrefix } from '../../utils/paths.js';
import { browserTestFileName, deriveTestStem } from './test-file-name.js';

/**
 * Validates the `--test-dir` option against the resolved test style before
 * any writes. Mochikit lives in the upstream toolkit/content/tests/widgets
 * tree, so a redirect makes no sense there.
 */
export function resolveValidatedTestDir(
  rawTestDir: string | undefined,
  testStyle: ResolvedTestStyle
): string | undefined {
  if (rawTestDir === undefined) return undefined;
  if (testStyle === 'none') {
    throw new InvalidArgumentError('--test-dir requires --with-tests / --test-style.', 'testDir');
  }
  if (testStyle === 'mochikit') {
    throw new InvalidArgumentError(
      '--test-dir is not supported with --test-style=mochikit (the mochikit harness lives in toolkit/content/tests/widgets).',
      'testDir'
    );
  }
  return resolveTestDirOverride(rawTestDir);
}

/**
 * Scaffolds browser mochitest files for a newly created custom component.
 * @param componentName - Custom element tag name
 * @param license - Project license used for generated headers
 * @param forgeConfig - Project config fields needed for test naming
 * @param paths - Resolved project paths used to place test files
 * @param journal - Optional rollback journal that snapshots files before writes
 * @returns Relative test filenames created or updated for the component
 */
/**
 * Normalizes and validates a `--test-dir` override: engine-relative,
 * under `browser/base/content/test/` (so manifest registration keeps
 * working). Returns the normalized engine-relative directory.
 */
export function resolveTestDirOverride(raw: string): string {
  const normalized = stripEnginePrefix(raw).replace(/\/+$/, '');
  if (
    !normalized.startsWith(BROWSER_TEST_SCAFFOLD_ROOT) ||
    normalized === BROWSER_TEST_SCAFFOLD_ROOT.slice(0, -1)
  ) {
    throw new InvalidArgumentError(
      `--test-dir must be an engine-relative directory under ${BROWSER_TEST_SCAFFOLD_ROOT} (got "${raw}").`,
      'testDir'
    );
  }
  return normalized;
}

// Exported for direct unit testing of the --test-dir / collision-safety
// behaviour (the full create command needs a furnace project fixture).
/**
 * Writes the browser-mochitest scaffold for a component: the test file, its
 * `browser.toml` manifest entry, and the parent `moz.build` registration.
 *
 * Every write is recorded in `journal` when one is supplied, so a failure
 * partway through is rolled back rather than leaving a half-registered test
 * the harness will try to run.
 */
export async function scaffoldTestFiles(
  componentName: string,
  license: ProjectLicense,
  forgeConfig: { binaryName: string },
  paths: { engine: string },
  journal?: RollbackJournal,
  testDirOverride?: string
): Promise<string[]> {
  const binaryName = forgeConfig.binaryName;
  const underscored = deriveTestStem(componentName, binaryName);
  const testFileName = browserTestFileName(componentName, binaryName);
  // --test-dir redirects the scaffold: the hardcoded
  // `.../test/<binaryName>/` target can collide with a test suite owned by a
  // different patch. The manifest-registration name is the path below
  // browser/base/content/test/ (nested manifests are supported).
  const testDirRel = resolveBrowserChromeTestDir(binaryName, testDirOverride);
  const testDirName = testDirRel.slice(BROWSER_TEST_SCAFFOLD_ROOT.length);
  const testDir = join(paths.engine, testDirRel);
  if (journal && !(await pathExists(testDir))) {
    recordCreatedDir(journal, testDir);
  }
  await ensureDir(testDir);

  const jsHeader = getLicenseHeader(license, 'js');
  const hashHeader = getLicenseHeader(license, 'hash');
  const testFiles: string[] = [];

  // browser.toml — create if missing, append entry if existing
  const tomlPath = join(testDir, 'browser.toml');
  if (await pathExists(tomlPath)) {
    // Defensive guard: only append if the entry is not already present.
    // With a fresh journal per create, the same test file name cannot be
    // appended twice in a single run — but retaining the check protects
    // against accidental re-entrance or a future refactor that reuses the
    // helper with a stale test directory.
    const existingToml = await readText(tomlPath);
    if (!existingToml.includes(`["${testFileName}"]`)) {
      if (journal) await snapshotFile(journal, tomlPath);
      await writeText(tomlPath, existingToml.trimEnd() + `\n\n["${testFileName}"]\n`);
      info(
        `Appended ["${testFileName}"] to the existing ${testDirRel}/browser.toml — the manifest ` +
          'is shared; existing entries and support-files were left untouched.'
      );
    }
  } else {
    if (journal) await snapshotFile(journal, tomlPath);
    const browserToml = `${hashHeader}

[DEFAULT]
support-files = ["head.js"]

["${testFileName}"]
`;
    await writeText(tomlPath, browserToml);
  }
  testFiles.push('browser.toml');

  // head.js — only create if it doesn't exist (shared across components)
  const headPath = join(testDir, 'head.js');
  if (!(await pathExists(headPath))) {
    if (journal) await snapshotFile(journal, headPath);
    const headJs = `${jsHeader}

"use strict";

/**
 * Wait for a custom element to be defined.
 * @param {string} tag - Custom element tag name
 * @returns {Promise<CustomElementConstructor>}
 */
async function waitForElement(tag) {
  document.createElement(tag);
  return customElements.whenDefined(tag);
}
`;
    await writeText(headPath, headJs);
    testFiles.push('head.js');
  }

  // browser_{binaryName}_{stripped}.js
  const testJs = `${jsHeader}

"use strict";

add_task(async function test_${underscored}_defined() {
  const ctor = await waitForElement("${componentName}");
  Assert.ok(ctor, "${componentName} custom element should be defined");
  Assert.equal(typeof ctor, "function", "Constructor should be a function");
});
`;
  const testFilePath = join(testDir, testFileName);
  if (await pathExists(testFilePath)) {
    // Never clobber an existing test implementation (it may be owned by a
    // different patch). The manifest entry above is idempotent, so the
    // existing file simply stays authoritative.
    warn(
      `${testDirRel}/${testFileName} already exists — keeping the existing file. ` +
        'Pass --test-dir to scaffold into a different directory if you wanted a fresh test.'
    );
  } else {
    if (journal) await snapshotFile(journal, testFilePath);
    await writeText(testFilePath, testJs);
    testFiles.push(testFileName);
  }

  // Register in moz.build. The registration helper edits browser/base/moz.build,
  // so snapshot it first when a journal is supplied. The existing warn-and-continue
  // contract is preserved so a missing/unparseable moz.build never trips rollback.
  try {
    const mozBuildPath = join(paths.engine, 'browser/base/moz.build');
    if (journal) await snapshotFile(journal, mozBuildPath);
    const registerResult = await registerTestManifest(paths.engine, testDirName);
    if (!registerResult.skipped) {
      success(`Registered test manifest in ${registerResult.manifest}`);
    }
  } catch (error: unknown) {
    warn(
      `Could not register test manifest in moz.build — ${toError(error).message}. Register manually with "fireforge register".`
    );
  }

  return testFiles;
}
