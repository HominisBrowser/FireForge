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
  /** Typecheck command configuration (CI-grade, whole-project) */
  typecheck?: TypecheckConfig;
  /**
   * Project marker prefix appended to lines FireForge writes into
   * upstream Firefox source files (e.g. the `customElements.js` tag list).
   * `"MYBROWSER"` emits a trailing `  // MYBROWSER:` on each inserted line.
   * Keeps modifications discoverable and re-applies idempotent.
   */
  markerComment?: string;
}

/**
 * Configuration for the `fireforge typecheck` command. Distinct from
 * `patchLint.checkJs`: patch-lint runs every time `fireforge lint` runs
 * and is scoped to patch-owned `.sys.mjs`; typecheck runs whole projects
 * the operator points at via `projects` and is intended as a CI gate.
 */
export interface TypecheckConfig {
  /**
   * Project-relative paths to jsconfig.json (or tsconfig.json) files
   * the typecheck command should run. Must be non-empty when the
   * `typecheck` block is present — an empty array would silently turn
   * the command into a no-op.
   */
  projects: string[];
  /**
   * Optional project-relative path to an additional `.d.ts` file whose
   * contents are concatenated to the built-in `FIREFOX_GLOBALS_SHIM`.
   * Lets projects declare component patterns like `MozLitElement` /
   * `MozXULElement` once instead of per-file. Concat order is
   * built-in shim first, extraShim second — augment, don't redeclare.
   */
  extraShim?: string;
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
 * Allowlisted TypeScript `compilerOptions` overrides for the patch
 * `checkJs` pass when {@link PatchLintConfig.checkJsStrict} is true.
 * Merged after the strict preset; only boolean flags — no `paths`,
 * `rootDir`, or other options that would fight the synthetic program.
 */
export interface PatchLintCheckJsCompilerOptions {
  strictNullChecks?: boolean;
  strictFunctionTypes?: boolean;
  strictBindCallApply?: boolean;
  noImplicitThis?: boolean;
  useUnknownInCatchVariables?: boolean;
  strictPropertyInitialization?: boolean;
  noUnusedLocals?: boolean;
  noUnusedParameters?: boolean;
}

/**
 * Configuration for patch lint rules.
 */
export interface PatchLintConfig {
  /** Enable TypeScript checkJs pass on patch-owned .sys.mjs files */
  checkJs?: boolean;
  /**
   * When true with `checkJs: true`, run checkJs with `strict` and
   * `noImplicitAny` enabled (CI-style). Default false preserves the
   * historical loose preset. Optional {@link checkJsCompilerOptions}
   * can relax individual strict flags (e.g. `strictNullChecks: false`).
   */
  checkJsStrict?: boolean;
  /**
   * Boolean overrides merged after the strict preset; only valid when
   * `checkJsStrict` is true. Requires `checkJs: true`.
   */
  checkJsCompilerOptions?: PatchLintCheckJsCompilerOptions;
  /**
   * Project-relative path to an additional `.d.ts` file whose contents
   * are concatenated to the built-in `FIREFOX_GLOBALS_SHIM` for the
   * `patchLint.checkJs` pass. Same semantics as `typecheck.extraShim`
   * but scoped to the patch-hygiene flow. Default unset = current
   * behaviour (built-in shim only).
   */
  checkJsExtraShim?: string;
  /** File paths exempt from the raw-color-value check (exact or basename match) */
  rawColorAllowlist?: string[];
  /** Enforce JSDoc on class-method exports in patch-owned .sys.mjs files. Default: 'off'. */
  jsdocClassMethods?: PatchLintSeverityGate;
  /** Require ≥1 assertion in any patch-touched browser_*.js test file (new or modified). Default: 'off'. */
  testAssertionFloor?: PatchLintSeverityGate;
  /**
   * Enforce JSDoc on top-level classes (and their methods) and functions
   * in patch-owned chrome subscripts (`.js` files loaded via
   * `Services.scriptloader.loadSubScript`, e.g.
   * `browser/base/content/<binaryName>*.js`). Distinct from
   * `jsdocClassMethods` because chrome subscripts are parsed as scripts,
   * not ES modules — using one flag for both would silently disable the
   * rule when a chrome subscript was fed to the module parser. Default:
   * 'off'.
   */
  chromeScriptJsDoc?: PatchLintSeverityGate;
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
