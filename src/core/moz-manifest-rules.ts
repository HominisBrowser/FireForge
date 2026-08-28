// SPDX-License-Identifier: EUPL-1.2
import { basename, join } from 'node:path';

import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { pathExists, readText } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { escapeRegex } from '../utils/regex.js';
import { getProjectPaths, loadConfig } from './config.js';
import type { RegisterResult } from './moz-manifest-register.js';
import {
  registerBrowserContent,
  registerFireForgeModule,
  registerSharedCSS,
  registerTestManifest,
  registerToolkitWidget,
} from './moz-manifest-register.js';
import { isXpcshellTestRegistered, registerXpcshellTest } from './register-xpcshell-test.js';

/** Pattern rules mapping file paths to manifest types */
export interface PatternRule {
  /** Regex to match the file path (relative to engine/) */
  pattern: RegExp;
  /** Checks whether the file is already registered in its manifest */
  isRegistered: (engineDir: string, ...args: string[]) => Promise<boolean>;
  /** Register function */
  register: (
    engineDir: string,
    after: string | undefined,
    dryRun: boolean,
    ...args: string[]
  ) => Promise<RegisterResult>;
  /** Extract arguments from the regex match */
  extractArgs: (match: RegExpMatchArray) => string[];
  /**
   * Whether this rule's manifest supports `--after` placement.
   *
   * Four of the six rules ignore the flag entirely: the CLI accepts
   * `--after`, the adapter takes it as `_after`, and the operator gets a
   * silently alphabetical insertion with no indication their placement was
   * dropped. Declaring it lets {@link registerFile} say so.
   */
  supportsAfter: boolean;
}

/**
 * Returns manifest registration rules for the supported engine file
 * patterns. `createManifest` (from `register --create-manifest`) lets the
 * module and xpcshell-test rules scaffold a missing manifest (directory
 * moz.build / xpcshell.toml) and wire the parent chain instead of failing
 * with "Manifest not found".
 */
export function getRules(binaryName: string, createManifest = false): PatternRule[] {
  const moduleDir = `browser/modules/${binaryName}`;
  return [
    {
      pattern: /^browser\/themes\/shared\/(.+\.css)$/,
      isRegistered: (engineDir, fileName) => isSharedCSSRegistered(engineDir, fileName),
      register: (engineDir, after, dryRun, fileName) =>
        registerSharedCSS(engineDir, fileName, after, dryRun),
      extractArgs: (m) => [m[1] ?? ''],
      supportsAfter: true,
    },
    {
      // `.inc.xhtml` fragments under browser/base/content/ are deliberately
      // excluded: they are consumed via `#include` from a registered chrome
      // document (typically browser.xhtml) and do not get their own packaged
      // chrome URI. Without the carve-out, `status` flags every wired
      // fragment as "potentially unregistered" and `register --dry-run`
      // proposes a bogus jar.mn entry. The lookahead blocks the match so
      // `getUnregistrableAdvice` can emit the correct guidance instead.
      //
      // Test implementation files under `browser/base/content/test/` are
      // also excluded: they belong in the nearest `browser.toml` manifest,
      // not in jar.mn. The negative lookahead routes those paths to
      // `getUnregistrableAdvice`, which returns browser.toml-centric
      // guidance rather than proposing a jar.mn entry for a test file.
      pattern: /^browser\/base\/content\/(?!.+\.inc\.xhtml$)(?!test\/)(.+\.(?:js|mjs|xhtml|css))$/,
      isRegistered: (engineDir, fileName) => isBrowserContentRegistered(engineDir, fileName),
      register: (engineDir, after, dryRun, fileName) =>
        registerBrowserContent(engineDir, fileName, after, undefined, dryRun),
      extractArgs: (m) => [m[1] ?? ''],
      supportsAfter: true,
    },
    {
      // Fork-owned browser.toml manifests at ARBITRARY depth under
      // browser/base/content/test/ — a one-level pattern rejects nested
      // browser-chrome manifests.
      pattern: /^browser\/base\/content\/test\/((?:[^/]+\/)*[^/]+)\/browser\.toml$/,
      isRegistered: (_engineDir, testDir) => isTestManifestRegistered(_engineDir, testDir),
      register: (_engineDir, _after, dryRun, testDir) =>
        registerTestManifest(_engineDir, testDir, dryRun),
      extractArgs: (m) => [m[1] ?? ''],
      supportsAfter: false,
    },
    {
      pattern: new RegExp(`^browser/modules/${escapeRegex(binaryName)}/(.+\\.sys\\.mjs)$`),
      isRegistered: (_engineDir, fileName) =>
        isFireForgeModuleRegistered(_engineDir, fileName, moduleDir),
      register: (_engineDir, _after, dryRun, fileName) =>
        registerFireForgeModule(_engineDir, fileName, moduleDir, dryRun, createManifest),
      extractArgs: (m) => [m[1] ?? ''],
      supportsAfter: false,
    },
    {
      pattern: /^toolkit\/content\/widgets\/([^/]+)\/(.+\.(?:mjs|css))$/,
      isRegistered: (_engineDir, tagName, fileName) =>
        isToolkitWidgetRegistered(_engineDir, tagName, fileName),
      register: (_engineDir, _after, dryRun, tagName, fileName) =>
        registerToolkitWidget(_engineDir, tagName, fileName, dryRun),
      extractArgs: (m) => [m[1] ?? '', m[2] ?? ''],
      supportsAfter: false,
    },
    {
      // xpcshell test files. Any `test_*.js` outside
      // browser/base/content/test/ (which stays browser-chrome territory
      // with its browser.toml guidance) registers into the directory's
      // xpcshell.toml; with --create-manifest a missing manifest is
      // scaffolded and wired via XPCSHELL_TESTS_MANIFESTS.
      pattern: /^(?!browser\/base\/content\/test\/)(.+)\/(test_[^/]+\.js)$/,
      isRegistered: (engineDir, dirRel, fileName) =>
        isXpcshellTestRegistered(engineDir, dirRel, fileName),
      register: (engineDir, _after, dryRun, dirRel, fileName) =>
        registerXpcshellTest(engineDir, dirRel, fileName, dryRun, createManifest),
      // Both groups are guaranteed by the pattern; slice avoids dead
      // fallback branches.
      extractArgs: (m) => m.slice(1, 3),
      supportsAfter: false,
    },
  ];
}

async function isSharedCSSRegistered(engineDir: string, fileName: string): Promise<boolean> {
  const manifestPath = join(engineDir, 'browser/themes/shared/jar.inc.mn');
  if (!(await pathExists(manifestPath))) {
    throw new GeneralError('Manifest not found: browser/themes/shared/jar.inc.mn');
  }

  const name = basename(fileName, '.css');
  const content = await readText(manifestPath);
  // `register` writes the canonical `skin/classic/browser/<name>.css` form;
  // `furnace chrome-doc create` writes a `content/browser/<name>.css` entry
  // because the CSS is loaded by a chrome document via a `chrome://browser/
  // content/<name>.css` URI. Match either prefix so paths registered by the
  // chrome-doc scaffolder are not flagged as "potentially unregistered" by
  // `status` and so a re-run of `register` against the same file recognises
  // the existing entry instead of proposing a duplicate.
  return (
    content.includes(`skin/classic/browser/${name}.css`) ||
    content.includes(`content/browser/${name}.css`)
  );
}

async function isBrowserContentRegistered(engineDir: string, fileName: string): Promise<boolean> {
  const manifestPath = join(engineDir, 'browser/base/jar.mn');
  if (!(await pathExists(manifestPath))) {
    throw new GeneralError('Manifest not found: browser/base/jar.mn');
  }

  const content = await readText(manifestPath);
  return content.includes(`content/browser/${fileName}`);
}

async function isTestManifestRegistered(engineDir: string, testDir: string): Promise<boolean> {
  const manifestPath = join(engineDir, 'browser/base/moz.build');
  if (!(await pathExists(manifestPath))) {
    throw new GeneralError('Manifest not found: browser/base/moz.build');
  }

  const content = await readText(manifestPath);
  return content.includes(`content/test/${testDir}/browser.toml`);
}

async function isFireForgeModuleRegistered(
  engineDir: string,
  fileName: string,
  moduleDir: string
): Promise<boolean> {
  const manifestPath = join(engineDir, moduleDir, 'moz.build');
  if (!(await pathExists(manifestPath))) {
    throw new GeneralError(`Manifest not found: ${moduleDir}/moz.build`);
  }

  const content = await readText(manifestPath);
  return content.includes(`"${fileName}"`);
}

async function isToolkitWidgetRegistered(
  engineDir: string,
  _tagName: string,
  fileName: string
): Promise<boolean> {
  const manifestPath = join(engineDir, 'toolkit/content/jar.mn');
  if (!(await pathExists(manifestPath))) {
    throw new GeneralError('Manifest not found: toolkit/content/jar.mn');
  }

  const content = await readText(manifestPath);
  return content.includes(`content/global/elements/${fileName}`);
}

/**
 * Checks if a file path matches any known registrable pattern.
 * @param filePath - Path relative to engine/
 * @param binaryName - Binary name from fireforge.json (used for module directory)
 * @returns True if the file matches a known registration pattern
 */
export function matchesRegistrablePattern(filePath: string, binaryName: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const rules = getRules(binaryName);
  return rules.some((rule) => rule.pattern.test(normalized));
}

/** Returns advice for files that cannot be registered, or null if no advice applies. */
function getUnregistrableAdvice(filePath: string): string | null {
  if (filePath.endsWith('.ftl')) {
    return "FTL locale files are auto-discovered via jar.mn glob patterns and don't need manual registration.";
  }

  // `.inc.xhtml` fragments live under browser/base/content/ but are
  // consumed via `#include` from a registered chrome document (browser.xhtml
  // by default; a fork's custom top-level doc when `wire --dom-target` is
  // set). The preprocessor resolves the include at packaging time, so the
  // fragment never needs its own chrome URI entry in jar.mn. Give the
  // operator the actionable `wire` path instead of letting the generic
  // "unknown file pattern" message above fire.
  if (/^browser\/base\/content\/.+\.inc\.xhtml$/.test(filePath)) {
    return (
      '`.inc.xhtml` fragments are consumed via `#include` from a registered chrome document ' +
      '(e.g. browser.xhtml). They do not need an independent jar.mn entry — run ' +
      '"fireforge wire <name> --dom <path>" to insert the #include, or add the directive manually ' +
      'in the top-level chrome document.'
    );
  }

  // xpcshell.toml manifests scaffolded by `furnace create --test-style
  // xpcshell` or `furnace chrome-doc create --with-tests` live under
  // `browser/base/content/test/<binary-name>-xpcshell/<component>/`. The
  // scaffold intentionally does NOT auto-register — wiring
  // `XPCSHELL_TESTS_MANIFESTS` requires a deliberate choice about which
  // moz.build should own the entry. `register` surfaces that same guidance
  // instead of falling through to browser.toml-centric advice for a path
  // that is xpcshell-shaped and contains no browser.toml.
  if (filePath.endsWith('/xpcshell.toml')) {
    return (
      `xpcshell.toml manifests are not auto-registered by "fireforge register". ` +
      `Add "XPCSHELL_TESTS_MANIFESTS += ['${basename(filePath)}']" to the ` +
      `moz.build that covers ${filePath.replace(/\/xpcshell\.toml$/, '/')}, ` +
      'or register one of its test files with "fireforge register <path>/test_*.js --create-manifest", ' +
      'which scaffolds the manifest and wires XPCSHELL_TESTS_MANIFESTS automatically. ' +
      'Browser-chrome tests (browser.toml) are auto-registered via "fireforge register <path>/browser.toml".'
    );
  }

  const testMatch = filePath.match(/^browser\/base\/content\/test\/([^/]+)\/(?!browser\.toml$).+$/);
  if (testMatch) {
    const dir = testMatch[1];
    return (
      'Individual test files should be added directly to the corresponding browser.toml manifest. ' +
      `Use 'fireforge register browser/base/content/test/${dir}/browser.toml' to register new test directories.`
    );
  }

  return null;
}

/**
 * Checks whether a supported registrable file is already present in its manifest.
 *
 * @param root - Project root directory
 * @param filePath - Path relative to engine/
 * @returns True if the file is already registered in its manifest
 */
export async function isFileRegistered(root: string, filePath: string): Promise<boolean> {
  const { engine: engineDir } = getProjectPaths(root);
  const config = await loadConfig(root);
  const rules = getRules(config.binaryName);
  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const rule of rules) {
    const match = normalizedPath.match(rule.pattern);
    if (match) {
      const args = rule.extractArgs(match);
      return rule.isRegistered(engineDir, ...args);
    }
  }

  const advice = getUnregistrableAdvice(normalizedPath);
  if (advice) {
    throw new InvalidArgumentError(advice, 'path');
  }

  throw new InvalidArgumentError(
    buildUnknownPatternMessage(normalizedPath, config.binaryName),
    'path'
  );
}

/** Shared "Unknown file pattern" message naming every supported pattern. */
function buildUnknownPatternMessage(normalizedPath: string, binaryName: string): string {
  return (
    `Unknown file pattern: "${normalizedPath}". Supported patterns:\n` +
    '  browser/themes/shared/*.css\n' +
    '  browser/base/content/*.{js,mjs,xhtml,css}\n' +
    '  browser/base/content/test/**/browser.toml\n' +
    `  browser/modules/${binaryName}/*.sys.mjs\n` +
    '  toolkit/content/widgets/*/*.{mjs,css}\n' +
    '  **/test_*.js (xpcshell test files; registers into the nearest xpcshell.toml)'
  );
}

/**
 * Registers a file in the appropriate build manifest.
 *
 * @param root - Project root directory
 * @param filePath - Path relative to engine/
 * @param dryRun - If true, return what would be done without writing
 * @param after - Optional substring to place entry after (instead of alphabetical)
 * @param options - `createManifest` scaffolds a missing manifest (directory
 *   moz.build / xpcshell.toml) and wires the parent chain instead of failing
 * @returns Registration result
 */
export async function registerFile(
  root: string,
  filePath: string,
  dryRun = false,
  after?: string,
  options: { createManifest?: boolean } = {}
): Promise<RegisterResult> {
  const { engine: engineDir } = getProjectPaths(root);
  const config = await loadConfig(root);
  const rules = getRules(config.binaryName, options.createManifest === true);

  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const rule of rules) {
    const match = normalizedPath.match(rule.pattern);
    if (match) {
      const args = rule.extractArgs(match);
      if (after !== undefined && !rule.supportsAfter) {
        // Say so rather than inserting alphabetically and letting the
        // operator believe their placement was honoured.
        warn(
          `--after is not supported for ${normalizedPath}: this manifest is ` +
            'kept in sorted order, so the entry was inserted alphabetically.'
        );
      }
      return rule.register(engineDir, after, dryRun, ...args);
    }
  }

  const advice = getUnregistrableAdvice(normalizedPath);
  if (advice) {
    throw new InvalidArgumentError(advice, 'path');
  }

  throw new InvalidArgumentError(
    buildUnknownPatternMessage(normalizedPath, config.binaryName),
    'path'
  );
}
