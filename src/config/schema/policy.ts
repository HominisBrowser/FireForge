// SPDX-License-Identifier: EUPL-1.2
/**
 * `patchPolicy`: how the patch queue is ordered and named (read by the
 * queue), and which upstream files owned changes may touch and how (read by
 * lint over the owned changes). A `reservedRanges` exception names a group
 * that may change the upstream files it lists outside `upstreamAllowlist`.
 */
import { type Infer, s, type Schema } from '../../kernel/schema.js';
import { positive, projectPath, text, validRegExp } from './common.js';

const category = s.string({
  pattern: /^[a-z][a-z0-9-]*$/,
  format: 'a lowercase category identifier (letters, digits, hyphens)',
});

const regExpSource = s.string().refine(validRegExp);

function bounded<T extends { from: number; to: number }>(schema: Schema<T>): Schema<T> {
  return schema.refine(({ from, to }) =>
    to < from ? `must have "to" (${to}) at or above "from" (${from})` : undefined
  );
}

function disjoint(ranges: readonly { from: number; to: number }[]): string | undefined {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  for (const [index, current] of sorted.entries()) {
    const previous = sorted[index - 1];
    if (previous !== undefined && current.from <= previous.to) {
      return `must not overlap (${previous.from}-${previous.to} overlaps ${current.from}-${current.to})`;
    }
  }
  return undefined;
}

const range = bounded(
  s.object({
    from: positive.describe('Inclusive lower bound'),
    to: positive.describe('Inclusive upper bound'),
    category: category.describe('Category that owns the range'),
  })
);

const reservedRange = bounded(
  s.object({
    from: positive,
    to: positive,
    allowed: s
      .array(
        s.object({
          filename: text.describe('Exact patch filename allowed in the reserved range'),
          files: s.array(s.string()).describe('Exact files the patch may affect').optional(),
          adr: projectPath.describe('Decision record documenting the exception').optional(),
          documentation: projectPath.describe('Documentation of the exception').optional(),
        })
      )
      .describe('The exceptions allowed in the range'),
  })
);

const upstreamEntry = s.object({
  path: text.describe('Engine-relative glob'),
  addOnly: s
    .boolean()
    .describe('Owned changes may only add lines carrying the marker to a matching file')
    .optional(),
  marker: text.describe('Marker an added line must carry; overrides addOnlyMarker').optional(),
  retiredPaths: s
    .array(text, { min: 1 })
    .describe('With addOnly: paths whose registration lines may be removed')
    .optional(),
});

const scopeRule = s.object({
  group: regExpSource.describe(
    'Regular expression over group IDs (patch filenames, component names) the rule scopes'
  ),
  files: s
    .array(text, { min: 1 })
    .describe('Engine-relative globs every file such a group touches must match'),
});

const patchPolicyObject = s.object({
  filenamePattern: regExpSource
    .describe('Regular expression with named captures order, category and slug')
    .optional(),
  requireDescription: s
    .boolean()
    .describe('An empty patch description is a violation')
    .default(false),
  allowGaps: s.boolean().describe('Allow numeric gaps within a category range').default(true),
  mutationMode: s
    .enum(['error', 'warn'])
    .describe('Whether queue operations refuse a policy violation they would add or report it')
    .default('error'),
  ranges: s.array(range, { min: 1 }).refine(disjoint).describe('Order bands owned by categories'),
  reservedRanges: s
    .array(reservedRange)
    .refine(disjoint)
    .describe('Order bands for listed exceptional patches')
    .optional(),
  upstreamAllowlist: s
    .array(s.union(text, upstreamEntry))
    .describe('Globs (or entries) naming the upstream files owned changes may modify')
    .optional(),
  addOnlyMarker: text.describe('Marker for addOnly entries that set none').optional(),
  scopeRules: s
    .array(scopeRule)
    .describe('File scopes per class of group, chosen by group ID')
    .optional(),
  verifyDocumentPaths: s
    .boolean()
    .describe('Require the adr and documentation paths of reserved exceptions to exist')
    .default(false),
});

/** The validated `patchPolicy` section. */
export type PatchPolicyConfig = Infer<typeof patchPolicyObject>;

/** The `patchPolicy` section. */
export const patchPolicySection = patchPolicyObject
  .refine(({ upstreamAllowlist = [], addOnlyMarker }) => {
    for (const [index, entry] of upstreamAllowlist.entries()) {
      if (typeof entry === 'string') continue;
      if (entry.retiredPaths !== undefined && entry.addOnly !== true) {
        return `sets retiredPaths on upstreamAllowlist[${index}], which applies only with addOnly: true`;
      }
      if (entry.addOnly === true && entry.marker === undefined && addOnlyMarker === undefined) {
        return `sets addOnly on upstreamAllowlist[${index}] without a marker: set its marker or addOnlyMarker`;
      }
    }
    return undefined;
  })
  .describe('Patch queue ordering and upstream-touch policy');
