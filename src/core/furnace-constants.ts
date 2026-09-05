// SPDX-License-Identifier: EUPL-1.2
/** Path to customElements.js within the engine source tree */
export const CUSTOM_ELEMENTS_JS = 'toolkit/content/customElements.js';

import { normalizePathSlashes } from '../utils/paths.js';
/** Path to jar.mn within the engine source tree (toolkit global) */
export const JAR_MN = 'toolkit/content/jar.mn';

/**
 * Upstream home of the MozLitElement widget sources.
 *
 * The trailing slash is NOT included: `build-audit-transforms.ts` needs
 * `${WIDGETS_DIR}/` and its ordered prefix table depends on that slash, so
 * appending it at the one site that wants it keeps the others correct.
 */
export const WIDGETS_DIR = 'toolkit/content/widgets';

/** Default Fluent localization directory for toolkit global components, relative to engine root */
export const FTL_DIR = 'toolkit/locales/en-US/toolkit/global';

/**
 * Engine-relative root every browser-chrome / xpcshell test scaffold lives
 * under, trailing slash included. A `--test-dir` override must stay below
 * it so the `browser/base/moz.build` manifest registration keeps working.
 */
export const BROWSER_TEST_SCAFFOLD_ROOT = 'browser/base/content/test/';

/**
 * Suffix for the per-binary xpcshell scaffold parent directory. Components
 * created with `furnace create --with-tests --xpcshell` land at
 * `browser/base/content/test/<binaryName>${XPCSHELL_TEST_DIR_SUFFIX}/<component>/`.
 * Centralised so `create` / `remove` / `rename` / `validate` all agree on the
 * path template.
 */
const XPCSHELL_TEST_DIR_SUFFIX = '-xpcshell';

/**
 * Returns the engine-relative directory that holds xpcshell scaffolds for
 * a given binary. Matches the form `create-xpcshell.ts` writes and the
 * path `remove.ts` / `rename.ts` / `validate.ts` must clean up.
 */
export function xpcshellTestParentDir(binaryName: string): string {
  return `${BROWSER_TEST_SCAFFOLD_ROOT}${binaryName}${XPCSHELL_TEST_DIR_SUFFIX}`;
}

/**
 * Resolves the engine-relative directory a browser-chrome scaffold is
 * written to: the `--test-dir` override when given, else
 * `browser/base/content/test/<binaryName>`. The scaffolder AND the
 * dry-run / success formatters resolve through this one function, so the
 * printed plan cannot disagree with the files that land on disk.
 */
export function resolveBrowserChromeTestDir(binaryName: string, override?: string): string {
  return override ?? `${BROWSER_TEST_SCAFFOLD_ROOT}${binaryName}`;
}

/**
 * Resolves the engine-relative directory an xpcshell scaffold is written
 * to. A `--test-dir` override names the FINAL directory (no per-component
 * segment is appended); the default is
 * `browser/base/content/test/<binaryName>-xpcshell/<componentName>`.
 */
export function resolveXpcshellTestDir(
  binaryName: string,
  componentName: string,
  override?: string
): string {
  return override ?? `${xpcshellTestParentDir(binaryName)}/${componentName}`;
}

/** File extensions that constitute a Furnace component's source files. */
const COMPONENT_FILE_EXTENSIONS = ['.mjs', '.css', '.ftl'] as const;

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
 * Resolves the chrome sub-path that `document.l10n` / `insertFTLIfNeeded`
 * expects for a given `ftlBasePath`. Strips the mandatory `locales/<LOCALE>/`
 * segment. For the default `toolkit/locales/en-US/toolkit/global` this yields
 * `toolkit/global`.
 *
 * Returns `undefined` when no `locales/<LOCALE>/` segment is present. Callers
 * must treat that as "cannot confidently locate the locale jar.mn entry" and
 * degrade gracefully rather than inventing a path.
 */
export function resolveFtlChromeSubPath(ftlBasePath?: string): string | undefined {
  const path = normalizePathSlashes(ftlBasePath ?? FTL_DIR);
  const match = /^(.*?)\/locales\/[^/]+\/(.+?)\/?$/.exec(path);
  if (!match?.[2]) return undefined;
  return match[2];
}

/**
 * Returns the engine-relative locale jar.mn that owns the FTL tree for a
 * given `ftlBasePath`. For the default toolkit tree this yields
 * `toolkit/locales/jar.mn`.
 *
 * Returns `undefined` when the path does not contain a `locales/` segment —
 * callers must treat that as "cannot locate" and degrade gracefully.
 */
export function resolveFtlLocaleJarMnPath(ftlBasePath?: string): string | undefined {
  const path = normalizePathSlashes(ftlBasePath ?? FTL_DIR);
  const match = /^(.*?)\/locales\/[^/]+\//.exec(path);
  if (!match?.[1]) return undefined;
  return `${match[1]}/locales/jar.mn`;
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
