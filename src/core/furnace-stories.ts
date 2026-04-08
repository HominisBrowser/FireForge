// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentType, SyncResult } from '../types/furnace.js';
import { ensureDir, pathExists, removeDir, removeFile, writeText } from '../utils/fs.js';
import { getProjectPaths, loadConfig } from './config.js';
import { loadFurnaceConfig } from './furnace-config.js';
import { DEFAULT_LICENSE, getLicenseHeader } from './license-headers.js';

/** MPL-2.0 license header used in generated story files for Firefox-derived components */
const MPL_LICENSE_HEADER = getLicenseHeader('MPL-2.0', 'js');

/** Title category for each component type */
const TITLE_CATEGORIES: Record<ComponentType, string> = {
  stock: 'Design System/Stock',
  override: 'Design System/Overrides',
  custom: 'Design System/Custom',
};

/**
 * Derives a human-readable display name from a component tag name.
 *
 * Removes the `moz-` prefix, splits on hyphens, capitalises each word,
 * and joins with spaces.
 *
 * @example
 * generateDisplayName("moz-button")      // "Button"
 * generateDisplayName("moz-message-bar") // "Message Bar"
 *
 * @param tagName - Component tag name (e.g. "moz-button")
 * @returns Display name (e.g. "Button")
 */
function generateDisplayName(tagName: string): string {
  const withoutPrefix = tagName.replace(/^moz-/, '');
  return withoutPrefix
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Generates the full content of a Storybook `.stories.mjs` file for a
 * Furnace component.
 *
 * @param tagName - Component tag name (e.g. "moz-button")
 * @param displayName - Human-readable name (e.g. "Button")
 * @param type - Component classification (stock, override, custom)
 * @returns Complete story file content
 */
export function generateStoryContent(
  tagName: string,
  displayName: string,
  type: ComponentType,
  licenseHeader: string = MPL_LICENSE_HEADER,
  modulePath?: string
): string {
  const category = TITLE_CATEGORIES[type];

  // Derive chrome:// URI from modulePath if provided, otherwise default to elements/ path
  let chromeUri: string;
  if (modulePath) {
    if (modulePath.startsWith('toolkit/content/')) {
      chromeUri = modulePath.replace(/^toolkit\/content\//, 'chrome://global/content/');
    } else if (modulePath.startsWith('browser/base/content/')) {
      chromeUri = modulePath.replace(/^browser\/base\/content\//, 'chrome://browser/content/');
    } else {
      chromeUri = `chrome://global/content/${modulePath}`;
    }
  } else {
    chromeUri = `chrome://global/content/elements/${tagName}.mjs`;
  }

  return `${licenseHeader}

import { html } from "chrome://global/content/vendor/lit.all.mjs";
// The component import triggers customElements.define
import "${chromeUri}";

export default {
  title: "${category}/${displayName}",
  component: "${tagName}",
  argTypes: {},
};

const Template = (args) => html\`<${tagName}></${tagName}>\`;

export const Default = Template.bind({});
Default.args = {};
`;
}

/**
 * Returns the path to the Storybook stories directory in the engine.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @returns Absolute path to `browser/components/storybook/stories/`
 */
export function getStoriesDir(engineDir: string): string {
  return join(engineDir, 'browser', 'components', 'storybook', 'stories');
}

/**
 * Synchronises Storybook story files for all Furnace-managed components.
 *
 * - Stock components: story created only if not already present.
 * - Override components: story always regenerated.
 * - Custom components: story always regenerated.
 * - Stale story files (for components no longer in furnace.json) are removed.
 *
 * @param root - Root directory of the project
 * @returns Summary of created, updated, and removed story files
 */
export async function syncStories(root: string): Promise<SyncResult> {
  const config = await loadFurnaceConfig(root);
  const forgeConfig = await loadConfig(root);
  const license = forgeConfig.license ?? DEFAULT_LICENSE;
  const customLicenseHeader = getLicenseHeader(license, 'js');
  const { engine: engineDir } = getProjectPaths(root);
  const storiesDir = join(getStoriesDir(engineDir), 'furnace');
  await ensureDir(storiesDir);

  const result: SyncResult = { created: [], updated: [], removed: [] };
  const expectedFiles = new Set<string>();

  // --- Stock components (only create if missing) ---
  for (const tagName of config.stock) {
    const filename = `${tagName}.stories.mjs`;
    expectedFiles.add(filename);

    const filePath = join(storiesDir, filename);
    if (await pathExists(filePath)) {
      continue;
    }

    const displayName = generateDisplayName(tagName);
    const content = generateStoryContent(tagName, displayName, 'stock');
    await writeText(filePath, content);
    result.created.push(filename);
  }

  // --- Override components (always regenerate) ---
  for (const name of Object.keys(config.overrides)) {
    const filename = `${name}.stories.mjs`;
    expectedFiles.add(filename);

    const filePath = join(storiesDir, filename);
    const existed = await pathExists(filePath);

    const displayName = generateDisplayName(name);
    const content = generateStoryContent(name, displayName, 'override', customLicenseHeader);
    await writeText(filePath, content);

    if (existed) {
      result.updated.push(filename);
    } else {
      result.created.push(filename);
    }
  }

  // --- Custom components (always regenerate, use project license) ---
  for (const name of Object.keys(config.custom)) {
    const filename = `${name}.stories.mjs`;
    expectedFiles.add(filename);

    const filePath = join(storiesDir, filename);
    const existed = await pathExists(filePath);

    const displayName = generateDisplayName(name);
    const content = generateStoryContent(name, displayName, 'custom', customLicenseHeader);
    await writeText(filePath, content);

    if (existed) {
      result.updated.push(filename);
    } else {
      result.created.push(filename);
    }
  }

  // --- Remove stale story files ---
  const entries = await readdir(storiesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.stories.mjs')) {
      continue;
    }
    if (!expectedFiles.has(entry.name)) {
      await removeFile(join(storiesDir, entry.name));
      result.removed.push(entry.name);
    }
  }

  return result;
}

/**
 * Removes the entire `stories/furnace/` directory from the engine.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @returns Number of files that were removed
 */
export async function cleanStories(engineDir: string): Promise<number> {
  const storiesDir = join(getStoriesDir(engineDir), 'furnace');

  if (!(await pathExists(storiesDir))) {
    return 0;
  }

  const entries = await readdir(storiesDir, { withFileTypes: true });
  const count = entries.filter((e) => e.isFile()).length;

  await removeDir(storiesDir);

  return count;
}
