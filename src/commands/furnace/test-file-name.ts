// SPDX-License-Identifier: EUPL-1.2

/**
 * Derives the underscored stem a component's generated test files are named
 * after.
 *
 * Five modules (`create-browser-test`, `create-dry-run`, `remove`, `rename`,
 * `rename-browser-test`) had each inlined this three-step transform. The steps
 * are not arbitrary and must agree exactly, or `furnace rename` and
 * `furnace remove` compute a different filename than `furnace create` wrote
 * and silently leave the old test behind:
 *
 * 1. drop the upstream `moz-` custom-element prefix, which never appears in a
 *    test filename.
 * 2. drop a leading `<binaryName>-`, because the test directory is already
 *    named after the binary and the prefix would be doubled.
 * 3. underscore the remaining dashes, matching mozilla-central's
 *    `browser_*.js` convention.
 * @param componentName - Custom-element name, e.g. `moz-mybrowser-sidebar`.
 * @param binaryName - Configured binary name, e.g. `mybrowser`.
 * @returns The stem, e.g. `sidebar`.
 */
export function deriveTestStem(componentName: string, binaryName: string): string {
  const withoutMozPrefix = componentName.startsWith('moz-')
    ? componentName.slice(4)
    : componentName;
  const withoutBinaryPrefix = withoutMozPrefix.startsWith(`${binaryName}-`)
    ? withoutMozPrefix.slice(binaryName.length + 1)
    : withoutMozPrefix;
  return withoutBinaryPrefix.replace(/-/g, '_');
}

/**
 * Builds the browser-chrome test filename for a component.
 * @param componentName - Custom-element name.
 * @param binaryName - Configured binary name.
 * @returns The filename, e.g. `browser_mybrowser_sidebar.js`.
 */
export function browserTestFileName(componentName: string, binaryName: string): string {
  return `browser_${binaryName}_${deriveTestStem(componentName, binaryName)}.js`;
}
