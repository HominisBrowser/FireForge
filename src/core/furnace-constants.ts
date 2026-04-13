// SPDX-License-Identifier: EUPL-1.2
/** Path to customElements.js within the engine source tree */
export const CUSTOM_ELEMENTS_JS = 'toolkit/content/customElements.js';

/** Path to jar.mn within the engine source tree (toolkit global) */
export const JAR_MN = 'toolkit/content/jar.mn';

/** Default Fluent localization directory for toolkit global components, relative to engine root */
export const FTL_DIR = 'toolkit/locales/en-US/toolkit/global';

/** File extensions that constitute a Furnace component's source files. */
export const COMPONENT_FILE_EXTENSIONS = ['.mjs', '.css', '.ftl'] as const;

/** Returns true when `fileName` has one of the standard component file extensions. */
export function isComponentSourceFile(fileName: string): boolean {
  return COMPONENT_FILE_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

/**
 * Resolves the FTL base path, preferring the user-configured value from
 * `furnace.json` over the built-in default.
 */
export function resolveFtlDir(configuredPath?: string): string {
  return configuredPath ?? FTL_DIR;
}

/**
 * Converts a kebab-case tag name to PascalCase class name.
 * e.g. "moz-sidebar-panel" → "MozSidebarPanel"
 */
export function tagNameToClassName(tagName: string): string {
  return tagName
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/**
 * Strips a known component prefix from a tag name to produce a concise
 * display name. Falls back to the full tag name when the prefix doesn't
 * match, so callers never receive an empty string.
 */
export function stripComponentPrefix(tagName: string, componentPrefix: string): string {
  if (componentPrefix && tagName.startsWith(componentPrefix)) {
    return tagName.slice(componentPrefix.length);
  }
  return tagName;
}
