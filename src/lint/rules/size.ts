// SPDX-License-Identifier: EUPL-1.2
/**
 * Size rules. `file-too-large` holds every created JavaScript file to the
 * bands of its class; `large-patch-lines` and `large-patch-files` hold every
 * group's own steps to the bands of its tier. Lines are counted the way
 * `wc -l` counts them, or as code lines (non-blank once comments are
 * blanked) under the `code` / `addedCode` metrics.
 */
import {
  fileSizeBands,
  patchSizeBands,
  type PatchSizeTier,
  type SizeBands,
} from '../../config/index.js';
import type { FileDiff } from '../../diff/index.js';
import { matchesGlob } from '../../kernel/glob.js';
import type { OwnedChange } from '../../project/index.js';
import { textContent } from '../../project/index.js';
import { blankCssComments, blankJsCommentsParsed, fragmentExpansions } from '../../syntax/index.js';
import { type Draft, isJsFile, isTestFile, type Rule, type RuleContext } from '../rule.js';

type Band = 'notice' | 'warning' | 'error';

function bandOf(count: number, bands: SizeBands): Band | undefined {
  if (bands.error !== null && count > bands.error) return 'error';
  if (count > bands.warning) return 'warning';
  if (count > bands.notice) return 'notice';
  return undefined;
}

function lines(text: string): string[] {
  const split = text.split('\n');
  if (split.at(-1) === '') split.pop();
  return split;
}

const blank = (line: string): boolean => line.trim() === '';

const MARKUP = /\.(?:x?html|xml|svg|xul|dtd)$/;
const HASH_COMMENTS =
  /(?:\.(?:ftl|properties|toml|ini|mn|build|py|conf|configure|sh|ya?ml|in|cfg|mozbuild)|(?:^|\/)(?:Makefile|mozconfig))$/;
/** Lines inside an expanded component fragment: a copy of shared CSS, not this file's code. */
function fragmentLines(css: string[]): boolean[] {
  const mask = css.map(() => false);
  for (const [start, end] of fragmentExpansions(css)) mask.fill(true, start, end + 1);
  return mask;
}

/**
 * Which lines of a file carry code, by file kind: JavaScript through acorn,
 * CSS block comments (and fragment expansions), `<!-- -->` in markup, and
 * whole-line `#` comments (`;` in `.ini`/`.in`, `!` in `.properties`) in
 * Fluent, manifests and build files. Any other file counts every non-blank
 * line. JavaScript acorn cannot tokenize counts every non-blank line and is
 * reported as not parsed.
 *
 * @param path - Engine-relative path, which picks the kind
 * @param text - The content
 */
export function codeLines(path: string, text: string): { code: boolean[]; parsed: boolean } {
  if (/\.(?:m?js|jsm|cjs)$/.test(path)) {
    const blanked = blankJsCommentsParsed(text);
    return {
      code: (blanked ?? text).split('\n').map((line) => !blank(line)),
      parsed: blanked !== undefined,
    };
  }
  if (path.endsWith('.css')) {
    const fragments = fragmentLines(text.split('\n'));
    const code = blankCssComments(text)
      .split('\n')
      .map((line, i) => !blank(line) && fragments[i] !== true);
    return { code, parsed: true };
  }
  if (MARKUP.test(path)) {
    const blanked = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' '));
    return { code: blanked.split('\n').map((line) => !blank(line)), parsed: true };
  }
  const comment = HASH_COMMENTS.test(path)
    ? /\.(?:ini|in)$/.test(path)
      ? /^\s*[#;]/
      : path.endsWith('.properties')
        ? /^\s*[#!]/
        : /^\s*#/
    : undefined;
  return {
    code: text.split('\n').map((line) => !blank(line) && comment?.test(line) !== true),
    parsed: true,
  };
}

const fileTooLarge: Rule = {
  id: 'file-too-large',
  severity: 'warning',
  description: 'Created JavaScript files stay under the size bands of their class',
  check(context) {
    const thresholds = context.config.patchLint.fileSizeThresholds;
    const byCode = context.config.patchLint.fileSizeMetric === 'code';
    const drafts: Draft[] = [];
    for (const file of context.owned.all()) {
      if (!file.created || !isJsFile(file.path) || file.text === undefined) continue;
      if (!context.selected(file.path)) continue;
      let count = lines(file.text).length;
      let unit = 'lines';
      if (byCode) {
        const counted = codeLines(file.path, file.text);
        if (counted.parsed) {
          count = lines(file.text).filter((_, i) => counted.code[i] === true).length;
          unit = 'code lines';
        } else {
          drafts.push({
            path: file.path,
            group: file.group,
            severity: 'notice',
            message: `The file did not tokenize, so its ${count} raw lines were counted instead of code lines.`,
          });
        }
      }
      const test = isTestFile(file.path);
      const bands = fileSizeBands(
        test ? 'test' : 'general',
        thresholds?.[test ? 'test' : 'general']
      );
      const band = bandOf(count, bands);
      if (band === undefined) continue;
      drafts.push({
        path: file.path,
        group: file.group,
        severity: band,
        measurement: count,
        message: sizeMessage(`${test ? 'Test file' : 'File'} has ${count} ${unit}`, band, bands, {
          key: 'patchLint.fileSizeThresholds',
          advice: test ? 'Consider splitting it by subject.' : 'Consider decomposing it.',
        }),
      });
    }
    return drafts;
  },
};

/**
 * A size finding's message: what each band means for a gate. A notice is
 * over the design target and advisory; a warning fails a zero-warning gate,
 * so it names the threshold key; an error asks for the split.
 */
function sizeMessage(
  subject: string,
  band: Band,
  bands: SizeBands,
  how: { key: string; advice: string }
): string {
  const limits = `warning threshold ${bands.warning}${bands.error === null ? '' : `, error threshold ${bands.error}`}`;
  if (band === 'error') return `${subject} (error threshold ${bands.error ?? ''}). ${how.advice}`;
  if (band === 'notice') {
    return `${subject}, over the design target of ${bands.notice} (${limits}). Advisory; does not fail --max-warnings 0.`;
  }
  return (
    `${subject} (${limits}). A warning fails a gate run with --max-warnings 0; tune "${how.key}" ` +
    `if these limits are wrong for this project. ${how.advice}`
  );
}

/** Paths a branding group may touch besides `browser/branding/` to register the flavour. */
const BRANDING_SIBLINGS: ReadonlySet<string> = new Set([
  'browser/moz.configure',
  'browser/confvars.sh',
]);

/**
 * The tier a group is held to: `test` when every file is a test (which wins
 * over branding), `branding` when the group declares it or every file sits
 * under `browser/branding/` or is a registration sibling, else `general`.
 *
 * @param paths - The group's files
 * @param declared - The group's declared tier
 */
export function groupTier(paths: readonly string[], declared?: 'branding'): PatchSizeTier {
  if (paths.length > 0 && paths.every(isTestFile)) return 'test';
  if (declared === 'branding') return 'branding';
  const branding =
    paths.some((path) => path.startsWith('browser/branding/')) &&
    paths.every((path) => path.startsWith('browser/branding/') || BRANDING_SIBLINGS.has(path));
  return branding ? 'branding' : 'general';
}

/** What a group measures under the configured metric. */
export interface GroupSize {
  readonly tier: PatchSizeTier;
  readonly addedCode: boolean;
  /** Counted lines, registration files left out. */
  readonly lines: number;
  /** Of `lines`, those in test files; only `addedCode` attributes lines per file. */
  readonly testLines: number;
  readonly files: number;
  readonly registrationFiles: number;
}

function diffLineCount(diff: FileDiff | undefined): number {
  if (diff === undefined) return 0;
  if (diff.binary !== undefined) return diff.header.length;
  return diff.hunks.reduce(
    (sum, hunk) => sum + 1 + hunk.lines.length + hunk.trailing.length,
    diff.header.length
  );
}

async function addedCodeLines(context: RuleContext, step: OwnedChange): Promise<number> {
  if (step.kind === 'delete' || step.binary) return 0;
  const text = textContent(await step.after());
  const mask = text === undefined ? undefined : codeLines(step.path, text).code;
  const added = await context.owned.added(step);
  return added.filter((entry) => (mask ? mask[entry.line - 1] === true : !blank(entry.text)))
    .length;
}

/**
 * Measures one group's own steps: under `diff`, the lines of its unified
 * diff (a binary section counts its header); under `addedCode`, the added
 * lines that carry code in each step's result. Files matching
 * `patchSizeRegistrationFiles` count toward neither number.
 *
 * @param context - The rule context
 * @param groupId - The group
 */
async function measureGroup(context: RuleContext, groupId: string): Promise<GroupSize> {
  const globs = context.config.patchLint.patchSizeRegistrationFiles ?? [];
  const steps = context.changes.inGroup(groupId);
  const registration = (path: string): boolean =>
    globs.some((glob) => matchesGlob(path, glob, { basename: true }));
  const counted = steps.filter((step) => !registration(step.path));
  const addedCode = context.config.patchLint.patchSizeMetric === 'addedCode';
  let lineCount = 0;
  let testLines = 0;
  for (const step of counted) {
    const stepLines = addedCode
      ? await addedCodeLines(context, step)
      : diffLineCount(await context.owned.diff(step));
    lineCount += stepLines;
    if (addedCode && isTestFile(step.path)) testLines += stepLines;
  }
  return {
    tier: groupTier(
      steps.map((step) => step.path),
      context.changes.group(groupId)?.tier
    ),
    addedCode,
    lines: lineCount,
    testLines,
    files: counted.length,
    registrationFiles: steps.length - counted.length,
  };
}

const SPLIT_ADVICE = 'Consider splitting it into smaller, focused groups.';

function lineChecks(
  size: GroupSize,
  thresholds: { lines: SizeBands; files: SizeBands },
  testBands: SizeBands
): { count: number; bands: SizeBands; subject: string; share?: 'product' | 'test' }[] {
  if (!size.addedCode)
    return [{ count: size.lines, bands: thresholds.lines, subject: `is ${size.lines} diff lines` }];
  if (size.tier !== 'general') {
    return [
      { count: size.lines, bands: thresholds.lines, subject: `adds ${size.lines} code lines` },
    ];
  }
  const product = size.lines - size.testLines;
  const checks: { count: number; bands: SizeBands; subject: string; share?: 'product' | 'test' }[] =
    [
      {
        count: product,
        bands: thresholds.lines,
        subject: `adds ${product} code lines${size.testLines > 0 ? ' in non-test files' : ''}`,
        share: 'product',
      },
    ];
  if (size.testLines > 0) {
    checks.push({
      count: size.testLines,
      bands: testBands,
      subject: `adds ${size.testLines} code lines in test files (test tier)`,
      share: 'test',
    });
  }
  return checks;
}

function patchSizeRule(id: 'large-patch-lines' | 'large-patch-files'): Rule {
  return {
    id,
    severity: 'warning',
    description:
      id === 'large-patch-lines'
        ? "A group's own lines stay under the size bands of its tier"
        : "A group's file count stays under the bands of its tier",
    async check(context) {
      const overrides = context.config.patchLint.patchSizeThresholds;
      const drafts: Draft[] = [];
      for (const group of context.changes.groups) {
        if (group.sized === false) continue;
        const size = await measureGroup(context, group.id);
        const thresholds = patchSizeBands(size.tier, overrides?.[size.tier]);
        const key = { key: 'patchLint.patchSizeThresholds', advice: SPLIT_ADVICE };
        if (id === 'large-patch-files') {
          const band = bandOf(size.files, thresholds.files);
          if (band === undefined) continue;
          const excluded =
            size.registrationFiles > 0
              ? ` (not counting ${size.registrationFiles} registration file(s))`
              : '';
          drafts.push({
            group: group.id,
            severity: band,
            measurement: size.files,
            message: sizeMessage(
              `Group touches ${size.files} files${excluded}`,
              band,
              thresholds.files,
              key
            ),
          });
          continue;
        }
        const testBands = patchSizeBands('test', overrides?.test).lines;
        for (const check of lineChecks(size, thresholds, testBands)) {
          const band = bandOf(check.count, check.bands);
          if (band === undefined) continue;
          drafts.push({
            group: group.id,
            severity: band,
            measurement: check.count,
            ...(check.share === undefined ? {} : { share: check.share }),
            message: sizeMessage(`Group ${check.subject}`, band, check.bands, key),
          });
        }
      }
      return drafts;
    },
  };
}

/** The size rules. */
export const sizeRules: readonly Rule[] = [
  fileTooLarge,
  patchSizeRule('large-patch-lines'),
  patchSizeRule('large-patch-files'),
];
