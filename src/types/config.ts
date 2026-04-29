// SPDX-License-Identifier: EUPL-1.2
/**
 * Firefox product type for downloads.
 */
export type FirefoxProduct = 'firefox' | 'firefox-esr' | 'firefox-beta';

/**
 * Firefox version configuration.
 */
export interface FirefoxConfig {
  /** Firefox release version (e.g., "140.9.0esr") */
  version: string;
  /** Firefox product type */
  product: FirefoxProduct;
}

/**
 * Supported project license SPDX identifiers.
 */
export type ProjectLicense = 'EUPL-1.2' | 'MPL-2.0' | '0BSD' | 'GPL-2.0-or-later';

/**
 * Build configuration options.
 */
export interface BuildConfig {
  /** Number of parallel jobs for mach build */
  jobs?: number;
}

/**
 * Main fireforge.json configuration schema.
 */
export interface FireForgeConfig {
  /** Display name of the browser */
  name: string;
  /** Vendor/company name */
  vendor: string;
  /** Application ID (e.g., "org.example.browser") */
  appId: string;
  /** Binary name for the executable */
  binaryName: string;
  /** Firefox version settings */
  firefox: FirefoxConfig;
  /** Build settings */
  build?: BuildConfig;
  /** Project license SPDX identifier */
  license?: ProjectLicense;
  /** Wire command configuration */
  wire?: WireConfig;
  /** Patch lint configuration */
  patchLint?: PatchLintConfig;
  /**
   * Project marker prefix appended to lines FireForge writes into
   * upstream Firefox source files (e.g. the `customElements.js` tag list).
   * `"MYBROWSER"` emits a trailing `  // MYBROWSER:` on each inserted line.
   * Keeps modifications discoverable and re-applies idempotent.
   */
  markerComment?: string;
}

/**
 * Wire command configuration.
 */
export interface WireConfig {
  /** Subscript directory relative to engine/. Default: "browser/base/content" */
  subscriptDir?: string;
}

/**
 * Severity gate for opt-in patch-lint rules. `'off'` disables the rule;
 * `'warning'` and `'error'` emit issues at the matching severity.
 */
export type PatchLintSeverityGate = 'off' | 'warning' | 'error';

/**
 * Configuration for patch lint rules.
 */
export interface PatchLintConfig {
  /** Enable TypeScript checkJs pass on patch-owned .sys.mjs files */
  checkJs?: boolean;
  /** File paths exempt from the raw-color-value check (exact or basename match) */
  rawColorAllowlist?: string[];
  /** Enforce JSDoc on class-method exports in patch-owned .sys.mjs files. Default: 'off'. */
  jsdocClassMethods?: PatchLintSeverityGate;
  /** Require ≥1 assertion in patch-introduced browser_*.js test files. Default: 'off'. */
  testAssertionFloor?: PatchLintSeverityGate;
}

/**
 * Build mode for mach.
 */
export type BuildMode = 'dev' | 'debug' | 'release';

/**
 * Runtime state stored in .fireforge/state.json.
 */
export interface FireForgeState {
  /** Currently active brand */
  brand?: string;
  /** Build mode: dev, debug, release */
  buildMode?: BuildMode;
  /** Last successful build timestamp (ISO string) */
  lastBuild?: string;
  /** Firefox version that was downloaded */
  downloadedVersion?: string;
  /** Initial commit hash of the engine (baseline) */
  baseCommit?: string;
  /** State for a patch application that needs manual resolution */
  pendingResolution?: {
    /** Filename of the patch that failed to apply */
    patchFilename: string;
    /** The original error message from the failed apply */
    originalError: string;
  };
}

/**
 * Project directory structure.
 */
export interface ProjectPaths {
  /** Root directory of the project */
  root: string;
  /** Path to fireforge.json */
  config: string;
  /** Path to .fireforge directory */
  fireforgeDir: string;
  /** Path to .fireforge/state.json */
  state: string;
  /** Path to engine directory (Firefox source) */
  engine: string;
  /** Path to patches directory */
  patches: string;
  /** Path to configs directory */
  configs: string;
  /** Path to src directory */
  src: string;
  /** Path to components directory */
  componentsDir: string;
}
