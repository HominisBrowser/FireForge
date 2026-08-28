// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type * as estree from 'estree';

import type { ScannedComponent } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';
import type { AcornESTreeNode } from './ast-utils.js';
import { asEstree, getNodeSource, parseScript, walkAST } from './ast-utils.js';
import { CUSTOM_ELEMENTS_JS, FTL_DIR, WIDGETS_DIR } from './furnace-constants.js';

/** Path to the widgets directory within the engine source tree */

/**
 * Additional Firefox source directories known to contain MozLitElement
 * components. Used by `--deep` scan mode to discover components beyond
 * the primary widgets directory.
 */
export const DEEP_SCAN_PATHS: readonly string[] = [
  'browser/components/shopping',
  'browser/components/migration',
  'browser/components/firefoxview',
  'browser/components/sidebar',
  'browser/components/backup',
  'toolkit/components/aboutprocesses',
  'toolkit/components/printing',
];

/**
 * Module-level cache for parsed customElements.js registrations, keyed by
 * SHA-256 of the file content. Avoids re-parsing the same file within a
 * single process lifetime (scan → status → apply chain).
 */
let registrationCache: { hash: string; registrations: Map<string, string> } | undefined;

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
  const contentHash = createHash('sha256').update(content).digest('hex');

  // Return cached result if file hasn't changed since last parse.
  if (registrationCache && registrationCache.hash === contentHash) {
    return new Map(registrationCache.registrations);
  }

  try {
    const ast = parseScript(content);

    const recordRegistration = (tagName: string, modulePath = ''): void => {
      const existing = registrations.get(tagName);
      if (existing && existing.length > 0 && modulePath.length === 0) {
        return;
      }

      registrations.set(tagName, modulePath);
    };

    walkAST(ast, {
      enter(node) {
        if (node.type === 'ForOfStatement') {
          const forOf: AcornESTreeNode<estree.ForOfStatement> = asEstree(node);
          if (forOf.right.type !== 'ArrayExpression') {
            return;
          }

          const bodySource = getNodeSource(content, asEstree(forOf.body));
          if (!bodySource.includes('setElementCreationCallback')) {
            return;
          }

          for (const element of forOf.right.elements) {
            if (!element || element.type !== 'ArrayExpression') continue;

            const [tagNode, moduleNode] = element.elements;
            if (!tagNode || !moduleNode) continue;
            if (tagNode.type !== 'Literal' || moduleNode.type !== 'Literal') continue;
            if (typeof tagNode.value !== 'string' || typeof moduleNode.value !== 'string') continue;

            recordRegistration(tagNode.value, moduleNode.value);
          }

          return;
        }

        if (node.type !== 'CallExpression') {
          return;
        }

        const call = asEstree<estree.CallExpression>(node);
        if (call.callee.type !== 'MemberExpression') {
          return;
        }

        const property = call.callee.property;
        if (property.type !== 'Identifier' || property.name !== 'setElementCreationCallback') {
          return;
        }

        const [tagArg] = call.arguments;
        if (!tagArg || tagArg.type !== 'Literal' || typeof tagArg.value !== 'string') {
          return;
        }

        const callSource = getNodeSource(content, call);
        const moduleMatch =
          /(?:import|importESModule|loadSubScript)\(\s*"([^"]+)"/.exec(callSource) ??
          /(?:import|importESModule|loadSubScript)\(\s*'([^']+)'/.exec(callSource);
        if (!moduleMatch?.[1]) {
          return;
        }

        recordRegistration(tagArg.value, moduleMatch[1]);
      },
    });
  } catch (parseError: unknown) {
    // Best-effort scanner: if upstream syntax changes or the file is damaged,
    // fall back to the old literal callback heuristic instead of failing the
    // whole scan command.
    const reason = toError(parseError).message;
    warn(
      `AST parsing of customElements.js failed (${reason}). Falling back to regex-based heuristic. ` +
        'Results may be incomplete — run "fireforge furnace validate" to verify registration consistency.'
    );
    verbose(`Scanner regex fallback activated due to parse error: ${reason}`);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      const callbackMatch = /setElementCreationCallback\(\s*"([^"]+)"/.exec(line);
      if (!callbackMatch?.[1]) continue;

      const tagName = callbackMatch[1];
      let modulePath = '';

      const searchEnd = Math.min(i + 15, lines.length);
      for (let j = i + 1; j < searchEnd; j++) {
        const importLine = lines[j];
        if (importLine === undefined) continue;

        const importMatch = /(?:import|importESModule|loadSubScript)\(\s*"([^"]+)"/.exec(
          importLine
        );
        if (importMatch?.[1]) {
          modulePath = importMatch[1];
          break;
        }
      }

      registrations.set(tagName, modulePath);
    }
  }

  // Cache results for subsequent calls within the same process.
  registrationCache = { hash: contentHash, registrations: new Map(registrations) };

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
export async function scanWidgetsDirectory(
  engineDir: string,
  ftlDir?: string,
  extraPaths?: string[],
  componentPrefix?: string
): Promise<ScannedComponent[]> {
  const searchPaths = [WIDGETS_DIR, ...(extraPaths ?? [])];
  const registrations = await scanCustomElementsRegistrations(engineDir);
  const components: ScannedComponent[] = [];
  const seen = new Set<string>();
  const prefix = componentPrefix ?? 'moz-';

  for (const searchDir of searchPaths) {
    const dirPath = join(engineDir, searchDir);
    if (!(await pathExists(dirPath))) {
      continue;
    }

    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix) || seen.has(entry.name)) {
        continue;
      }

      const tagName = entry.name;
      seen.add(tagName);
      const componentDir = join(dirPath, tagName);
      const componentEntries = await readdir(componentDir, { withFileTypes: true });

      // Only include directories that contain a .mjs file
      const hasMjs = componentEntries.some((e) => e.isFile() && e.name.endsWith('.mjs'));
      if (!hasMjs) {
        continue;
      }

      const hasCSS = componentEntries.some((e) => e.isFile() && e.name.endsWith('.css'));
      const ftlPath = join(engineDir, ftlDir ?? FTL_DIR, `${tagName}.ftl`);
      const hasFTL = await pathExists(ftlPath);
      const isRegistered = registrations.has(tagName);

      components.push({
        tagName,
        sourcePath: join(searchDir, tagName),
        hasCSS,
        hasFTL,
        isRegistered,
      });
    }
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
  tagName: string,
  ftlDir?: string
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
  const ftlPath = join(engineDir, ftlDir ?? FTL_DIR, `${tagName}.ftl`);
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
