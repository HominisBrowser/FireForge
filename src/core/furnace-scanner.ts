// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ScannedComponent } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import { CUSTOM_ELEMENTS_JS } from './furnace-constants.js';

/** Path to the widgets directory within the engine source tree */
const WIDGETS_DIR = 'toolkit/content/widgets';

/** Path to the Fluent localization directory for toolkit global components */
const FTL_DIR = 'toolkit/locales/en-US/toolkit/global';

/**
 * Parses customElements.js to extract tag-to-module mappings.
 *
 * Looks for registration patterns like:
 * ```
 * lazy.customElements.setElementCreationCallback("moz-button", () => {
 *   import("chrome://global/content/elements/moz-button.mjs");
 * });
 * ```
 *
 * @param engineDir - Path to the Firefox engine source root
 * @returns Map of tagName to module path
 */
export async function scanCustomElementsRegistrations(
  engineDir: string
): Promise<Map<string, string>> {
  const registrations = new Map<string, string>();
  const filePath = join(engineDir, CUSTOM_ELEMENTS_JS);

  if (!(await pathExists(filePath))) {
    return registrations;
  }

  const content = await readText(filePath);
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const callbackMatch = /setElementCreationCallback\(\s*"([^"]+)"/.exec(line);
    if (!callbackMatch?.[1]) continue;

    const tagName = callbackMatch[1];
    let modulePath = '';

    // Search the following lines for an import() statement
    const searchEnd = Math.min(i + 5, lines.length);
    for (let j = i + 1; j < searchEnd; j++) {
      const importLine = lines[j];
      if (importLine === undefined) continue;

      const importMatch = /import\(\s*"([^"]+)"/.exec(importLine);
      if (importMatch?.[1]) {
        modulePath = importMatch[1];
        break;
      }
    }

    if (!modulePath) {
      // No module path found in the lookahead lines; skip this entry
      continue;
    }
    registrations.set(tagName, modulePath);
  }

  return registrations;
}

/**
 * Scans the widgets directory to discover all MozLitElement custom elements.
 *
 * Each subdirectory starting with `moz-` that contains a `.mjs` file is
 * considered a component. For each component, checks whether it has associated
 * CSS, Fluent localization, and customElements.js registration.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @returns Array of discovered components
 */
export async function scanWidgetsDirectory(engineDir: string): Promise<ScannedComponent[]> {
  const widgetsPath = join(engineDir, WIDGETS_DIR);

  if (!(await pathExists(widgetsPath))) {
    return [];
  }

  const entries = await readdir(widgetsPath, { withFileTypes: true });
  const registrations = await scanCustomElementsRegistrations(engineDir);
  const components: ScannedComponent[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('moz-')) {
      continue;
    }

    const tagName = entry.name;
    const componentDir = join(widgetsPath, tagName);
    const componentEntries = await readdir(componentDir, { withFileTypes: true });

    // Only include directories that contain a .mjs file
    const hasMjs = componentEntries.some((e) => e.isFile() && e.name.endsWith('.mjs'));
    if (!hasMjs) {
      continue;
    }

    const hasCSS = componentEntries.some((e) => e.isFile() && e.name.endsWith('.css'));
    const ftlPath = join(engineDir, FTL_DIR, `${tagName}.ftl`);
    const hasFTL = await pathExists(ftlPath);
    const isRegistered = registrations.has(tagName);

    components.push({
      tagName,
      sourcePath: join(WIDGETS_DIR, tagName),
      hasCSS,
      hasFTL,
      isRegistered,
    });
  }

  return components;
}

/**
 * Gets detailed information about a single component by tag name.
 * @param engineDir - Path to the Firefox engine source root
 * @param tagName - Component tag name (e.g., "moz-button")
 * @returns Component details, or null if not found in the source tree
 */
export async function getComponentDetails(
  engineDir: string,
  tagName: string
): Promise<ScannedComponent | null> {
  const componentDir = join(engineDir, WIDGETS_DIR, tagName);

  if (!(await pathExists(componentDir))) {
    return null;
  }

  const entries = await readdir(componentDir, { withFileTypes: true });
  const hasMjs = entries.some((e) => e.isFile() && e.name.endsWith('.mjs'));

  if (!hasMjs) {
    return null;
  }

  const hasCSS = entries.some((e) => e.isFile() && e.name.endsWith('.css'));
  const ftlPath = join(engineDir, FTL_DIR, `${tagName}.ftl`);
  const hasFTL = await pathExists(ftlPath);
  const registrations = await scanCustomElementsRegistrations(engineDir);
  const isRegistered = registrations.has(tagName);

  return {
    tagName,
    sourcePath: join(WIDGETS_DIR, tagName),
    hasCSS,
    hasFTL,
    isRegistered,
  };
}

/**
 * Checks whether a component directory exists in the engine source tree.
 * @param engineDir - Path to the Firefox engine source root
 * @param tagName - Component tag name (e.g., "moz-button")
 * @returns True if the component directory exists
 */
export async function isComponentInEngine(engineDir: string, tagName: string): Promise<boolean> {
  const componentDir = join(engineDir, WIDGETS_DIR, tagName);
  return pathExists(componentDir);
}
