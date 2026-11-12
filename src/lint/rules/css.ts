// SPDX-License-Identifier: EUPL-1.2
/**
 * Stylesheet rules: no raw colours on the lines owned changes add, custom
 * properties from the design tokens, and token scales over the stylesheets
 * the project creates.
 *
 * A scale names CSS properties, the token prefixes that are its steps, and
 * the literals that are no step at all (`0`, `auto`, a percentage). A value
 * is judged per atom after peeling `var()` innermost-first, so a fallback is
 * held to the same scale as the token it backs. `calc()`, `min()`, `max()`
 * and `clamp()` are transparent; inside them `allowInCalc` literals are
 * legal and `offsetCap` px may be subtracted from a token. Declarations in
 * descriptor at-rules (`@font-face`, `@property`, `@page`, ...) are not
 * property declarations and are not judged.
 */
import { matchesPropertyName, type PatchLintConfig } from '../../config/index.js';
import { matchesAnyGlob } from '../../kernel/glob.js';
import { escapeRegExp } from '../../kernel/text.js';
import { type CssBlock, foreignVariables, parseCss, rawColors } from '../../syntax/index.js';
import type { OwnedFile } from '../input.js';
import type { Draft, Rule, RuleContext } from '../rule.js';

type TokenScale = NonNullable<PatchLintConfig['tokenScales']>[number];

function cssFiles(context: RuleContext, accept: (file: OwnedFile) => boolean): OwnedFile[] {
  return context.owned
    .all()
    .filter(
      (file) =>
        file.path.endsWith('.css') &&
        file.text !== undefined &&
        context.selected(file.path) &&
        accept(file)
    );
}

/**
 * The 1-based lines of a stylesheet the content rules judge: every line of
 * a created file, the added lines of a modified one. The file is parsed
 * whole, so a comment opened on an unchanged line still hides what it covers.
 */
async function scannedLines(
  context: RuleContext,
  file: OwnedFile
): Promise<(line: number) => boolean> {
  if (file.created) return () => true;
  const added = new Set((await context.owned.added(file.change)).map((entry) => entry.line));
  return (line) => added.has(line);
}

const rawColor: Rule = {
  id: 'raw-color-value',
  severity: 'error',
  description: 'Owned stylesheet lines use custom properties instead of raw colours',
  async check(context) {
    const allowlist = context.config.patchLint.rawColorAllowlist ?? [];
    const drafts: Draft[] = [];
    const exempt = (path: string): boolean =>
      path.startsWith('browser/branding/') ||
      allowlist.some((entry) => path === entry || path.endsWith(`/${entry}`));
    const judged = (candidate: OwnedFile): boolean =>
      !exempt(candidate.path) && !context.component(candidate.path);
    for (const file of cssFiles(context, judged)) {
      const scanned = await scannedLines(context, file);
      const hit = rawColors(parseCss(file.text ?? '')).find((color) => scanned(color.line + 1));
      if (hit === undefined) continue;
      drafts.push({
        path: file.path,
        line: hit.line + 1,
        group: file.group,
        message: 'Raw colour value. Use a CSS custom property (var(--...)) from the design tokens.',
      });
    }
    return drafts;
  },
};

const tokenPrefix: Rule = {
  id: 'token-prefix-violation',
  severity: 'error',
  description: 'Custom properties an owned stylesheet references are design tokens',
  async check(context) {
    const tokens = context.tokens;
    if (tokens === undefined) return [];
    const accepted = new Set([...tokens.allowlist, ...tokens.runtimeVariables]);
    const drafts: Draft[] = [];
    for (const file of cssFiles(context, (candidate) => !context.component(candidate.path))) {
      const scanned = await scannedLines(context, file);
      const flagged = new Set<string>();
      for (const { name, line } of foreignVariables(
        parseCss(file.text ?? ''),
        tokens.prefix,
        accepted
      )) {
        if (!scanned(line + 1) || flagged.has(name)) continue;
        flagged.add(name);
        drafts.push({
          path: file.path,
          line: line + 1,
          group: file.group,
          message:
            `var(${name}) does not have the token prefix "${tokens.prefix}". Use a design token, ` +
            'add it to tokenAllowlist, or list a runtime state channel in runtimeVariables.',
        });
      }
    }
    return drafts;
  },
};

const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const TOKEN = '\u0000token\u0000';
const MATH_FUNCTION = /^(?:calc|min|max|clamp)$/i;
const OPERATORS = new Set(['+', '-', '*', '/']);
const PX_LITERAL = /^(\d*\.?\d+)px$/;
const DESCRIPTOR_AT_RULE =
  /^@(?:font-face|counter-style|property|font-feature-values|font-palette-values|page|view-transition)\b/i;

function prefixesOf(scale: TokenScale): string[] {
  return typeof scale.prefix === 'string' ? [scale.prefix] : scale.prefix;
}

function scaleLabel(scale: TokenScale): string {
  return prefixesOf(scale)
    .map((prefix) => `${prefix}*`)
    .join(' / ');
}

function matchesLiteral(atom: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(atom)
  );
}

/** A value split into atoms (operators kept), each marked when inside a math function. */
function valueAtoms(value: string): { text: string; inMath: boolean }[] {
  const atoms: { text: string; inMath: boolean }[] = [];
  const math: boolean[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') atoms.push({ text: current, inMath: math.includes(true) });
    current = '';
  };
  for (const char of value) {
    if (char === '(') {
      const isMath = MATH_FUNCTION.test(current);
      if (isMath) current = '';
      else flush();
      math.push(isMath);
    } else if (char === ')') {
      flush();
      math.pop();
    } else if (char === '*' || char === '/') {
      flush();
      atoms.push({ text: char, inMath: math.includes(true) });
    } else if (char === ',' || /\s/.test(char)) {
      flush();
    } else {
      current += char;
    }
  }
  flush();
  return atoms;
}

/**
 * The first atom of a value that is off a scale, or undefined when every
 * atom resolves to it.
 *
 * @param value - The declaration value
 * @param scale - The scale
 */
export function offScaleAtom(value: string, scale: TokenScale): string | undefined {
  let rest = value.replace(/!\s*important\s*$/i, '');
  const prefixes = prefixesOf(scale);
  const variable = /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/;
  for (let match = variable.exec(rest); match !== null; match = variable.exec(rest)) {
    const name = match[1] ?? '';
    const onScale = prefixes.some((prefix) => name.startsWith(prefix));
    if (!onScale && !matchesPropertyName(name, scale.allow ?? [])) return `var(${name})`;
    const fallback = match[2]?.trim() ?? '';
    const offending = fallback === '' ? undefined : offScaleAtom(fallback, scale);
    if (offending !== undefined) return offending;
    rest = `${rest.slice(0, match.index)} ${TOKEN} ${rest.slice(match.index + match[0].length)}`;
  }
  return offScaleLiteral(valueAtoms(rest), scale);
}

/**
 * The first atom (tokens already replaced) no scale rule accepts. A px
 * offset subtracted from a token, or chained after such an offset, counts
 * toward `offsetCap`, summed over the declaration.
 */
function offScaleLiteral(
  atoms: readonly { text: string; inMath: boolean }[],
  scale: TokenScale
): string | undefined {
  let offsetTotal = 0;
  let lastOffset = -1;
  for (const [index, atom] of atoms.entries()) {
    if (OPERATORS.has(atom.text) || atom.text === TOKEN) continue;
    if (CSS_WIDE_KEYWORDS.has(atom.text.toLowerCase())) continue;
    if (matchesLiteral(atom.text, scale.allowLiterals ?? [])) continue;
    if (atom.inMath && matchesLiteral(atom.text, scale.allowInCalc ?? [])) continue;
    const px = atom.inMath && scale.offsetCap !== undefined ? PX_LITERAL.exec(atom.text) : null;
    const subtracted =
      px !== null &&
      atoms[index - 1]?.text === '-' &&
      (atoms[index - 2]?.text === TOKEN || lastOffset === index - 2);
    if (subtracted) {
      offsetTotal += Number(px[1]);
      lastOffset = index;
      if (offsetTotal <= (scale.offsetCap ?? 0)) continue;
    }
    return atom.text;
  }
  return undefined;
}

function inDescriptor(block: CssBlock | undefined): boolean {
  for (let at = block; at !== undefined; at = at.parent) {
    if (DESCRIPTOR_AT_RULE.test(at.selector)) return true;
  }
  return false;
}

/**
 * Every property declaration of a stylesheet outside descriptor blocks,
 * the property lower-cased, with its 1-based line. Custom properties are
 * not properties a scale governs.
 *
 * @param css - Stylesheet text
 */
export function cssDeclarations(css: string): { property: string; value: string; line: number }[] {
  return parseCss(css)
    .declarations.filter(
      (declaration) => !declaration.name.startsWith('--') && !inDescriptor(declaration.block)
    )
    .map((declaration) => ({
      property: declaration.name.toLowerCase(),
      value: declaration.value,
      line: declaration.line + 1,
    }));
}

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

function scalesFor(path: string, scales: readonly TokenScale[]): TokenScale[] {
  return scales.filter((scale) => !matchesAnyGlob(path, scale.exclude ?? []));
}

const tokenScale: Rule = {
  id: 'token-scale',
  severity: 'error',
  description: 'Governed properties in created stylesheets resolve to their token scale',
  check(context) {
    const scales = context.config.patchLint.tokenScales ?? [];
    if (scales.length === 0) return [];
    return cssFiles(context, (file) => file.created).flatMap((file) => {
      const governing = scalesFor(file.path, scales);
      return cssDeclarations(file.text ?? '').flatMap(({ property, value, line }): Draft[] => {
        const scale = governing.find((candidate) =>
          matchesPropertyName(property, candidate.properties)
        );
        if (scale === undefined || value === '') return [];
        const allowed = (scale.allowValues ?? []).some(
          (entry) =>
            entry.property.toLowerCase() === property && collapse(entry.value) === collapse(value)
        );
        const atom = allowed ? undefined : offScaleAtom(value, scale);
        if (atom === undefined) return [];
        const label = scaleLabel(scale);
        return [
          {
            path: file.path,
            line,
            group: file.group,
            message:
              `${property}: ${value} is off the ${label} scale ("${atom}"). Use a ${label} token, ` +
              'or list a reviewed exception in patchLint.tokenScales (allowLiterals, allowInCalc, ' +
              'allow, allowValues).',
          },
        ];
      });
    });
  },
};

const vacuousScale: Rule = {
  id: 'token-scale-vacuous',
  severity: 'error',
  description: 'A scale with minFiles governs at least that many created stylesheets',
  check(context) {
    const floored = (context.config.patchLint.tokenScales ?? []).filter(
      (scale) => scale.minFiles !== undefined
    );
    const counts = new Map(floored.map((scale) => [scale, 0]));
    for (const file of context.owned.all()) {
      if (!file.created || !file.path.endsWith('.css') || file.text === undefined) continue;
      const properties = cssDeclarations(file.text).map((entry) => entry.property);
      for (const scale of scalesFor(file.path, floored)) {
        if (properties.some((property) => matchesPropertyName(property, scale.properties))) {
          counts.set(scale, (counts.get(scale) ?? 0) + 1);
        }
      }
    }
    return [...counts]
      .filter(([scale, count]) => count < (scale.minFiles ?? 0))
      .map(([scale, count]) => ({
        message:
          `The ${scaleLabel(scale)} scale governs ${count} created stylesheet(s), under its ` +
          `minFiles ${scale.minFiles ?? 0}. A scale that judges nothing passes vacuously: check ` +
          'its properties and exclude globs, or lower minFiles after a reviewed move.',
      }));
  },
};

const staleExclude: Rule = {
  id: 'stale-token-scale-exclude',
  severity: 'warning',
  description: 'Every token-scale exclude names an owned path',
  check(context) {
    const owned = context.changes.net().map((change) => change.path);
    return (context.config.patchLint.tokenScales ?? []).flatMap((scale, index) =>
      (scale.exclude ?? [])
        .filter((glob) => !owned.some((path) => matchesAnyGlob(path, [glob])))
        .map((glob) => ({
          message: `Token scale ${index + 1} excludes ${glob}, which matches no owned path. Remove the retired exception.`,
        }))
    );
  },
};

/** The stylesheet rules. */
export const cssRules: readonly Rule[] = [
  rawColor,
  tokenPrefix,
  tokenScale,
  vacuousScale,
  staleExclude,
];
