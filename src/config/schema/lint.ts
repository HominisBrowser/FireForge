// SPDX-License-Identifier: EUPL-1.2
/**
 * `patchLint`: the quality rules over owned changes. The size thresholds and
 * their defaults live here so that validation can check an override against
 * the thresholds it actually produces, and the rules read the same table.
 */
import { type Infer, s, type Schema } from '../../kernel/schema.js';
import { positive, projectPath, severity, text } from './common.js';

/** Notice, warning and error bands of one size rule. A null `error` never fires. */
export interface SizeBands {
  notice: number;
  warning: number;
  error: number | null;
}

/** A configured override of some bands, merged over the defaults. */
export interface BandOverride {
  notice?: number;
  warning?: number;
  error?: number;
}

/** `file-too-large` line counts per file class. */
const FILE_SIZE_DEFAULTS = {
  general: { notice: 500, warning: 750, error: 900 },
  test: { notice: 1200, warning: 1400, error: 1600 },
} as const satisfies Record<string, SizeBands>;

/**
 * `large-patch-lines` per tier. Branding is calibrated against a fresh-fork
 * branding change (every locale's brand strings, copied assets), which lands
 * around 15-16k lines and must read as a notice.
 */
const PATCH_LINE_DEFAULTS = {
  general: { notice: 800, warning: 1500, error: 3000 },
  test: { notice: 1500, warning: 3000, error: 6000 },
  branding: { notice: 8000, warning: 18000, error: 30000 },
} as const satisfies Record<string, SizeBands>;

/**
 * `large-patch-files` warning per tier. File count expresses scope, so there
 * is no notice or error band unless one is configured.
 */
const PATCH_FILES_WARNING_DEFAULTS = { general: 5, test: 5, branding: 60 } as const;

/** A file class of `file-too-large`. */
export type FileSizeClass = keyof typeof FILE_SIZE_DEFAULTS;

/** A tier of the patch-size rules. */
export type PatchSizeTier = keyof typeof PATCH_LINE_DEFAULTS;

/**
 * The effective `file-too-large` bands of a file class: the override merged
 * over the defaults.
 *
 * @param fileClass - `general` or `test`
 * @param override - `patchLint.fileSizeThresholds.<class>`, if set
 */
export function fileSizeBands(fileClass: FileSizeClass, override?: BandOverride): SizeBands {
  return { ...FILE_SIZE_DEFAULTS[fileClass], ...override };
}

/**
 * The effective patch-size bands of a tier. An unset `files.notice` follows
 * the effective `files.warning` (no notice band) and an unset `files.error`
 * never fires.
 *
 * @param tier - `general`, `test` or `branding`
 * @param override - `patchLint.patchSizeThresholds.<tier>`, if set
 */
export function patchSizeBands(
  tier: PatchSizeTier,
  override?: { lines?: BandOverride; files?: BandOverride }
): { lines: SizeBands; files: SizeBands } {
  const warning = override?.files?.warning ?? PATCH_FILES_WARNING_DEFAULTS[tier];
  return {
    lines: { ...PATCH_LINE_DEFAULTS[tier], ...override?.lines },
    files: {
      notice: override?.files?.notice ?? warning,
      warning,
      error: override?.files?.error ?? null,
    },
  };
}

/** An out-of-order triple silently disables a band, so it is refused. */
function orderProblem(bands: SizeBands): string | undefined {
  const ordered =
    bands.notice <= bands.warning && (bands.error === null || bands.warning <= bands.error);
  return ordered
    ? undefined
    : `must resolve to notice <= warning <= error (resolved: ${bands.notice}/${bands.warning}/${bands.error ?? 'none'})`;
}

const bands: Schema<BandOverride> = s.object({
  notice: positive.describe('Count above which a notice is reported').optional(),
  warning: positive.describe('Count above which a warning is reported').optional(),
  error: positive.describe('Count above which an error is reported').optional(),
});

function fileSizeTier(fileClass: FileSizeClass): Schema<BandOverride> {
  return bands.refine((override) => orderProblem(fileSizeBands(fileClass, override)));
}

function patchSizeTier(
  tier: PatchSizeTier
): Schema<{ lines?: BandOverride; files?: BandOverride }> {
  const lines = bands.describe('large-patch-lines bands').optional();
  const files = bands.describe('large-patch-files bands').optional();
  return s.object({ lines, files }).refine((override) => {
    const resolved = patchSizeBands(tier, override);
    const linesProblem = orderProblem(resolved.lines);
    if (linesProblem !== undefined) return `lines ${linesProblem}`;
    const filesProblem = orderProblem(resolved.files);
    return filesProblem === undefined ? undefined : `files ${filesProblem}`;
  });
}

/**
 * Whether a CSS property name matches a token-scale property list: exact, or
 * a `*`-suffixed prefix.
 *
 * @param name - The property, lower case
 * @param patterns - `tokenScales[].properties`
 */
export function matchesPropertyName(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
  );
}

const tokenPrefix = s.string({
  pattern: /^--[\w-]+$/,
  format: 'a custom-property prefix such as "--brand-space-"',
});

const tokenScale = s
  .object({
    properties: s
      .array(text, { min: 1 })
      .describe('CSS properties governed: exact names or *-suffixed prefixes such as padding*'),
    prefix: s
      .union(tokenPrefix, s.array(tokenPrefix, { min: 1 }))
      .describe('Custom-property prefix of the scale tokens, or a list of them'),
    allowLiterals: s
      .array(text)
      .describe('Literal values accepted without a token; * is a wildcard')
      .optional(),
    allow: s
      .array(s.string({ pattern: /^--\S/, format: 'a custom-property name starting with "--"' }))
      .describe('Further custom properties accepted: exact names or *-suffixed prefixes')
      .optional(),
    allowInCalc: s
      .array(text)
      .describe('Literal values accepted only inside calc(), min(), max() or clamp()')
      .optional(),
    offsetCap: s
      .number({ min: 0 })
      .describe('Largest total px a declaration may subtract from scale tokens in a math function')
      .optional(),
    exclude: s.array(text).describe('Engine-relative globs of files the scale skips').optional(),
    minFiles: positive
      .describe('Fewest created stylesheets that must declare a governed property')
      .optional(),
    allowValues: s
      .array(s.object({ property: text, value: text, reason: text }), { min: 1 })
      .describe('Reviewed declarations accepted as written, each with its reason')
      .optional(),
  })
  .refine((scale) => {
    const stray = scale.allowValues?.find(
      (entry) => !matchesPropertyName(entry.property.toLowerCase(), scale.properties)
    );
    return stray === undefined
      ? undefined
      : `allows a value for "${stray.property}", which is not a property this scale governs`;
  });

/**
 * Every lint rule ID, for validating `patchLint.rules`. The rule registry in
 * `src/lint` holds the same list with each rule's default and description.
 */
export const LINT_RULE_IDS = [
  'relative-import',
  'missing-modification-comment',
  'jsdoc',
  'jsdoc-class-method',
  'chrome-script-jsdoc',
  'test-needs-assertion',
  'observer-topic-naming',
  'raw-color-value',
  'token-prefix-violation',
  'token-scale',
  'token-scale-vacuous',
  'stale-token-scale-exclude',
  'file-too-large',
  'large-patch-lines',
  'large-patch-files',
  'missing-license-header',
  'modified-file-missing-header',
  'mozbuild-unsorted-list',
  'unregistered-system-module',
  'dangling-registration',
  'forward-import',
  'forward-registration',
  'staged-dependency-unused',
  'checkjs-type-error',
  'upstream-allowlist',
  'add-only',
  'scope',
  'policy-document-missing',
  'lint-ignore-removable',
] as const;

/** A lint rule ID. */
export type LintRuleId = (typeof LINT_RULE_IDS)[number];

const compilerFlag = (name: string): Schema<boolean | undefined, true> =>
  s.boolean().describe(`TypeScript ${name}`).optional();

const compilerOptions = s
  .object({
    strictNullChecks: compilerFlag('strictNullChecks'),
    strictFunctionTypes: compilerFlag('strictFunctionTypes'),
    strictBindCallApply: compilerFlag('strictBindCallApply'),
    noImplicitThis: compilerFlag('noImplicitThis'),
    useUnknownInCatchVariables: compilerFlag('useUnknownInCatchVariables'),
    strictPropertyInitialization: compilerFlag('strictPropertyInitialization'),
    noUnusedLocals: compilerFlag('noUnusedLocals'),
    noUnusedParameters: compilerFlag('noUnusedParameters'),
    paths: s
      .record(s.array(s.string()), {
        key: s.string({ pattern: /^[^*]*\*?[^*]*$/, format: 'a pattern with at most one "*"' }),
      })
      .describe('Module-resolution paths mapping, engine-relative targets')
      .optional(),
  })
  .describe('Per-flag overrides applied after the strict checkJs preset');

const patchLintKeys = {
  checkJs: s.boolean().describe('Type-check owned plain JS modules').default(false),
  checkJsStrict: s
    .boolean()
    .describe('Run checkJs with strict and noImplicitAny; needs checkJs')
    .default(false),
  checkJsCompilerOptions: compilerOptions.optional(),
  checkJsExtraShim: projectPath
    .describe('Project-relative .d.ts added to the Firefox globals shim for checkJs')
    .optional(),
  checkJsTestFiles: s
    .boolean()
    .describe('Also check owned test scripts, each as its own program; needs checkJs')
    .default(false),
  checkJsTestShim: projectPath
    .describe('Project-relative .d.ts of typed harness declarations; needs checkJsTestFiles')
    .optional(),
  litTypes: s
    .boolean()
    .describe('Type Lit in the checkJs shim with closed member lists; needs checkJs')
    .default(false),
  rawColorAllowlist: s
    .array(s.string())
    .describe('Paths (exact or basename) exempt from the raw-color check')
    .optional(),
  fileSizeThresholds: s
    .object({
      general: fileSizeTier('general').describe('Non-test files').optional(),
      test: fileSizeTier('test').describe('Test files').optional(),
    })
    .describe('file-too-large bands per file class, merged over the defaults')
    .optional(),
  fileSizeMetric: s
    .enum(['raw', 'code'])
    .describe('What file-too-large counts: every line, or lines carrying code')
    .default('raw'),
  patchSizeThresholds: s
    .object({
      general: patchSizeTier('general').describe('Patches of general code').optional(),
      test: patchSizeTier('test').describe('Patches of only tests').optional(),
      branding: patchSizeTier('branding').describe('Branding patches').optional(),
    })
    .describe('large-patch-lines and large-patch-files bands per tier, merged over the defaults')
    .optional(),
  patchSizeMetric: s
    .enum(['diff', 'addedCode'])
    .describe('What large-patch-lines counts: every diff line, or added lines carrying code')
    .default('diff'),
  patchSizeRegistrationFiles: s
    .array(text)
    .describe('Globs of registration files neither patch-size rule counts')
    .optional(),
  rules: s
    .record(s.enum(['off', 'notice', 'warning', 'error']), {
      key: s.enum(LINT_RULE_IDS),
    })
    .describe('Severity per rule ID, replacing its default; off disables the rule')
    .optional(),
  undefinedIdentifiers: severity
    .describe('How checkJs reports undefined identifiers')
    .default('warning'),
  tokenScales: s
    .array(tokenScale)
    .describe('CSS property families whose values in created stylesheets must be scale tokens')
    .optional(),
  waivers: s
    .array(
      s.object({
        group: text.describe(
          'Group the waiver applies to: a patch or component name such as "ui-sidebar", or the full group ID'
        ),
        rule: s.enum(LINT_RULE_IDS).describe('Rule waived for the group'),
        max: s
          .int({ min: 0 })
          .describe('Largest measurement still waived; without it the rule is waived at any size')
          .optional(),
        reason: text.describe('Why the waiver exists'),
        share: s
          .enum(['product', 'test'])
          .describe('Share of the group a large-patch-lines ceiling bounds; needs max')
          .optional(),
      })
    )
    .describe('Lint waivers per group of owned changes, beside those a patch manifest carries')
    .optional(),
};

/** Settings that only mean something when another is on. */
const REQUIRES: readonly (readonly [string, (lint: PatchLintConfig) => boolean, string])[] = [
  ['checkJsStrict', (lint) => lint.checkJsStrict && !lint.checkJs, 'checkJs'],
  [
    'checkJsCompilerOptions',
    (lint) => lint.checkJsCompilerOptions !== undefined && !lint.checkJsStrict,
    'checkJsStrict',
  ],
  ['checkJsTestFiles', (lint) => lint.checkJsTestFiles && !lint.checkJs, 'checkJs'],
  [
    'checkJsTestShim',
    (lint) => lint.checkJsTestShim !== undefined && !lint.checkJsTestFiles,
    'checkJsTestFiles',
  ],
  ['litTypes', (lint) => lint.litTypes && !lint.checkJs, 'checkJs'],
];

const patchLintObject = s.object(patchLintKeys);

/** The validated `patchLint` section. */
export type PatchLintConfig = Infer<typeof patchLintObject>;

/** The `patchLint` section. Every key is optional. */
export const patchLintSection = patchLintObject
  .refine((lint) => {
    const unmet = REQUIRES.find(([, broken]) => broken(lint));
    return unmet === undefined ? undefined : `sets ${unmet[0]}, which needs ${unmet[2]}: true`;
  })
  .describe('Quality rules over owned changes');
