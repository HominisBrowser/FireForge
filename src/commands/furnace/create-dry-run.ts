// SPDX-License-Identifier: EUPL-1.2
/*
 * Dry-run plan formatter for `furnace create`.
 *
 * Lives outside `create.ts` so the authoring command stays under the
 * per-file LOC budget. The formatter is pure — all inputs are already
 * resolved by the command's validation phase — so it can be exercised
 * independently of the mutation plumbing.
 */

import type { ResolvedTestStyle } from './create.js';

export interface DryRunPlanInput {
  componentName: string;
  localized: boolean;
  register: boolean;
  composes: string[] | undefined;
  /**
   * Feature-scoped Fluent bundle the component participates in (the same
   * value that will be written to `furnace.json`'s `sharedFtl`). When set,
   * the component's own `.ftl` is NOT scaffolded and the plan preview
   * reflects that. Omit the key for the default per-component scaffold.
   */
  sharedFtl?: string;
  testStyle: ResolvedTestStyle;
  description: string;
  binaryName: string;
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
}): string {
  const { testStyle, componentName, binaryName } = args;
  if (testStyle === 'none') return '';

  const strippedName = componentName.startsWith('moz-') ? componentName.slice(4) : componentName;
  const withoutBinaryPrefix = strippedName.startsWith(binaryName + '-')
    ? strippedName.slice(binaryName.length + 1)
    : strippedName;
  const underscored = withoutBinaryPrefix.replace(/-/g, '_');

  if (testStyle === 'browser-chrome') {
    const testRoot = `engine/browser/base/content/test/${binaryName}/`;
    return (
      `\n\nWould create test files in ${testRoot}:\n` +
      `  browser.toml\n  head.js\n  browser_${binaryName}_${underscored}.js` +
      `\n\nWould register ${binaryName}/browser.toml in engine/browser/base/moz.build`
    );
  }

  if (testStyle === 'xpcshell') {
    const testRoot = `engine/browser/base/content/test/${binaryName}-xpcshell/${componentName}/`;
    return `\n\nWould create xpcshell test files in ${testRoot}`;
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
}): string {
  const { componentName, files, testFiles, testStyle, binaryName } = args;

  let note =
    `Files created in components/custom/${componentName}/:\n` +
    files.map((f) => `  ${f}`).join('\n');

  if (testFiles.length > 0) {
    let testRoot: string;
    if (testStyle === 'xpcshell') {
      testRoot = `engine/browser/base/content/test/${binaryName}-xpcshell/${componentName}/`;
    } else if (testStyle === 'mochikit') {
      testRoot = 'engine/toolkit/content/tests/widgets/';
    } else {
      testRoot = `engine/browser/base/content/test/${binaryName}/`;
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
    sharedFtl,
    testStyle,
    description,
    binaryName,
  } = args;

  const componentFiles: string[] = [`${componentName}.mjs`, `${componentName}.css`];
  // A per-component .ftl is scaffolded only when the component does NOT
  // opt into a shared feature-scoped bundle. Mirrors writeComponentFiles.
  if (localized && !sharedFtl) componentFiles.push(`${componentName}.ftl`);

  let plan =
    `Would create files in components/custom/${componentName}/:\n` +
    componentFiles.map((f) => `  ${f}`).join('\n');

  plan += formatTestSection({ testStyle, componentName, binaryName });

  plan += `\n\nWould add custom entry to furnace.json:`;
  plan += `\n  name: ${componentName}`;
  plan += `\n  description: ${description || '(empty)'}`;
  plan += `\n  register: ${register}`;
  plan += `\n  localized: ${localized}`;
  if (composes && composes.length > 0) {
    plan += `\n  composes: ${composes.join(', ')}`;
  }
  if (sharedFtl) {
    plan += `\n  sharedFtl: ${sharedFtl}`;
  }
  return plan;
}
