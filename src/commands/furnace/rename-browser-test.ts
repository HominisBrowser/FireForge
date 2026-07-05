// SPDX-License-Identifier: EUPL-1.2
import { tagNameToClassName } from '../../core/furnace-constants.js';
import { escapeRegex } from '../../utils/regex.js';

function deriveTestStem(componentName: string, binaryName: string): string {
  const strippedName = componentName.startsWith('moz-') ? componentName.slice(4) : componentName;
  const withoutBinaryPrefix = strippedName.startsWith(binaryName + '-')
    ? strippedName.slice(binaryName.length + 1)
    : strippedName;
  return withoutBinaryPrefix.replace(/-/g, '_');
}

/** Rewrites scaffolded browser-chrome test literals after a component rename. */
export function updateBrowserChromeTestContent(
  content: string,
  oldName: string,
  newName: string,
  binaryName: string
): string {
  const oldClassName = tagNameToClassName(oldName);
  const newClassName = tagNameToClassName(newName);
  const oldUnderscored = oldName.replace(/-/g, '_');
  const newUnderscored = newName.replace(/-/g, '_');
  const oldTestStem = deriveTestStem(oldName, binaryName);
  const newTestStem = deriveTestStem(newName, binaryName);
  return content
    .replace(new RegExp(escapeRegex(oldName), 'g'), newName)
    .replace(new RegExp(escapeRegex(oldClassName), 'g'), newClassName)
    .replace(new RegExp(escapeRegex(oldUnderscored), 'g'), newUnderscored)
    .replace(new RegExp(escapeRegex(oldTestStem), 'g'), newTestStem);
}
