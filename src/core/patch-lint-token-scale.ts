// SPDX-License-Identifier: EUPL-1.2
/**
 * `token-scale`: values of governed CSS properties must resolve to a token
 * on the property's scale (`patchLint.tokenScales`).
 *
 * The raw-colour and token-prefix rules stop a patch from inventing colours
 * or referencing foreign custom properties, but say nothing about
 * `gap: 7px`, `font-size: 13px` or `z-index: 9999`. Those are the values a
 * design scale exists to remove, and without a rule they drift back one
 * literal at a time. A scale names its properties, the token prefix (or
 * prefixes) that defines its steps, and the literals that are not steps at
 * all (`0`, `auto`, a percentage).
 *
 * Judged per value atom, after peeling `var()` innermost-first so a fallback
 * is held to the same scale as the token it backs: `var(--x-gap, 7px)` is a
 * literal in disguise. `calc()`, `min()`, `max()` and `clamp()` are
 * transparent, so a value built from tokens passes and one that adds a raw
 * length does not. Inside them, `allowInCalc` names literals legal only
 * there (a unitless multiplier), and `offsetCap` lets a declaration
 * subtract a few px from a token (a border inset) without allowing the px
 * value anywhere else.
 *
 * Declarations inside descriptor at-rules (`@font-face`, `@counter-style`,
 * `@property`, `@page`, …) are not property declarations and are not
 * judged: `font-weight` in `@font-face` names a face, not a type step.
 *
 * Runs over CSS files the patch creates, not files it modifies: an upstream
 * stylesheet is not the fork's to put on a scale. A file a scale `exclude`s
 * is not judged against that scale. A line carrying
 * `fireforge-ignore: token-scale` is skipped. A scale with `minFiles` also
 * fails the queue (`token-scale-vacuous`) when fewer created files carry
 * its properties, so an emptied scan set cannot pass by judging nothing.
 */

import type { PatchLintIssue } from '../types/commands/index.js';
import type { PatchLintTokenScale } from '../types/config.js';
import { matchesAnyGlob } from '../utils/path-glob.js';
import { escapeRegex } from '../utils/regex.js';

const IGNORE_MARKER = 'fireforge-ignore: token-scale';

/** CSS-wide keywords: never a step on any scale, always legal. */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

const TOKEN_PLACEHOLDER = '\u0000token\u0000';

const MATH_FUNCTION = /^(?:calc|min|max|clamp)$/i;

const OPERATORS = new Set(['+', '-', '*', '/']);

/**
 * At-rules whose blocks hold descriptors, not property declarations. A
 * block nested in one (an `@page` margin box, a `@font-feature-values`
 * feature block) is a descriptor block too.
 */
const DESCRIPTOR_AT_RULE =
  /^@(?:font-face|counter-style|property|font-feature-values|font-palette-values|page|view-transition)\b/i;

/** Exact name, or a `*`-suffixed prefix. */
function matchesName(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
  );
}

function matchesLiteral(atom: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`).test(atom)
  );
}

/** The scale's token prefixes, whether configured as one or a list. */
function scalePrefixes(scale: PatchLintTokenScale): string[] {
  return typeof scale.prefix === 'string' ? [scale.prefix] : scale.prefix;
}

/** The scale as a message names it: `--x-space-*`, or `--x-space-* / --x-gap-*`. */
function scaleLabel(scale: PatchLintTokenScale): string {
  return scalePrefixes(scale)
    .map((prefix) => `${prefix}*`)
    .join(' / ');
}

interface ValueAtom {
  text: string;
  /** Inside a `calc()`, `min()`, `max()` or `clamp()`. */
  inMath: boolean;
}

/**
 * Splits a value into atoms, keeping operators as atoms and noting which
 * atoms sit inside a math function. A math function's name is dropped; any
 * other function's name stays an atom, judged like a literal.
 */
function valueAtoms(value: string): ValueAtom[] {
  const atoms: ValueAtom[] = [];
  const mathStack: boolean[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') atoms.push({ text: current, inMath: mathStack.includes(true) });
    current = '';
  };
  for (const char of value) {
    if (char === '(') {
      const isMath = MATH_FUNCTION.test(current);
      if (isMath) current = '';
      else flush();
      mathStack.push(isMath);
    } else if (char === ')') {
      flush();
      mathStack.pop();
    } else if (char === '*' || char === '/') {
      flush();
      atoms.push({ text: char, inMath: mathStack.includes(true) });
    } else if (char === ',' || /\s/.test(char)) {
      flush();
    } else {
      current += char;
    }
  }
  flush();
  return atoms;
}

const PX_LITERAL = /^(\d*\.?\d+)px$/;

/**
 * Returns the first atom of `value` that is off `scale`, or undefined when
 * every atom resolves to the scale.
 */
export function findOffScaleAtom(value: string, scale: PatchLintTokenScale): string | undefined {
  let rest = value.replace(/!\s*important\s*$/i, '');
  const prefixes = scalePrefixes(scale);
  const varPattern = /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/;
  for (let match = varPattern.exec(rest); match !== null; match = varPattern.exec(rest)) {
    const name = match[1] ?? '';
    const onScale = prefixes.some((prefix) => name.startsWith(prefix));
    if (!onScale && !matchesName(name, scale.allow ?? [])) {
      return `var(${name})`;
    }
    const fallback = match[2];
    if (fallback !== undefined && fallback.trim() !== '') {
      const offending = findOffScaleAtom(fallback, scale);
      if (offending !== undefined) return offending;
    }
    rest = `${rest.slice(0, match.index)} ${TOKEN_PLACEHOLDER} ${rest.slice(match.index + match[0].length)}`;
  }
  const atoms = valueAtoms(rest);
  // A px offset subtracted from a token (`token - 1px`, `token - 1px - 1px`)
  // counts toward `offsetCap`, summed over the declaration.
  let offsetTotal = 0;
  let lastOffsetIndex = -1;
  for (const [index, atom] of atoms.entries()) {
    if (OPERATORS.has(atom.text) || atom.text === TOKEN_PLACEHOLDER) continue;
    if (CSS_WIDE_KEYWORDS.has(atom.text.toLowerCase())) continue;
    if (matchesLiteral(atom.text, scale.allowLiterals ?? [])) continue;
    if (atom.inMath && matchesLiteral(atom.text, scale.allowInCalc ?? [])) continue;
    const px = PX_LITERAL.exec(atom.text);
    if (atom.inMath && px !== null && scale.offsetCap !== undefined) {
      const subtrahendOf = atoms[index - 2]?.text;
      const subtracted =
        atoms[index - 1]?.text === '-' &&
        (subtrahendOf === TOKEN_PLACEHOLDER || lastOffsetIndex === index - 2);
      if (subtracted) {
        offsetTotal += Number(px[1]);
        lastOffsetIndex = index;
        if (offsetTotal <= scale.offsetCap) continue;
      }
    }
    return atom.text;
  }
  return undefined;
}

/** Blanks block comments, keeping newlines so offsets map to lines. */
function maskComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * Blanks the contents of descriptor at-rule blocks (keeping braces and
 * newlines), so the declaration scan never sees their descriptors.
 */
function maskDescriptorBlocks(css: string): string {
  const out = css.split('');
  const stack: boolean[] = [];
  let preludeStart = 0;
  for (let i = 0; i < css.length; i++) {
    const char = css.charAt(i);
    const inDescriptor = stack[stack.length - 1] === true;
    if (char === '{') {
      const prelude = css.slice(preludeStart, i).trim();
      stack.push(inDescriptor || DESCRIPTOR_AT_RULE.test(prelude));
      preludeStart = i + 1;
    } else if (char === '}') {
      stack.pop();
      preludeStart = i + 1;
    } else if (char === ';') {
      preludeStart = i + 1;
    }
    if (inDescriptor && char !== '\n' && char !== '{' && char !== '}') out[i] = ' ';
  }
  return out.join('');
}

interface Declaration {
  property: string;
  value: string;
  /** 1-based line of the property name. */
  line: number;
}

/** Every property declaration of a stylesheet, descriptors and comments left out. */
function scanDeclarations(css: string): Declaration[] {
  const masked = maskDescriptorBlocks(maskComments(css));
  const declarations: Declaration[] = [];
  const pattern = /(^|[{;\s])([a-zA-Z][a-zA-Z-]*)\s*:\s*([^;{}]*)/g;
  for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
    const start = match.index + (match[1] ?? '').length;
    declarations.push({
      property: (match[2] ?? '').toLowerCase(),
      value: (match[3] ?? '').trim(),
      line: masked.slice(0, start).split('\n').length,
    });
  }
  return declarations;
}

/** The scales that govern `file`: those that do not `exclude` it. */
function scalesFor(
  file: string,
  scales: readonly PatchLintTokenScale[]
): readonly PatchLintTokenScale[] {
  return scales.filter((scale) => !matchesAnyGlob(file, scale.exclude ?? []));
}

/**
 * Lints one patch-created CSS file against the configured scales.
 *
 * @param file - Engine-relative path, for the issue and the `exclude` globs
 * @param css - The file's full content
 * @param scales - `patchLint.tokenScales`
 * @returns One `token-scale` error per off-scale declaration
 */
export function lintTokenScales(
  file: string,
  css: string,
  scales: readonly PatchLintTokenScale[]
): PatchLintIssue[] {
  const governing = scalesFor(file, scales);
  if (governing.length === 0) return [];
  const rawLines = css.split('\n');
  const issues: PatchLintIssue[] = [];
  for (const { property, value, line } of scanDeclarations(css)) {
    const scale = governing.find((candidate) => matchesName(property, candidate.properties));
    if (scale === undefined || value === '') continue;
    if ((rawLines[line - 1] ?? '').includes(IGNORE_MARKER)) continue;
    const atom = findOffScaleAtom(value, scale);
    if (atom === undefined) continue;
    const label = scaleLabel(scale);
    issues.push({
      file,
      check: 'token-scale',
      fingerprint: `token-scale:${file}:${property}:${value}`,
      message:
        `Line ${String(line)}: ${property}: ${value} is off the ${label} scale ` +
        `("${atom}"). Use a ${label} token, or list a reviewed exception in ` +
        `patchLint.tokenScales (allowLiterals / allowInCalc / allow) or mark the line "${IGNORE_MARKER}".`,
      severity: 'error',
    });
  }
  return issues;
}

/**
 * The `minFiles` floor of every scale over the queue's created stylesheets:
 * one `token-scale-vacuous` error per scale that fewer created CSS files
 * (outside its `exclude`) carry a declaration of.
 *
 * @param createdFiles - Every patch-created file's path and content
 * @param scales - `patchLint.tokenScales`
 */
export function lintTokenScaleFloors(
  createdFiles: Iterable<readonly [string, string]>,
  scales: readonly PatchLintTokenScale[]
): PatchLintIssue[] {
  const floored = scales.filter((scale) => scale.minFiles !== undefined);
  if (floored.length === 0) return [];
  const counts = new Map<PatchLintTokenScale, number>(floored.map((scale) => [scale, 0]));
  for (const [file, content] of createdFiles) {
    if (!file.endsWith('.css')) continue;
    const properties = new Set(scanDeclarations(content).map((entry) => entry.property));
    for (const scale of scalesFor(file, floored)) {
      if ([...properties].some((property) => matchesName(property, scale.properties))) {
        counts.set(scale, (counts.get(scale) ?? 0) + 1);
      }
    }
  }
  const issues: PatchLintIssue[] = [];
  for (const [scale, count] of counts) {
    const floor = scale.minFiles ?? 0;
    if (count >= floor) continue;
    const label = scaleLabel(scale);
    issues.push({
      file: 'fireforge.json',
      check: 'token-scale-vacuous',
      fingerprint: `token-scale-vacuous:${label}`,
      message:
        `The ${label} scale governs ${String(count)} patch-created stylesheet(s), under its ` +
        `minFiles ${String(floor)}. A scale that judges nothing passes vacuously: check its ` +
        'properties and exclude globs, or lower minFiles after a reviewed move.',
      severity: 'error',
    });
  }
  return issues;
}
