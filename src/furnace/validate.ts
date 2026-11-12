// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace validate`: the rules a component's sources must meet. Each rule
 * is one row of {@link RULES}: a check name (what `validationExceptions`
 * and the output use), a severity, and a test over the facts of one
 * component. Project-wide checks (the component floor, typing files,
 * deployment) follow, then the reviewed exceptions of `furnace.json` are
 * applied: an exception suppresses a warning, never an error, and an
 * exception that matches nothing is itself a warning.
 *
 * Accessibility rules read the composed component: the host `<tag>.mjs`
 * and its companion modules (`<tag>-*.mjs`, tests and stories excluded) as
 * one source, so moving a template between modules changes nothing.
 * `hardcoded-text` judges each module alone and names the files, so an
 * exception can accept one module. The checks are heuristics over source
 * text; a `// furnace-ignore: hardcoded-text` comment exempts a module.
 */
import { join } from 'node:path';

import { listDir, readTextIfExists } from '../kernel/fs.js';
import { escapeRegExp } from '../kernel/text.js';
import type { TrackedFiles } from '../project/index.js';
import {
  blankCssComments,
  cssVarReferences,
  foreignVariables,
  fragmentIncludes,
  jsTokens,
  parseCss,
  rawColors,
  relativeImportLines,
  type Stylesheet,
} from '../syntax/index.js';
import {
  componentDir,
  type ComponentKind,
  components,
  type CustomComponent,
  findComponent,
  fragmentsDir,
  type FurnaceConfig,
  type FurnaceProject,
  loadFurnaceConfig,
  type OverrideComponent,
  type ValidationException,
} from './config.js';
import { deploymentStatus, type FurnaceWorkspace, upstreamFiles } from './deploy.js';
import { typingDrift } from './typing.js';

/** How much a finding counts. */
export type Severity = 'error' | 'warning';

/** One finding. */
export type Finding = {
  /** The component, or `furnace` for a project-wide finding. */
  component: string;
  severity: Severity;
  check: string;
  message: string;
  /** Element tags the finding is about. */
  tags?: string[];
  /** Module files the finding is in, by name. */
  files?: string[];
};

/** A finding a reviewed exception accepts. */
export type ExceptedFinding = Finding & {
  reason: string;
};

/** The outcome of a validation run. */
export type ValidationReport = {
  /** Findings that count, exception findings included. */
  findings: Finding[];
  excepted: ExceptedFinding[];
  /** How many components were judged. */
  judged: number;
  errors: number;
  warnings: number;
};

/** What the rules know about one component. */
interface Facts {
  name: string;
  kind: ComponentKind;
  custom: CustomComponent | undefined;
  override: OverrideComponent | undefined;
  /** Text of each `.mjs`, `.css` and `.ftl` file, by name. */
  files: Map<string, string>;
  /** The host module and its companions; empty when the host is missing. */
  modules: { name: string; content: string }[];
  /** The modules joined. */
  composed: string;
  /** The host stylesheet without comments, as written, and parsed. */
  css: string | undefined;
  rawCss: string | undefined;
  sheet: Stylesheet | undefined;
  /** Fragments a stylesheet includes that do not exist, by stylesheet. */
  missingFragments: Map<string, string[]>;
  /** Variables the upstream stylesheet of an override references; undefined when unknown. */
  inherited: Set<string> | undefined;
  config: FurnaceConfig;
  firefoxVersion: string;
}

interface Hit {
  message: string;
  tags?: string[];
  files?: string[];
}

interface Rule {
  check: string;
  severity: Severity;
  /** Runs only when `optInChecks` names it. */
  optIn?: boolean;
  test(facts: Facts): Hit[] | string | undefined;
}

const isLibrary = (facts: Facts): boolean => facts.custom?.kind === 'library';
const hostMjs = (facts: Facts): string | undefined => facts.files.get(`${facts.name}.mjs`);

/** Lit `html` template text, expressions masked as `${expression}`, nested templates kept. */
function litTemplates(content: string): string[] {
  const regions: string[] = [];
  const stack: { html: boolean; text: string }[] = [];
  let previous = '';
  let previousText = '';
  for (const token of jsTokens(content)) {
    const label = token.label;
    if (label === '`') {
      if (previous === 'template' || previous === 'invalidTemplate') {
        const closed = stack.pop();
        if (closed?.html === true) regions.push(closed.text);
      } else {
        stack.push({ html: previous === 'name' && previousText === 'html', text: '' });
      }
    } else if (label === 'template' || label === '${') {
      const current = stack.at(-1);
      if (current !== undefined) {
        current.text += label === '${' ? '${expression}' : content.slice(token.start, token.end);
      }
    }
    previous = label;
    previousText = content.slice(token.start, token.end);
  }
  return regions;
}

/** Attribute names (lowercased) and values of a tag's attribute text. */
function attributes(source: string): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  for (const match of source.matchAll(
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  )) {
    if (match[1] !== undefined) found.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return found;
}

/** Elements whose click the platform fires on Enter and Space. */
const NATIVELY_ACTIVATED = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'details',
  'moz-button',
  'moz-toggle',
  'moz-checkbox',
  'moz-radio',
  'moz-radio-group',
  'moz-menulist',
  'panel-item',
]);

/** Tags of elements with an `@click` handler but no native keyboard activation, in order. */
function syntheticClickTags(content: string): string[] {
  const tags: string[] = [];
  for (const match of content.matchAll(/@click\s*=\s*\$\{/g)) {
    const before = content.slice(0, match.index);
    const open = before.lastIndexOf('<');
    const tag =
      open === -1 || before.lastIndexOf('>') > open
        ? '?'
        : (/^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(content.slice(open))?.[1]?.toLowerCase() ?? '?');
    const end = content.indexOf('>', open);
    const anchorWithHref =
      tag === 'a' && /\shref\s*=/.test(content.slice(open, end === -1 ? undefined : end));
    if (!NATIVELY_ACTIVATED.has(tag) && !anchorWithHref && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * Whether text is decoration (arrows, symbols, emoji) rather than prose to
 * localize. Letters and digits of any script are prose; an emoji is a
 * symbol even where Unicode also calls it a letter (`ℹ`).
 */
function isDecoration(text: string): boolean {
  return Array.from(text).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x7f && /\p{Emoji}/u.test(character)) return true;
    if (/[\p{L}\p{N}]/u.test(character)) return false;
    return code > 0xff || '+-*=<>|/\\^~@#&!?%'.includes(character);
  });
}

function isProse(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed !== '' &&
    !trimmed.includes('${') &&
    Array.from(trimmed).length > 1 &&
    !isDecoration(trimmed)
  );
}

/** Whether a module renders hardcoded user-visible text. */
export function hasHardcodedText(content: string): boolean {
  if (/furnace-ignore:\s*hardcoded-text/.test(content)) return false;
  for (const region of litTemplates(content)) {
    for (const match of region.matchAll(/>([^<$\s][^<$]*)</g)) {
      const opening = region.slice(0, match.index + 1);
      const localized = /data-l10n-id\s*=/.test(opening.slice(opening.lastIndexOf('<')));
      if (isProse(match[1] ?? '') && !localized) return true;
    }
  }
  const assigned = /\.(?:textContent|innerHTML)\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  const attribute =
    /setAttribute\s*\(\s*["'](?:label|title|tooltiptext)["']\s*,\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  return [...content.matchAll(assigned), ...content.matchAll(attribute)].some((match) =>
    isProse(match[2] ?? '')
  );
}

function hasUnlabelledInput(content: string): boolean {
  const markup = litTemplates(content).join('\n');
  const labels = [...markup.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)]
    .filter((match) => /\S/.test((match[1] ?? '').replace(/<[^>]*>/g, ' ')))
    .map((match) => [match.index, match.index + match[0].length] as const);
  for (const match of markup.matchAll(
    /<(input|select|textarea)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi
  )) {
    const attrs = attributes(match[2] ?? '');
    const named = ['aria-label', 'aria-labelledby', 'id'].some((name) => attrs.has(name));
    if (named || attrs.get('type')?.toLowerCase() === 'hidden') continue;
    if (labels.some(([start, end]) => match.index >= start && match.index < end)) continue;
    return true;
  }
  return false;
}

/** Whether markup has a non-blank character outside its tags. */
function hasVisibleText(markup: string): boolean {
  let inTag = false;
  let quote: string | undefined;
  for (const character of markup) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (inTag) {
      if (character === '"' || character === "'") quote = character;
      else if (character === '>') inTag = false;
    } else if (character === '<') inTag = true;
    else if (character.trim() !== '') return true;
  }
  return false;
}

function unlabelledIconButtons(content: string): number {
  let count = 0;
  for (const region of litTemplates(content)) {
    for (const match of region.matchAll(
      /<moz-button\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/moz-button>/gi
    )) {
      const attrs = attributes(match[1] ?? '');
      if (['label', '.label'].some((name) => attrs.has(name)) || hasVisibleText(match[2] ?? ''))
        continue;
      const icon =
        attrs.has('iconsrc') ||
        attrs.has('.iconsrc') ||
        /(^|\s)icon(\s|$)/.test(attrs.get('type') ?? '');
      if (icon && !['data-l10n-id', 'aria-label', '.arialabel'].some((name) => attrs.has(name)))
        count++;
    }
  }
  return count;
}

/** The class extends MozLitElement, or is a customized built-in defined with `extends:`. */
function extendsMozLitElement(content: string): boolean {
  if (!/class\s+\w+\s+extends\s+/.test(content)) return true;
  if (/class\s+\w+\s+extends\s+MozLitElement\b/.test(content)) return true;
  return (
    /class\s+\w+\s+extends\s+HTML[A-Z]\w*Element\b/.test(content) &&
    /customElements\.define\s*\([^)]*\bextends\s*:\s*["'`]/.test(content)
  );
}

/** Whether a composed tag appears as an element, a selector or a query in the sources. */
function referencesElement(source: string, tag: string): boolean {
  const name = escapeRegExp(tag);
  return [
    new RegExp(`</?${name}[\\s/>]`),
    new RegExp(`(?:^|[\\s,>+~])${name}(?:[\\s,{:>+~.[#]|$)`, 'm'),
    new RegExp(`querySelector(?:All)?\\(\\s*["'\`]${name}(?:[\\s"'\`.,>+~:[#])`),
  ].some((pattern) => pattern.test(source));
}

/** The component rules, in reporting order. */
const RULES: readonly Rule[] = [
  {
    check: 'missing-mjs',
    severity: 'error',
    test: (f) =>
      f.kind === 'custom' && hostMjs(f) === undefined
        ? `Required file ${f.name}.mjs not found.`
        : undefined,
  },
  {
    check: 'missing-css',
    severity: 'warning',
    test: (f) =>
      !isLibrary(f) && !f.files.has(`${f.name}.css`)
        ? `No ${f.name}.css found. Consider adding styles.`
        : undefined,
  },
  {
    check: 'missing-ftl',
    severity: 'error',
    test: (f) =>
      f.custom?.localized === true &&
      f.custom.sharedFtl === undefined &&
      !f.files.has(`${f.name}.ftl`)
        ? `The component is localized but ${f.name}.ftl is missing. Create it, set localized: false, or use sharedFtl.`
        : undefined,
  },
  {
    check: 'conflict-markers',
    severity: 'error',
    test: (f) => {
      const files = [...f.files]
        .filter(([, text]) => /^(?:<{7}|>{7}) |^={7}$/m.test(text))
        .map(([name]) => name);
      return files.length === 0
        ? undefined
        : [{ message: `Unresolved merge conflict markers in ${files.join(', ')}.`, files }];
    },
  },
  {
    check: 'filename-mismatch',
    severity: 'error',
    test: (f) => {
      const files = [...f.files.keys()].filter((name) => {
        const stem = name.replace(/\.(?:mjs|css)$/, '');
        return (
          stem !== name &&
          !/\.(?:test|spec|stories)\./.test(name) &&
          stem !== f.name &&
          !stem.startsWith(`${f.name}-`)
        );
      });
      return files.length === 0
        ? undefined
        : [
            {
              message: `${files.join(', ')} do${files.length === 1 ? 'es' : ''} not follow the naming "${f.name}.*" or "${f.name}-*".`,
              files,
            },
          ];
    },
  },
  {
    check: 'missing-fragment',
    severity: 'error',
    test: (f) =>
      [...f.missingFragments].map(([file, names]) => ({
        message: `${file} includes ${names.map((name) => `"${name}"`).join(', ')}, missing from components/shared/.`,
        files: [file],
      })),
  },
  {
    check: 'no-aria-role',
    severity: 'warning',
    test: (f) =>
      !/role\s*=\s*["']|\.role\s*=|setAttribute\(\s*["']role["']/.test(f.composed) &&
      /<(div|span)\b(?=[^>]*(?:@click|@key(?:down|press|up)|\btabindex\s*=|\.onclick\s*=))/i.test(
        f.composed
      )
        ? 'Generic interactive markup has no native semantics. Prefer native elements, or add role= where they cannot provide it.'
        : undefined,
  },
  {
    check: 'no-keyboard-handler',
    severity: 'warning',
    test: (f) => {
      const tags = syntheticClickTags(f.composed);
      const covered =
        f.custom?.keyboardCovered === true ||
        (f.custom?.composes ?? []).some((tag) => NATIVELY_ACTIVATED.has(tag));
      if (tags.length === 0 || covered || /@key(?:down|press|up)\s*=\s*\$\{/.test(f.composed))
        return undefined;
      return [
        {
          message: `@click without a keyboard handler (@keydown/@keypress/@keyup) on ${tags.map((tag) => `<${tag}>`).join(', ')}.`,
          tags,
        },
      ];
    },
  },
  {
    check: 'hardcoded-text',
    severity: 'warning',
    test: (f) => {
      const files = f.modules
        .filter((module) => hasHardcodedText(module.content))
        .map((module) => module.name);
      return files.length === 0
        ? undefined
        : [{ message: `Possible hardcoded text in ${files.join(', ')}. Use data-l10n-id.`, files }];
    },
  },
  {
    check: 'no-delegates-focus',
    severity: 'warning',
    test: (f) =>
      /@(?:click|key(?:down|press|up))\s*=\s*\$\{/.test(f.composed) &&
      !/shadowRootOptions[\s\S]*?delegatesFocus\s*:\s*true/.test(f.composed)
        ? 'Interactive component without delegatesFocus in shadowRootOptions; focus may not reach inner elements.'
        : undefined,
  },
  {
    check: 'positive-tabindex',
    severity: 'warning',
    test: (f) =>
      [...f.composed.matchAll(/tabindex\s*=\s*["']?(\d+)/g)].some((match) => Number(match[1]) > 0)
        ? 'A positive tabindex disrupts the tab order. Use 0, or -1 for programmatic focus.'
        : undefined,
  },
  {
    check: 'unlabelled-form-input',
    severity: 'warning',
    test: (f) =>
      hasUnlabelledInput(f.composed)
        ? 'Form input without an accessible label. Add aria-label, aria-labelledby, or a <label>.'
        : undefined,
  },
  {
    check: 'icon-button-label',
    severity: 'warning',
    optIn: true,
    test: (f) => {
      const count = unlabelledIconButtons(f.composed);
      return count === 0
        ? undefined
        : `${count} icon-only <moz-button> without an accessible name. Add data-l10n-id or aria-label.`;
    },
  },
  {
    check: 'relative-import',
    severity: 'error',
    test: (f) =>
      relativeImportLines(hostMjs(f) ?? '').length > 0
        ? 'Imports must use chrome:// URLs, not relative paths.'
        : undefined,
  },
  {
    check: 'no-custom-element-define',
    severity: 'error',
    test: (f) => {
      const mjs = hostMjs(f);
      return mjs !== undefined && !isLibrary(f) && !/customElements\.define\s*\(/.test(mjs)
        ? 'The module never calls customElements.define(), so the element is never defined.'
        : undefined;
    },
  },
  {
    check: 'not-moz-lit-element',
    severity: 'error',
    test: (f) => {
      const mjs = hostMjs(f);
      return mjs !== undefined && !isLibrary(f) && !extendsMozLitElement(mjs)
        ? 'The component class must extend MozLitElement.'
        : undefined;
    },
  },
  {
    check: 'raw-color-value',
    severity: 'error',
    test: (f) =>
      f.sheet !== undefined && rawColors(f.sheet).length > 0
        ? 'Raw color value; use a design token (var(--...)).'
        : undefined,
  },
  {
    check: 'token-prefix-violation',
    severity: 'error',
    test: (f) => {
      const prefix = f.config.tokenPrefix;
      if (
        f.sheet === undefined ||
        prefix === undefined ||
        (f.kind === 'override' && f.inherited === undefined)
      ) {
        return undefined;
      }
      const exempt = new Set([
        ...(f.config.tokenAllowlist ?? []),
        ...(f.config.runtimeVariables ?? []),
        ...(f.inherited ?? []),
      ]);
      const offending = new Set(foreignVariables(f.sheet, prefix, exempt).map((ref) => ref.name));
      return [...offending].map((name) => ({
        message: `var(${name}) does not use the token prefix "${prefix}". Use a token, or list it in tokenAllowlist or runtimeVariables.`,
      }));
    },
  },
  {
    check: 'excessive-important',
    severity: 'warning',
    test: (f) => {
      const count = (f.css?.match(/!important/g) ?? []).length;
      return count > 3 ? `${count} uses of !important; prefer structural CSS.` : undefined;
    },
  },
  {
    check: 'missing-reduced-motion',
    severity: 'warning',
    test: (f) =>
      f.css !== undefined &&
      /(?:animation|transition)\s*:/m.test(f.css) &&
      !/@media\s*\(\s*prefers-reduced-motion/m.test(f.rawCss ?? '')
        ? 'Animation or transition without a prefers-reduced-motion media query.'
        : undefined,
  },
  {
    check: 'prefers-color-scheme',
    severity: 'warning',
    test: (f) =>
      /@media\s*\(\s*prefers-color-scheme/m.test(f.rawCss ?? '')
        ? 'A prefers-color-scheme media query; theme through design tokens instead.'
        : undefined,
  },
  {
    check: 'compose-not-referenced',
    severity: 'warning',
    test: (f) => {
      const source = (hostMjs(f) ?? '') + (f.rawCss ?? '');
      return (f.custom?.composes ?? [])
        .filter((tag) => !referencesElement(source, tag))
        .map((tag) => ({
          message: `Declares it composes "${tag}", which its template and stylesheet never reference.`,
          tags: [tag],
        }));
    },
  },
  {
    check: 'override-base-version-drift',
    severity: 'error',
    test: (f) =>
      f.override !== undefined && f.override.baseVersion !== f.firefoxVersion
        ? `The override was taken from Firefox ${f.override.baseVersion}, the project builds ${f.firefoxVersion}. Compare it with upstream, then update baseVersion in furnace.json.`
        : undefined,
  },
];

async function gatherFacts(
  project: FurnaceProject,
  config: FurnaceConfig,
  name: string,
  kind: ComponentKind,
  workspace: FurnaceWorkspace | undefined
): Promise<Facts | undefined> {
  const dir = componentDir(project, kind, name);
  const entries = await listDir(dir);
  if (entries.length === 0) return undefined;
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === 'file' && /\.(?:mjs|css|ftl)$/.test(entry.name)) {
      files.set(entry.name, (await readTextIfExists(join(dir, entry.name))) ?? '');
    }
  }
  const host = files.get(`${name}.mjs`);
  const modules =
    host === undefined
      ? []
      : [
          { name: `${name}.mjs`, content: host },
          ...[...files]
            .filter(
              ([file]) =>
                file.startsWith(`${name}-`) &&
                file.endsWith('.mjs') &&
                !/\.(?:test|spec|stories)\./.test(file)
            )
            .map(([file, content]) => ({ name: file, content })),
        ];
  const rawCss = files.get(`${name}.css`);
  const missingFragments = new Map<string, string[]>();
  for (const [file, text] of files) {
    if (!file.endsWith('.css')) continue;
    const missing: string[] = [];
    for (const fragment of fragmentIncludes(text)) {
      if ((await readTextIfExists(join(fragmentsDir(project), fragment))) === undefined)
        missing.push(fragment);
    }
    if (missing.length > 0) missingFragments.set(file, missing);
  }
  const override = config.overrides[name];
  let inherited: Set<string> | undefined;
  if (override !== undefined && workspace !== undefined) {
    const path = `${override.basePath}/${name}.css`;
    const upstream = (await upstreamFiles(workspace, [path])).get(path)?.toString('utf8') ?? '';
    inherited = new Set(cssVarReferences(parseCss(upstream)).map((reference) => reference.name));
  }
  return {
    name,
    kind,
    custom: config.custom[name],
    override,
    files,
    modules,
    composed: modules.map((module) => module.content).join('\n'),
    css: rawCss === undefined ? undefined : blankCssComments(rawCss),
    rawCss,
    sheet: rawCss === undefined ? undefined : parseCss(rawCss),
    missingFragments,
    inherited,
    config,
    firefoxVersion: project.config.firefox.version,
  };
}

function runRules(facts: Facts): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (
      rule.optIn === true &&
      !(facts.config.optInChecks ?? []).some((check) => check === rule.check)
    )
      continue;
    const result = rule.test(facts);
    const hits =
      result === undefined ? [] : typeof result === 'string' ? [{ message: result }] : result;
    for (const hit of hits) {
      findings.push({ component: facts.name, severity: rule.severity, check: rule.check, ...hit });
    }
  }
  return findings;
}

/** The exceptions that accept a warning: an unscoped one, or scoped ones covering every tag or file it names. */
function covering(
  finding: Finding,
  candidates: readonly ValidationException[]
): ValidationException[] {
  const unscoped = candidates.find((entry) => entry.tag === undefined && entry.file === undefined);
  if (unscoped !== undefined) return [unscoped];
  for (const [key, field] of [
    ['tags', 'tag'],
    ['files', 'file'],
  ] as const) {
    const named = finding[key] ?? [];
    if (named.length === 0) continue;
    const found = named.map((value) => candidates.find((entry) => entry[field] === value));
    if (found.every((entry) => entry !== undefined)) return [...new Set(found)];
  }
  return [];
}

/**
 * Splits findings into counted and excepted. An exception matching an error
 * is reported, since it cannot accept one; an exception matching nothing on
 * a judged component is stale.
 */
function applyExceptions(
  findings: readonly Finding[],
  exceptions: readonly ValidationException[],
  judged: (component: string) => boolean
): { findings: Finding[]; excepted: ExceptedFinding[] } {
  const counted: Finding[] = [];
  const excepted: ExceptedFinding[] = [];
  const used = new Set<ValidationException>();
  const onError = new Set<ValidationException>();
  for (const finding of findings) {
    const candidates = exceptions.filter(
      (entry) => entry.component === finding.component && entry.check === finding.check
    );
    const accepting = finding.severity === 'error' ? [] : covering(finding, candidates);
    if (finding.severity === 'error') candidates.forEach((entry) => onError.add(entry));
    if (accepting.length === 0) {
      // A scoped exception covering some of the tags or files still describes a live finding.
      for (const entry of candidates) {
        const value = entry.tag ?? entry.file;
        if (
          value === undefined ||
          [...(finding.tags ?? []), ...(finding.files ?? [])].includes(value)
        )
          used.add(entry);
      }
      counted.push(finding);
      continue;
    }
    accepting.forEach((entry) => used.add(entry));
    excepted.push({ ...finding, reason: accepting.map((entry) => entry.reason).join('; ') });
  }
  for (const entry of onError) {
    counted.push({
      component: entry.component,
      severity: 'error',
      check: 'validation-exception-on-error',
      message: `The validationExceptions entry for [${entry.check}] matches an error, which an exception cannot accept. Fix the error, then delete the entry.`,
    });
  }
  for (const entry of exceptions) {
    if (used.has(entry) || onError.has(entry) || !judged(entry.component)) continue;
    counted.push({
      component: entry.component,
      severity: 'warning',
      check: 'stale-validation-exception',
      message: `The validationExceptions entry for [${entry.check}] matches no finding; delete it.`,
    });
  }
  return { findings: counted, excepted };
}

/** What {@link validateComponents} judges. */
export interface ValidateOptions {
  /** Judge only this component (the component floor and project checks are skipped). */
  component?: string;
  /**
   * The engine the project deploys into. With it, overrides inherit the
   * token exemptions of their upstream stylesheet and the deployment is
   * judged; without it, both are skipped.
   */
  workspace?: FurnaceWorkspace;
}

/**
 * Validates the project's components.
 *
 * @param project - The project
 * @param tracked - The project's tracked engine files, for typing files under `engine/`
 * @param options - See {@link ValidateOptions}
 */
export async function validateComponents(
  project: FurnaceProject,
  tracked: TrackedFiles,
  options: ValidateOptions = {}
): Promise<ValidationReport> {
  const config = await loadFurnaceConfig(project);
  const selected =
    options.component === undefined
      ? components(config)
      : [findComponent(config, options.component)];
  const findings: Finding[] = [];
  for (const { name, kind } of selected) {
    const facts = await gatherFacts(project, config, name, kind, options.workspace);
    if (facts === undefined) {
      findings.push({
        component: name,
        severity: 'error',
        check: 'missing-component-dir',
        message: `${componentDir(project, kind, name)} does not exist or is empty.`,
      });
    } else {
      findings.push(...runRules(facts));
    }
  }
  if (options.component === undefined) {
    if (config.minComponents !== undefined && selected.length < config.minComponents) {
      findings.push({
        component: 'furnace',
        severity: 'error',
        check: 'component-floor',
        message: `Judged ${selected.length} component(s), fewer than minComponents (${config.minComponents}).`,
      });
    }
    for (const drift of await typingDrift(project, config, tracked)) {
      findings.push({
        component: 'furnace',
        severity: 'error',
        check: 'typing-drift',
        message: `${drift.file} is out of date (${drift.detail}). Run "fireforge furnace types".`,
      });
    }
  }
  if (options.workspace !== undefined) {
    const status = await deploymentStatus(project, options.workspace);
    const judged = new Set(selected.map((component) => component.name));
    for (const component of status.components) {
      if (
        component.status === 'current' ||
        (options.component !== undefined && !judged.has(component.name))
      )
        continue;
      findings.push({
        component: component.name,
        severity: 'error',
        check: 'deployment-stale',
        message: `The engine does not hold the component as the project has it: ${component.reasons.join('; ')}. Run "fireforge furnace apply".`,
      });
    }
  }
  const judged = (component: string): boolean =>
    options.component === undefined ? true : component === options.component;
  const outcome = applyExceptions(findings, config.validationExceptions ?? [], judged);
  const errors = outcome.findings.filter((finding) => finding.severity === 'error').length;
  return {
    ...outcome,
    judged: selected.length,
    errors,
    warnings: outcome.findings.length - errors,
  };
}

/**
 * Whether a validation run passes: no error, and no more warnings than the
 * ceiling when one is given.
 *
 * @param report - The run
 * @param maxWarnings - The most warnings that still pass
 */
export function validationPasses(report: ValidationReport, maxWarnings?: number): boolean {
  return report.errors === 0 && (maxWarnings === undefined || report.warnings <= maxWarnings);
}
