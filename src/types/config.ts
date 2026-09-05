// SPDX-License-Identifier: EUPL-1.2
/**
 * Firefox product type for downloads.
 */
export type FirefoxProduct = 'firefox' | 'firefox-esr' | 'firefox-beta' | 'firefox-devedition';

/**
 * Firefox version configuration.
 */
export interface FirefoxConfig {
  /** Firefox release version (e.g., "140.9.0esr") */
  version: string;
  /** Firefox product type */
  product: FirefoxProduct;
  /** Optional pinned SHA-256 for the resolved source archive */
  sha256?: string;
  /**
   * Accept a freshly downloaded archive when Mozilla's published SHA256SUMS
   * cannot be fetched or does not list it, instead of failing closed. The
   * download is then trusted on TLS alone (with a warning). Ignored when
   * `sha256` is pinned. Default false.
   */
  allowUnverifiedDownload?: boolean;
  /**
   * Optional release-candidate build directory (e.g. "build2"). When set,
   * the source archive resolves under
   * `pub/<product>/candidates/<version>-candidates/<candidate>/` instead of
   * `pub/<product>/releases/<version>/`, for pre-release verification.
   */
  candidate?: string;
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

/** Test command defaults stored in fireforge.json. */
export interface TestConfig {
  /**
   * Engine-relative browser-chrome canary file used by `fireforge test --canary`
   * when the command does not receive an explicit canary path.
   */
  canaryPath?: string;
  /** Short no-output ceiling for `fireforge test --canary`, in seconds. */
  canaryTimeoutSeconds?: number;
}

/** A single external executable required by a project-specific toolchain. */
export interface ExternalToolRequirement {
  /** Tool name as shown in doctor output, and PATH/xcrun lookup key when no path is set. */
  name: string;
  /** Absolute or project-relative executable path. */
  path?: string;
  /** Resolve the tool with `xcrun -find <name>` instead of PATH. */
  xcrun?: boolean;
  /** Missing tool is an error by default; set false for advisory probes. */
  required?: boolean;
}

/** Named group of project-specific external asset/build tools. */
export interface ExternalToolchainConfig {
  /** Human-readable toolchain name, e.g. "seasonal-branding". */
  name: string;
  /** Tools this toolchain needs. */
  tools: ExternalToolRequirement[];
}

/** Enforcement mode for patch policy violations during mutating commands. */
export type PatchPolicyMutationMode = 'error' | 'warn' | 'force';

/** A category-owned numeric range in the patch queue. */
export interface PatchPolicyRange {
  /** Inclusive lower bound. */
  from: number;
  /** Inclusive upper bound. */
  to: number;
  /** Category that owns this range. */
  category: string;
}

/** A single allowlisted reserved-range patch exception. */
export interface PatchPolicyReservedAllowedPatch {
  /** Exact patch filename allowed in the reserved range. */
  filename: string;
  /** Optional exact filesAffected allowlist for this reserved patch. */
  files?: string[];
  /** Project-relative ADR path documenting the exception. */
  adr?: string;
  /** Project-relative documentation path documenting the exception. */
  documentation?: string;
}

/** Reserved numeric range for exceptional patches. */
export interface PatchPolicyReservedRange {
  /** Inclusive lower bound. */
  from: number;
  /** Inclusive upper bound. */
  to: number;
  /** Exact patch exceptions allowed in this reserved range. */
  allowed: PatchPolicyReservedAllowedPatch[];
}

/**
 * Optional project-specific patch queue policy. When absent, FireForge keeps
 * its historical broad category + numeric ordering behaviour.
 */
export interface PatchPolicyConfig {
  /** Regex with named captures: order, category, slug. */
  filenamePattern?: string;
  /** Require non-empty patch descriptions. Default false. */
  requireDescription?: boolean;
  /** Allow numeric gaps within configured category ranges. Default true. */
  allowGaps?: boolean;
  /** How mutating commands handle policy violations. Default "error". */
  mutationMode?: PatchPolicyMutationMode;
  /** Category-owned numeric ranges. */
  ranges: PatchPolicyRange[];
  /** Reserved exception ranges. */
  reservedRanges?: PatchPolicyReservedRange[];
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
  /** Post-build packaging audit configuration */
  buildAudit?: BuildAuditConfig;
  /** Test command defaults */
  test?: TestConfig;
  /** Optional project-specific external toolchains checked by doctor. */
  externalToolchains?: ExternalToolchainConfig[];
  /** Project license SPDX identifier */
  license?: ProjectLicense;
  /** Wire command configuration */
  wire?: WireConfig;
  /** Patch lint configuration */
  patchLint?: PatchLintConfig;
  /** Optional project-specific patch queue policy. */
  patchPolicy?: PatchPolicyConfig;
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
  /**
   * Per-project override of {@link extraShim}, keyed by the project's path
   * exactly as it appears in {@link projects}. A string value points the
   * project at a different `.d.ts`; `null` opts the project out of the shared
   * extra shim entirely (it absorbs only the built-in Firefox globals shim).
   *
   * Needed because the shared shim is injected into every project: a shim hub
   * that references Gecko declaration libs (`lib.gecko.dom.d.ts`, …) is wanted
   * by projects that include it but collides with a project that narrows
   * `lib: ["ES2024", "DOM"]` (Element/Node identity splits, nsIPrincipal
   * mismatch). A narrowed project sets `null` here to stay clean.
   */
  projectOverrides?: Record<string, string | null>;
  /**
   * How to report undefined free identifiers (TS2304/TS2552). Default
   * `'warning'`: visible without failing the gate, since shim gaps produce
   * the same diagnostic as a genuine missing import. `'error'` makes them
   * blocking; `'off'` suppresses them.
   */
  undefinedIdentifiers?: PatchLintSeverityGate;
}

/**
 * Wire command configuration.
 */
/**
 * One deliberately-unpackaged source, declared so the post-build audit stops
 * reporting it as a missing registration.
 *
 * `reason` is required and must be non-empty. A carve-out whose rationale
 * nobody wrote down is indistinguishable from a mistake by the time someone
 * reads it, and this is the one audit class FireForge cannot derive from the
 * tree — the file's own header may say "never loaded", but nothing in
 * `moz.build` or `jar.mn` records that.
 */
export interface BuildAuditUnpackagedDeclaration {
  /** Engine-relative path, exact or with a `*` inside one path segment. */
  path: string;
  /** Why this file is never packaged. Required, non-empty. */
  reason: string;
}

/** Post-build packaging audit configuration. */
export interface BuildAuditConfig {
  /**
   * Sources the audit must treat as deliberately unpackaged. Admitted paths
   * are LISTED in the audit output rather than silenced, and one that DOES
   * resolve to a packaged artifact is reported as a stale carve-out.
   */
  unpackaged?: BuildAuditUnpackagedDeclaration[];
}

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
 * Merged after the strict preset.
 *
 * Boolean flags tighten the strict preset. The optional `paths` mapping
 * (each pattern may carry a single `*`) lets patch-owned modules be typed
 * from their real sources — e.g. `"resource:///modules/foo/*": ["./*"]` —
 * resolved host-side against the engine directory, so no `baseUrl` is set
 * (TS5090-safe) and no hand-generated ambient stub shim is needed. Other
 * options (`rootDir`, etc.) stay disallowed: they would fight the
 * synthetic program.
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
  /** Module-resolution `paths` mapping (pattern → targets, engine-relative). */
  paths?: Record<string, string[]>;
}

/**
 * Line-count thresholds for one `file-too-large` tier.
 *
 * Every field is optional; an omitted field keeps the built-in default.
 * The three must stay ordered `notice <= warning <= error`, which the
 * config validator enforces — an out-of-order triple silently disables a
 * band rather than failing anything.
 */
export interface PatchLintFileSizeTier {
  notice?: number;
  warning?: number;
  error?: number;
}

/**
 * Overrides for the `file-too-large` thresholds, per file class.
 *
 * These were module constants until 0.45.0, and nothing in `fireforge.json`
 * could move them. That is a problem specifically because the recommended
 * gate posture is `--max-warnings 0`: under it the `warning` band is not a
 * soft limit at all, so a project whose controllers legitimately sit a few
 * lines over 750 has a hard failure with no dial, at exactly the moment
 * someone is deciding whether to restructure a file.
 */
export interface PatchLintFileSizeThresholds {
  /** Non-test files. Defaults: notice 500, warning 750, error 900. */
  general?: PatchLintFileSizeTier;
  /** Test files. Defaults: notice 1200, warning 1400, error 1600. */
  test?: PatchLintFileSizeTier;
}

/**
 * Configuration for patch lint rules.
 */
export interface PatchLintConfig {
  /** Enable TypeScript checkJs pass on patch-owned .sys.mjs files */
  checkJs?: boolean;
  /**
   * When true with `checkJs: true`, run checkJs with `strict` and
   * `noImplicitAny` enabled (CI-style). Default false uses the loose preset.
   * Optional {@link checkJsCompilerOptions} can relax individual strict
   * flags (e.g. `strictNullChecks: false`).
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
   * but scoped to the patch-hygiene flow. Default unset: built-in shim only.
   */
  checkJsExtraShim?: string;
  /**
   * Extend the checkJs pass to patch-owned test `.js` files
   * (`browser_*` / `test_*` / `xpcshell_*` basenames and files under a
   * `/test/` path), each checked as its own small script-scope program with
   * same-directory patch-owned `head*.js` helpers included, so a call to a
   * harness global that does not exist fails at the patch boundary where the
   * test was authored rather than in a downstream jsconfig-project run.
   * Opt-in: it is a new failure surface with nonzero compile cost. Requires
   * `checkJs: true`.
   */
  checkJsTestFiles?: boolean;
  /**
   * Project-relative `.d.ts` appended to the built-in test-harness shim
   * (loose `TestUtils`/`BrowserTestUtils`/`add_task`/… declarations) for
   * the `checkJsTestFiles` pass. A consumer-typed `TestUtils` here is what
   * turns a call to a nonexistent harness member into a TS2339 at export
   * time. Requires `checkJsTestFiles: true`.
   */
  checkJsTestShim?: string;
  /** File paths exempt from the raw-color-value check (exact or basename match) */
  rawColorAllowlist?: string[];
  /**
   * Per-tier overrides for the `file-too-large` line-count thresholds.
   * Unset fields keep the built-in defaults.
   */
  fileSizeThresholds?: PatchLintFileSizeThresholds;
  /**
   * Run the project's Prettier over patch-owned `.sys.mjs` modules, from
   * inside `engine/` so the engine's own `.prettierrc*`/`.prettierignore`
   * decide. Default `'off'`: when off, formatting is explicitly out of
   * scope for the per-patch tier.
   */
  prettier?: PatchLintSeverityGate;
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
  /**
   * How the checkJs pass reports undefined free identifiers
   * (TS2304/TS2552). Same semantics as `typecheck.undefinedIdentifiers`;
   * the two flows share the suppression policy so a patch
   * cannot pass one and fail the other. Default: 'warning'.
   */
  undefinedIdentifiers?: PatchLintSeverityGate;
}

/**
 * Build modes for mach.
 *
 * Derived from the list so the runtime allowlist cannot drift from the type.
 */
export const BUILD_MODES = ['dev', 'debug', 'release'] as const;

/** Build mode for mach. */
export type BuildMode = (typeof BUILD_MODES)[number];

/**
 * Runtime state stored in .fireforge/state.json.
 */
export interface FireForgeState {
  /** Currently active brand */
  brand?: string;
  /** Build mode: dev, debug, release */
  buildMode?: BuildMode;
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
