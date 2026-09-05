// SPDX-License-Identifier: EUPL-1.2
/*
 * Dry-run plan formatter for `furnace create`.
 *
 * Lives outside `create.ts` so the authoring command stays under the
 * per-file LOC budget. The formatter is pure (all inputs are already
 * resolved by the command's validation phase), so it can be exercised
 * independently of the mutation plumbing.
 */

import {
  BROWSER_TEST_SCAFFOLD_ROOT,
  resolveBrowserChromeTestDir,
  resolveXpcshellTestDir,
} from '../../core/furnace-constants.js';
import type { ResolvedTestStyle } from '../../types/furnace.js';
import { deriveTestStem } from './test-file-name.js';

export interface DryRunPlanInput {
  componentName: string;
  localized: boolean;
  register: boolean;
  composes: string[] | undefined;
  stockAdditions?: string[];
  /**
   * Feature-scoped Fluent bundle the component participates in (the same
   * value that will be written to `furnace.json`'s `sharedFtl`). When set,
   * the component's own `.ftl` is not scaffolded and the plan preview
   * reflects that. Omit the key for the default per-component scaffold.
   */
  sharedFtl?: string;
  testStyle: ResolvedTestStyle;
  description: string;
  binaryName: string;
  /**
   * Resolved `--test-dir` override (engine-relative, already validated by
   * `resolveValidatedTestDir`). Omit for the default `<binaryName>`-derived
   * scaffold directory. The formatters must receive the same value the
   * scaffolders get. The plan used to recompute the default from
   * `binaryName` and named a directory the real run never wrote to.
   */
  testDir?: string;
}

/**
 * Builds the test-section fragment of the dry-run plan for a given
 * harness choice. Kept separate from the top-level formatter so the
 * switch over `testStyle` does not push the caller over the per-function
 * complexity budget.
 */
function formatTestSection(args: {
  testStyle: ResolvedTestStyle;
  componentName: string;
  binaryName: string;
  testDir?: string | undefined;
}): string {
  const { testStyle, componentName, binaryName, testDir } = args;
  if (testStyle === 'none') return '';

  const underscored = deriveTestStem(componentName, binaryName);

  if (testStyle === 'browser-chrome') {
    // Same resolver as scaffoldTestFiles: the registration name is the
    // path below browser/base/content/test/, which under --test-dir is
    // not the binary name.
    const testDirRel = resolveBrowserChromeTestDir(binaryName, testDir);
    const manifestName = testDirRel.slice(BROWSER_TEST_SCAFFOLD_ROOT.length);
    return (
      `\n\nWould create test files in engine/${testDirRel}/:\n` +
      `  browser.toml\n  head.js\n  browser_${binaryName}_${underscored}.js` +
      `\n\nWould register ${manifestName}/browser.toml in engine/browser/base/moz.build`
    );
  }

  if (testStyle === 'xpcshell') {
    const testDirRel = resolveXpcshellTestDir(binaryName, componentName, testDir);
    return `\n\nWould create xpcshell test files in engine/${testDirRel}/`;
  }

  // testStyle === 'mochikit' (last remaining branch in ResolvedTestStyle).
  const testRoot = 'engine/toolkit/content/tests/widgets/';
  return `\n\nWould create mochikit test file in ${testRoot}`;
}

/**
 * Builds the success-note body printed after `furnace create` has applied
 * its mutations. Lives beside the dry-run formatter so the two renderings
 * stay in lock-step when the scaffolded layout changes.
 */
export function formatSuccessNote(args: {
  componentName: string;
  files: string[];
  testFiles: string[];
  testStyle: ResolvedTestStyle;
  binaryName: string;
  /** Resolved `--test-dir` override. See {@link DryRunPlanInput.testDir}. */
  testDir?: string | undefined;
}): string {
  const { componentName, files, testFiles, testStyle, binaryName, testDir } = args;

  let note =
    `Files created in components/custom/${componentName}/:\n` +
    files.map((f) => `  ${f}`).join('\n');

  if (testFiles.length > 0) {
    let testRoot: string;
    if (testStyle === 'xpcshell') {
      testRoot = `engine/${resolveXpcshellTestDir(binaryName, componentName, testDir)}/`;
    } else if (testStyle === 'mochikit') {
      testRoot = 'engine/toolkit/content/tests/widgets/';
    } else {
      testRoot = `engine/${resolveBrowserChromeTestDir(binaryName, testDir)}/`;
    }
    note += `\n\nTest files in ${testRoot}:\n` + testFiles.map((f) => `  ${f}`).join('\n');
  }

  note +=
    '\n\n' +
    'Next steps:\n' +
    `  1. Edit component files in components/custom/${componentName}/\n` +
    '  2. Run "fireforge furnace preview" to see it\n' +
    '  3. Run "fireforge build" to apply and build';

  return note;
}

/**
 * Builds the planned component + test file list for a dry-run preview.
 *
 * Mirrors the order `writeComponentFiles` and the test-style scaffolders
 * would produce so the dry-run output matches what a real run prints on
 * success. The component directory path is rendered relative to
 * `components/custom/` to match the wording of the real success note.
 */
export function formatDryRunPlan(args: DryRunPlanInput): string {
  const {
    componentName,
    localized,
    register,
    composes,
    stockAdditions,
    sharedFtl,
    testStyle,
    description,
    binaryName,
    testDir,
  } = args;

  const componentFiles: string[] = [`${componentName}.mjs`, `${componentName}.css`];
  // A per-component .ftl is scaffolded only when the component does not
  // opt into a shared feature-scoped bundle. Mirrors writeComponentFiles.
  if (localized && !sharedFtl) componentFiles.push(`${componentName}.ftl`);

  let plan =
    `Would create files in components/custom/${componentName}/:\n` +
    componentFiles.map((f) => `  ${f}`).join('\n');

  plan += formatTestSection({ testStyle, componentName, binaryName, testDir });

  plan += `\n\nWould add custom entry to furnace.json:`;
  plan += `\n  name: ${componentName}`;
  plan += `\n  description: ${description || '(empty)'}`;
  plan += `\n  register: ${register}`;
  plan += `\n  localized: ${localized}`;
  if (composes && composes.length > 0) {
    plan += `\n  composes: ${composes.join(', ')}`;
  }
  if (stockAdditions && stockAdditions.length > 0) {
    plan += `\n\nWould add discovered stock to furnace.json:`;
    for (const name of stockAdditions) {
      plan += `\n  ${name}`;
    }
  }
  if (sharedFtl) {
    plan += `\n  sharedFtl: ${sharedFtl}`;
  }
  return plan;
}
