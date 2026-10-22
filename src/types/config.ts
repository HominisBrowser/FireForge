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
  /**
   * What the preflight orphan census does with a harness helper that
   * survived an earlier run in this objdir: `report` (default) names it and
   * proceeds; `reap` terminates it and stamps `orphans-reaped=<n>` on the
   * verdict line. `--reap-orphans` is the per-invocation equivalent.
   */
  reapOrphans?: 'report' | 'reap';
  /**
   * `fixed` (the default) refuses a browser run while the mochitest server
   * or Marionette port is held. `auto` lets a run proceed when the holder is
   * not this checkout's own and the engine's mochitest harness can fall back
   * to a free port itself, so sibling checkouts can run browser suites at
   * once. `--auto-ports` is the per-invocation equivalent.
   */
  mochitestPorts?: 'fixed' | 'auto';
  /**
   * `exclusive` (the default): every `fireforge test` holds the engine
   * session lock alone. `shared`: a build-less run with auto ports holds it
   * shared, so peers' build-less runs on the same objdir overlap while
   * builds and re-exports still wait. `--shared-lock` is the per-invocation
   * equivalent.
   */
  lockMode?: 'exclusive' | 'shared';
  /**
   * Which components `test --build` deploys before building: `all` (the
   * default) every component with undeployed edits, `reached` only those a
   * requested test reaches, `none` nothing. `--furnace-apply` is the
   * per-invocation equivalent.
   */
  furnaceApply?: 'all' | 'reached' | 'none';
}

/** Patch history log settings stored in fireforge.json. */
export interface HistoryConfig {
  /**
   * Project-relative path of the append-only patch history log. Defaults to
   * `.fireforge/history.jsonl`, outside the tracked patch queue.
   */
  path?: string;
}

/** A single external executable required by a project-specific toolchain. */
export interface ExternalToolRequirement {
  /** Tool name as shown in doctor output, and PATH/xcrun lookup key when no path is set. */
  name: string;
  /** Absolute or project-relative executable path. */
  path?: string;
  /** Resolve the tool with `xcrun -find <name>` instead of PATH. */
  xcrun?: boolean;
  /** Missing tool is an error by default. Set false for advisory probes. */
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
 * One `patchPolicy.upstreamAllowlist` entry in object form. The string form
 * is shorthand for `{ path }`.
 */
export interface PatchPolicyUpstreamAllowEntry {
  /** Engine-relative path glob (`*` within a segment, `**` across segments). */
  path: string;
  /**
   * Registration-only mode: a patch may only add lines to a matching file
   * (no removals, no deletion), and every non-blank added line must carry
   * `marker` (or `patchPolicy.addOnlyMarker`), case-insensitively.
   */
  addOnly?: boolean;
  /** Marker an added line must contain. Overrides `patchPolicy.addOnlyMarker`. */
  marker?: string;
}

/**
 * Limits the files a class of patch may touch, e.g. a `-tests` patch to test
 * directories and test manifests. A rule applies to a patch when every
 * selector it sets matches. At least one selector is required.
 */
export interface PatchPolicyScopeRule {
  /** Applies to patches in this category. */
  category?: string;
  /** Applies to patches whose filename matches this regular expression. */
  filenamePattern?: string;
  /** Engine-relative path globs every file the patch touches must match. */
  files: string[];
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
  /**
   * Globs naming the upstream files a non-reserved patch may modify. A file
   * counts as upstream when no patch in the queue creates it. Unset: no
   * restriction.
   */
  upstreamAllowlist?: Array<string | PatchPolicyUpstreamAllowEntry>;
  /** Default marker for `addOnly` allowlist entries that set none. */
  addOnlyMarker?: string;
  /** File-scope rules per patch class (category and/or filename pattern). */
  scopeRules?: PatchPolicyScopeRule[];
  /**
   * Require every reserved allowlist entry's `adr` and `documentation` path
   * to exist under the project root. Default false.
   */
  verifyDocumentPaths?: boolean;
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
  /** Patch history log settings */
  history?: HistoryConfig;
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
  /** `fireforge check`: the composed static gate's policy and project steps */
  check?: CheckConfig;
  /**
   * Project marker prefix appended to lines FireForge writes into
   * upstream Firefox source files (e.g. the `customElements.js` tag list).
   * `"MYBROWSER"` emits a trailing `  // MYBROWSER:` on each inserted line.
   * Keeps modifications discoverable and re-applies idempotent.
   */
  markerComment?: string;
}

/** The built-in steps of `fireforge check`, in table order. */
export const CHECK_BUILTIN_STEPS = [
  'status',
  'verify',
  'lint',
  'typecheck',
  'furnace-validate',
  'token-coverage',
] as const;

/** One built-in `fireforge check` step name. */
export type CheckBuiltinStep = (typeof CHECK_BUILTIN_STEPS)[number];

/**
 * A project command `fireforge check` runs beside its built-in steps
 * (`check.extraSteps[]`): an audit FireForge does not ship.
 */
export interface CheckExtraStep {
  /** Unique step name shown in the table (lowercase, digits and dashes). */
  name: string;
  /** Shell command line, run with `/bin/sh -c` (`cmd.exe /c` on Windows). */
  command: string;
  /** Project-relative working directory. Defaults to the project root. */
  cwd?: string;
  /** Seconds before the step is killed and fails. Unbounded when unset. */
  timeout?: number;
  /**
   * Steps (built-in or extra) that must finish before this one starts,
   * whatever their outcome: an ordering, not a success dependency.
   */
  after?: string[];
}

/** Configuration for `fireforge check`. Every field is optional. */
export interface CheckConfig {
  /** Built-in steps this project never runs. */
  skip?: CheckBuiltinStep[];
  /**
   * The status step's `--check` policy: `--fail-on`, `--allow` and
   * `--fail-on-unknown`. Unset runs the default `status --check` policy.
   */
  status?: {
    failOn?: string[];
    allow?: string[];
    failOnUnknown?: boolean;
  };
  /** `--max-warnings` for the lint and furnace-validate steps. */
  maxWarnings?: {
    lint?: number;
    furnace?: number;
  };
  /** Project commands run as further steps. */
  extraSteps?: CheckExtraStep[];
  /** Seconds before a built-in step is killed and fails. Unbounded when unset. */
  timeout?: number;
  /** Per-step `timeout` overrides for built-in steps, in seconds. */
  timeouts?: Partial<Record<CheckBuiltinStep, number>>;
  /**
   * Fail the verdict when a built-in step is skipped because it has nothing
   * to run (no `typecheck` block, no furnace.json). A step named in `skip`
   * is a decision, not a gap, and never fails it.
   */
  failOnSkipped?: boolean;
  /**
   * Project-relative path the lint step writes its `lint --per-patch
   * --report` JSON to. Extra steps receive it as
   * `FIREFORGE_CHECK_LINT_REPORT`, so an audit can read the run's lint
   * report instead of linting the queue a second time.
   */
  lintReport?: string;
}

/**
 * Configuration for the `fireforge typecheck` command. Distinct from
 * `patchLint.checkJs`: patch-lint runs every time `fireforge lint` runs
 * and is scoped to patch-owned `.sys.mjs`. Typecheck runs whole projects
 * the operator points at via `projects` and is intended as a CI gate.
 */
export interface TypecheckConfig {
  /**
   * Project-relative paths to jsconfig.json (or tsconfig.json) files
   * the typecheck command should run. Must be non-empty when the
   * `typecheck` block is present. An empty array would silently turn
   * the command into a no-op.
   */
  projects: string[];
  /**
   * Optional project-relative path to an additional `.d.ts` file whose
   * contents are concatenated to the built-in `FIREFOX_GLOBALS_SHIM`.
   * Lets projects declare component patterns like `MozLitElement` /
   * `MozXULElement` once instead of per-file. Concat order is
   * built-in shim first, extraShim second: augment, don't redeclare.
   */
  extraShim?: string;
  /**
   * Per-project override of {@link extraShim}, keyed by the project's path
   * exactly as it appears in {@link projects}. A string value points the
   * project at a different `.d.ts`. `null` opts the project out of the
   * shared extra shim entirely (it absorbs only the built-in Firefox globals
   * shim).
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
   * blocking. `'off'` suppresses them.
   */
  undefinedIdentifiers?: PatchLintSeverityGate;
  /**
   * Types Lit in the shim: `LitElement` and the template helpers of
   * `chrome://global/content/vendor/lit.all.mjs`, and `MozLitElement` of
   * `chrome://global/content/lit-utils.mjs`, with closed member lists, so a
   * misspelt member of a widget host is an error. Default off: reactive
   * properties declared only through `static properties` or
   * `static queries` then need a JSDoc or constructor declaration.
   */
  litTypes?: boolean;
}

/**
 * Wire command configuration.
 */
/**
 * One intentionally unpackaged source, declared so the post-build audit
 * stops reporting it as a missing registration.
 *
 * `reason` is required and must be non-empty. A carve-out whose rationale
 * nobody wrote down is indistinguishable from a mistake by the time someone
 * reads it, and this is the one audit class FireForge cannot derive from the
 * tree: the file's own header may say "never loaded", but nothing in
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
   * Sources the audit must treat as intentionally unpackaged. Admitted
   * paths are listed in the audit output rather than silenced, and one that
   * does resolve to a packaged artifact is reported as a stale carve-out.
   */
  unpackaged?: BuildAuditUnpackagedDeclaration[];
}

export interface WireConfig {
  /** Subscript directory relative to engine/. Default: "browser/base/content" */
  subscriptDir?: string;
}

/**
 * Severity gate for opt-in patch-lint rules. `'off'` disables the rule.
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
 * from their real sources (e.g. `"resource:///modules/foo/*": ["./*"]`),
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
 * Every field is optional. An omitted field keeps the built-in default.
 * The three must stay ordered `notice <= warning <= error`, which the
 * config validator enforces, because an out-of-order triple silently
 * disables a band rather than failing anything.
 */
export interface PatchLintFileSizeTier {
  notice?: number;
  warning?: number;
  error?: number;
}

/**
 * Overrides for the `file-too-large` thresholds, per file class.
 *
 * Configurable because the recommended gate posture is `--max-warnings 0`:
 * under it the `warning` band is not a soft limit at all, so with fixed
 * thresholds a project whose controllers legitimately sit a few lines over
 * 750 would have a hard failure with no dial, at exactly the moment
 * someone is deciding whether to restructure a file.
 */
export interface PatchLintFileSizeThresholds {
  /** Non-test files. Defaults: notice 500, warning 750, error 900. */
  general?: PatchLintFileSizeTier;
  /** Test files. Defaults: notice 1200, warning 1400, error 1600. */
  test?: PatchLintFileSizeTier;
}

/** What `file-too-large` counts: every line, or only lines that carry code. */
export type PatchLintFileSizeMetric = 'raw' | 'code';

/**
 * What `large-patch-lines` counts: every non-binary line of the unified
 * diff, or only the added lines that carry code.
 */
export type PatchLintPatchSizeMetric = 'diff' | 'addedCode';

/**
 * Overrides for one patch-size tier. `lines` drives `large-patch-lines`,
 * `files` drives `large-patch-files`. Each is a `notice`/`warning`/`error`
 * triple shaped like {@link PatchLintFileSizeTier}, merged over the
 * defaults and validated `notice <= warning <= error`.
 */
export interface PatchLintPatchSizeTier {
  lines?: PatchLintFileSizeTier;
  files?: PatchLintFileSizeTier;
}

/**
 * Overrides for the patch-size thresholds, per tier.
 *
 * Defaults: lines general 800/1500/3000, test 1500/3000/6000, branding 8000/18000/30000;
 * files warn above 5 (general, test) or 60 (branding). The files triple has
 * no notice or error band by default: an unset `files.notice` follows the
 * effective `files.warning`, and an unset `files.error` never fires.
 */
export interface PatchLintPatchSizeThresholds {
  general?: PatchLintPatchSizeTier;
  test?: PatchLintPatchSizeTier;
  branding?: PatchLintPatchSizeTier;
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
   * Boolean overrides merged after the strict preset. Only valid when
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
   * What `file-too-large` counts. `'raw'` (the default) counts every line
   * the way `wc -l` does. `'code'` counts the lines left non-blank once
   * comments are blanked, so JSDoc and blank lines stop counting.
   */
  fileSizeMetric?: PatchLintFileSizeMetric;
  /**
   * Per-tier overrides for `large-patch-lines` and `large-patch-files`.
   * Unset fields keep the built-in defaults.
   */
  patchSizeThresholds?: PatchLintPatchSizeThresholds;
  /**
   * What `large-patch-lines` counts. `'diff'` (the default) counts every
   * non-binary line of the unified diff. `'addedCode'` counts added lines
   * that are neither blank nor comment, judged on each file's post-image,
   * skips lines inside Furnace `@fireforge-include` spans, and counts test
   * files against the test tier and everything else against the general
   * tier inside a mixed patch.
   */
  patchSizeMetric?: PatchLintPatchSizeMetric;
  /**
   * Globs naming registration files (`jar.mn`, `moz.build`, manifests)
   * that count toward neither `large-patch-lines` nor `large-patch-files`.
   * A glob without a `/` matches the basename, one with a `/` matches the
   * engine-relative path. `*` stays within a path segment, `**` crosses
   * segments. Default: none.
   */
  patchSizeRegistrationFiles?: string[];
  /**
   * Run the project's Prettier over patch-owned `.sys.mjs` modules, from
   * inside `engine/` so the engine's own `.prettierrc*`/`.prettierignore`
   * decide. Default `'off'`: when off, formatting is explicitly out of
   * scope for the per-patch tier.
   */
  prettier?: PatchLintSeverityGate;
  /**
   * Which carriers the `forward-registration` queue rule checks for a line
   * that names a file only a later patch creates. `'support-files'` (the
   * default) checks test-manifest `support-files`. `'extended'` also checks
   * jar.mn pair lines, moz.build path tokens, test-manifest sections and
   * `head`, and customElements.js chrome URLs resolved through the queue's
   * own jar.mn lines. Opt-in: a queue that predates the wider rule can carry
   * such edges, and a new error on install would red its gate.
   */
  forwardRegistration?: 'support-files' | 'extended';
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
   * not ES modules. Using one flag for both would silently disable the
   * rule when a chrome subscript was fed to the module parser. Default:
   * 'off'.
   */
  chromeScriptJsDoc?: PatchLintSeverityGate;
  /**
   * How the checkJs pass reports undefined free identifiers
   * (TS2304/TS2552). Same semantics as `typecheck.undefinedIdentifiers`.
   * The two flows share the suppression policy so a patch cannot pass one
   * and fail the other. Default: 'warning'.
   */
  undefinedIdentifiers?: PatchLintSeverityGate;
  /**
   * Token scales enforced over CSS files a patch creates (`token-scale`).
   * Each scale names properties whose values must resolve to its tokens.
   * Default unset: no scale is enforced.
   */
  tokenScales?: PatchLintTokenScale[];
}

/**
 * One `patchLint.tokenScales[]` entry: a property family (spacing, type,
 * radius, opacity, z-index, …) whose declared values must be tokens on one
 * scale.
 */
export interface PatchLintTokenScale {
  /** CSS properties governed (exact names, or a `*`-suffixed prefix such as `padding*`). */
  properties: string[];
  /**
   * Custom-property prefix of the scale's tokens, e.g. `--mybrowser-space-`,
   * or a list of them for a scale whose steps are spelled more than one way
   * (`["--mybrowser-space-", "--mybrowser-gap-"]`).
   */
  prefix: string | string[];
  /**
   * Literal value atoms accepted without a token (`0`, `auto`, `1px`).
   * `*` is a wildcard, so `*%` accepts any percentage. CSS-wide keywords
   * (`inherit`, `initial`, `unset`, `revert`, `revert-layer`) are always
   * accepted.
   */
  allowLiterals?: string[];
  /**
   * Further custom properties accepted besides `prefix` (exact names, or a
   * `*`-suffixed prefix such as `--moz-*`), for reviewed upstream or recipe
   * tokens.
   */
  allow?: string[];
  /**
   * Literal atoms accepted only inside a math function (`calc()`, `min()`,
   * `max()`, `clamp()`), with the `allowLiterals` wildcard syntax: a
   * unitless multiplier (`calc(var(--x-space-2) * 2)`) without also
   * accepting a bare `2`.
   */
  allowInCalc?: string[];
  /**
   * Largest total, in px, a declaration may subtract from this scale's
   * tokens inside a math function (`calc(var(--x-space-4) - 1px)`), for a
   * border or hairline inset. Summed over the declaration.
   */
  offsetCap?: number;
  /** Engine-relative globs (`**`, `*`, `?`) of files this scale does not govern. */
  exclude?: string[];
  /**
   * The fewest patch-created CSS files (outside `exclude`) that must carry a
   * declaration of this scale's properties. A queue under it fails
   * `token-scale-vacuous`, so a scale that matches nothing, or a scan set
   * a move emptied, cannot pass by judging nothing.
   */
  minFiles?: number;
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
