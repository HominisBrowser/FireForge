// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CustomComponentConfig,
  FurnaceOptInCheck,
  ValidationIssue,
} from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import { createIssue } from './furnace-validate-helpers.js';
import { countUnlabelledIconButtons } from './furnace-validate-icon-button.js';
import { collectLitTemplateRegions, parseTemplateAttributes } from './lit-template-regions.js';

/** One module of a composed component: its file name and contents. */
interface ComponentModule {
  name: string;
  content: string;
}

/**
 * Reads the composed component: `<tagName>.mjs` followed by its companion
 * modules (`<tagName>-*.mjs`, tests and stories left out), so a template's
 * findings do not depend on which of the component's modules it lives in.
 * Returns undefined when the host module is missing.
 */
async function readComposedComponentModules(
  componentDir: string,
  tagName: string
): Promise<ComponentModule[] | undefined> {
  const hostName = `${tagName}.mjs`;
  const hostPath = join(componentDir, hostName);
  if (!(await pathExists(hostPath))) return undefined;
  const entries = await readdir(componentDir).catch((): string[] => []);
  const companions = entries
    .filter(
      (name) =>
        name.startsWith(`${tagName}-`) &&
        name.endsWith('.mjs') &&
        !/\.(test|spec|stories)\./.test(name)
    )
    .sort();
  const modules = [{ name: hostName, content: await readText(hostPath) }];
  for (const name of companions) {
    modules.push({ name, content: await readText(join(componentDir, name)) });
  }
  return modules;
}

/**
 * Validates accessibility patterns in a component's composed source: its
 * host module and every companion module (see
 * {@link readComposedComponentSource}). Checks for ARIA roles, keyboard
 * handlers, l10n, and focus delegation.
 *
 * @param componentDir - Directory holding the component's sources
 * @param tagName - Custom element tag name, used to locate `<tagName>.mjs`
 * @param customConfig - When the component is custom, its matching entry
 *   from `furnace.json`. Used to skip the `no-keyboard-handler` warning
 *   when the component declares keyboard coverage either explicitly
 *   (`keyboardCovered: true`) or via `composes` naming a native-interactive
 *   inner element. Optional so stock/override callers and test fixtures
 *   without config in scope can continue to call without changes.
 * @param optInChecks - `furnace.json#optInChecks`. `icon-button-label`
 *   adds the icon-only `<moz-button>` naming check.
 */
export async function validateAccessibility(
  componentDir: string,
  tagName: string,
  customConfig?: CustomComponentConfig,
  optInChecks: readonly FurnaceOptInCheck[] = []
): Promise<ValidationIssue[]> {
  const modules = await readComposedComponentModules(componentDir, tagName);
  if (modules === undefined) return [];
  const content = modules.map((module) => module.content).join('\n');
  const issues: ValidationIssue[] = [];

  if (!hasAriaRole(content) && hasGenericInteractiveElement(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'no-aria-role',
        'Generic interactive markup has no native semantics. Prefer native elements, or add role= when native markup cannot provide the semantics.'
      )
    );
  }

  const hasClick = hasTemplateClickHandler(content);
  const hasKeyboardHandler = hasTemplateKeyboardHandler(content);
  // Native interactive elements (<button>, <a href>, form controls,
  // moz-button/moz-toggle/etc.) dispatch click on Enter/Space via the
  // platform, so a duplicate keyboard handler would usually double-fire.
  // Only flag synthetic markup (e.g. `<div @click>`) where the activation
  // path has to be wired manually.
  //
  // A wrapper component whose `composes` entry lists a native-interactive
  // tag (or that sets `keyboardCovered: true`) is treated the same way:
  // activation flows through the inner element and a duplicate handler on
  // the wrapper would either no-op or fire twice alongside the child's
  // built-in keyboard path.
  const syntheticTags = syntheticClickTags(content);
  const keyboardCovered = isKeyboardCoveredByComposition(customConfig);
  if (syntheticTags.length > 0 && !hasKeyboardHandler && !keyboardCovered) {
    issues.push({
      ...createIssue(
        tagName,
        'warning',
        'no-keyboard-handler',
        `Interactive element has @click but no keyboard event handler (@keydown/@keypress/@keyup), on ${syntheticTags.map((tag) => `<${tag}>`).join(', ')}.`
      ),
      tags: syntheticTags,
    });
  }

  // Judged per module, so the finding names its files and an exception can
  // accept one module (a vendored bundle) without muting the others.
  const textFiles = modules
    .filter((module) => containsHardcodedTemplateText(module.content))
    .map((module) => module.name);
  if (textFiles.length > 0) {
    issues.push({
      ...createIssue(
        tagName,
        'warning',
        'hardcoded-text',
        `Possible hardcoded string found in ${textFiles.join(', ')}. Use data-l10n-id for localization.`
      ),
      files: textFiles,
    });
  }

  const isInteractive = hasClick || hasKeyboardHandler;
  if (isInteractive && !hasDelegatesFocusEnabled(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'no-delegates-focus',
        'Interactive component without delegatesFocus in shadowRootOptions. Focus may not delegate to inner elements.'
      )
    );
  }

  if (hasPositiveTabindex(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'positive-tabindex',
        'Positive tabindex disrupts natural tab order. Use tabindex="0" for focusable elements or tabindex="-1" for programmatic focus only.'
      )
    );
  }

  if (hasUnlabelledFormInput(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'unlabelled-form-input',
        'Form input without an accessible label. Add aria-label, aria-labelledby, or an associated <label> element.'
      )
    );
  }

  if (optInChecks.includes('icon-button-label')) {
    const unlabelled = countUnlabelledIconButtons(content);
    if (unlabelled > 0) {
      issues.push(
        createIssue(
          tagName,
          'warning',
          'icon-button-label',
          `${unlabelled} icon-only <moz-button> without an accessible name. Add data-l10n-id (with the label in its Fluent message) or aria-label.`
        )
      );
    }
  }

  return issues;
}

/** Detects whether template or script content assigns an ARIA role. */
function hasAriaRole(content: string): boolean {
  return (
    /role\s*=\s*["']/.test(content) ||
    /\.role\s*=/.test(content) ||
    /setAttribute\(\s*["']role["']/.test(content)
  );
}

/** Detects generic elements being used as custom interactive controls. */
function hasGenericInteractiveElement(content: string): boolean {
  return /<(div|span)\b(?=[^>]*(?:@click|@key(?:down|press|up)|\btabindex\s*=|\.onclick\s*=))/i.test(
    content
  );
}

/** Detects a positive tabindex value, which disrupts natural tab order. */
function hasPositiveTabindex(content: string): boolean {
  const match = content.match(/tabindex\s*=\s*["']?(\d+)/g);
  if (!match) return false;
  return match.some((m) => {
    const value = /(\d+)/.exec(m)?.[1];
    return value !== undefined && parseInt(value, 10) > 0;
  });
}

/**
 * Collects `[start, end)` spans of `<label>…</label>` elements whose content
 * includes actual label text. Labels cannot nest per HTML, so the non-greedy
 * inner match is sound. A span qualifies only when the inner content minus
 * tags still contains non-whitespace. An empty or tag-only wrapper provides
 * no accessible name. A `${…}` Lit binding counts as label text: dynamic
 * (usually localized) text is a legitimate accessible name.
 */
function collectLabelledSpans(content: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const labelPattern = /<label\b[^>]*>([\s\S]*?)<\/label>/gi;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelPattern.exec(content)) !== null) {
    const inner = labelMatch[1] ?? '';
    if (/\S/.test(inner.replace(/<[^>]*>/g, ' '))) {
      spans.push({ start: labelMatch.index, end: labelMatch.index + labelMatch[0].length });
    }
  }
  return spans;
}

/** Detects form inputs without associated labels. */
function hasUnlabelledFormInput(content: string): boolean {
  // Look for <input> or <select> or <textarea> without aria-label, aria-labelledby, or id
  // (id implies an external <label for="..."> could exist). A control wrapped
  // in a <label> that carries actual text is implicitly associated and is
  // exempt as well.
  content = collectLitTemplateRegions(content).join('\n');
  const labelledSpans = collectLabelledSpans(content);
  const inputPattern = /<(input|select|textarea)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let inputMatch: RegExpExecArray | null;
  while ((inputMatch = inputPattern.exec(content)) !== null) {
    const attrs = parseTemplateAttributes(inputMatch[2] ?? '');
    if (
      attrs.has('aria-label') ||
      attrs.has('aria-labelledby') ||
      attrs.has('id') ||
      attrs.get('type')?.toLowerCase() === 'hidden'
    ) {
      continue;
    }
    const index = inputMatch.index;
    if (labelledSpans.some((span) => index >= span.start && index < span.end)) {
      continue;
    }
    return true;
  }
  return false;
}

/** Detects Lit-style template click handlers. */
function hasTemplateClickHandler(content: string): boolean {
  return /@click\s*=\s*\$\{/.test(content);
}

/** Detects Lit-style template keyboard handlers. */
function hasTemplateKeyboardHandler(content: string): boolean {
  return /@key(down|press|up)\s*=\s*\$\{/.test(content);
}

/**
 * Native HTML elements that dispatch `click` on Enter and Space via the
 * platform. Attaching `@click` to these is not a keyboard-a11y bug, because
 * the browser already handles the keyboard activation path. A duplicate
 * `@keydown`/`@keypress` handler would usually double-fire the action.
 *
 * `<a>` is accepted only when an `href` attribute is present. A bare `<a>`
 * is non-interactive and is treated as synthetic.
 */
const NATIVE_CLICK_INTERACTIVE_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'details',
  // Mozilla widgets that extend the native pattern and keep Enter/Space activation.
  'moz-button',
  'moz-toggle',
  'moz-checkbox',
  'moz-radio',
  'moz-radio-group',
  'moz-menulist',
  // Toolkit's panel-list row renders a button that takes Enter and Space
  // and dispatches click.
  'panel-item',
]);

/**
 * Returns true when `customConfig` declares that the component's keyboard
 * activation path is covered by a wrapped native-interactive inner element,
 * either through an explicit opt-out (`keyboardCovered: true`) or by
 * composing a tag that lives in {@link NATIVE_CLICK_INTERACTIVE_TAGS}.
 *
 * Uses `.some` rather than `.every` so that a wrapper composing e.g.
 * `['moz-button', 'my-tooltip']` still skips the warning: the keyboard
 * activation path flows through the button, even if other composed
 * children are synthetic.
 */
function isKeyboardCoveredByComposition(customConfig: CustomComponentConfig | undefined): boolean {
  if (!customConfig) return false;
  if (customConfig.keyboardCovered === true) return true;
  const composes = customConfig.composes ?? [];
  return composes.some((tag) => NATIVE_CLICK_INTERACTIVE_TAGS.has(tag));
}

/**
 * Returns the tags (in first-seen order) of every *synthetic* interactive
 * element carrying an `@click=${...}` handler (e.g. `<div @click>`), which
 * lacks native keyboard activation and therefore needs an explicit key
 * handler for Enter/Space. Empty when every `@click` handler sits on a
 * native interactive element. Those already fire `click` on keyboard
 * activation.
 */
function syntheticClickTags(content: string): string[] {
  const pattern = /@click\s*=\s*\$\{/g;
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const tag = syntheticClickTag(content, match.index);
    if (tag !== undefined && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** The tag a synthetic-element `@click` sits on, `?` when it cannot be told. */
const UNKNOWN_TAG = '?';

/**
 * Given the offset of an `@click=${...}` occurrence, walks backwards to find
 * the opening `<tag` that owns it and returns that tag when it is a
 * synthetic interactive element (warning needed), or undefined when it is a
 * native one (no warning needed).
 */
function syntheticClickTag(content: string, clickIndex: number): string | undefined {
  // Find the nearest preceding `<` that starts a tag (skip `</` closers).
  let i = clickIndex - 1;
  let tagOpenIndex = -1;
  while (i >= 0) {
    if (content[i] === '<' && content[i + 1] !== '/') {
      tagOpenIndex = i;
      break;
    }
    // A `>` before an unclosed `<` means we're outside the attribute list,
    // which shouldn't happen for a well-formed template but we defensively
    // treat it as synthetic to preserve the prior-behaviour warning.
    if (content[i] === '>') {
      return UNKNOWN_TAG;
    }
    i--;
  }
  if (tagOpenIndex < 0) return UNKNOWN_TAG;

  const tagMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(content.slice(tagOpenIndex));
  if (!tagMatch?.[1]) return UNKNOWN_TAG;
  const tagName = tagMatch[1].toLowerCase();

  if (tagName === 'a') {
    // Bare <a> (no href) is non-interactive, so require a keyboard handler.
    // Look forward from the tag open for the closing `>` and scan the
    // attribute text in between for an href attribute.
    const tagEnd = content.indexOf('>', tagOpenIndex);
    if (tagEnd < 0) return 'a';
    const attrs = content.slice(tagOpenIndex, tagEnd);
    return /\shref\s*=/.test(attrs) ? undefined : 'a';
  }

  return NATIVE_CLICK_INTERACTIVE_TAGS.has(tagName) ? undefined : tagName;
}

/** ASCII punctuation that reads as decoration rather than localizable text. */
const SYMBOL_ONLY_ASCII = '+-*=<>|/\\^~@#&!?%';

/**
 * Reports whether `text` is decoration (arrows, maths, emoji, bare
 * punctuation) rather than user-facing prose that needs localizing.
 *
 * The letter/number/mark test comes first and is script-agnostic. A rule
 * keyed on `code > 0xff` would classify every code point above U+00FF as a
 * symbol, exempting all CJK, Cyrillic, Greek, Arabic, Hebrew, Devanagari and
 * Thai text from a localization validator.
 *
 * Combining marks are not counted as text: the check is an
 * `every()`, so a script's base letters already disqualify the string, and
 * treating marks as text would flag emoji carrying a variation selector
 * (U+FE0F is category Mn, and `⚙️` is U+2699 + U+FE0F).
 *
 * High code points that are not letters (emoji, arrows, CJK punctuation)
 * stay exempt, which is the rule's intent.
 *
 * A handful of emoji are also Unicode letters, and the letter test alone
 * gets them wrong: U+2139 (`ℹ`, the base of the common `ℹ️`) is category Ll,
 * so `\p{L}` would classify an info badge as prose needing localization.
 * Non-ASCII code points carrying `Emoji` are therefore read as symbols
 * before the letter test. The ASCII guard matters: `\p{Emoji}` also covers
 * the digits `0`-`9`, `#` and `*`, which must keep their classification.
 */
function isSymbolOnlyText(text: string): boolean {
  return Array.from(text).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x7f && /\p{Emoji}/u.test(character)) return true;
    if (/[\p{L}\p{N}]/u.test(character)) return false;
    return code > 0xff || SYMBOL_ONLY_ASCII.includes(character);
  });
}

function isWithinLocalizedElement(content: string, matchIndex: number): boolean {
  const contentBefore = content.slice(0, matchIndex + 1);
  const lastTagOpen = contentBefore.lastIndexOf('<');
  if (lastTagOpen === -1) {
    return false;
  }

  const tagContent = contentBefore.slice(lastTagOpen, matchIndex + 1);
  return /data-l10n-id\s*=/.test(tagContent);
}

/**
 * Detects hardcoded user-visible template text that should usually be
 * localized.
 *
 * Scoped to three positive contexts rather than scanning the whole file,
 * because a bare `>…<` regex catches JS comparisons (`if (x > 0 && y <
 * 100)`), diagnostic strings (`console.error("Failed <id> lookup")`), and
 * identifier literals that are never shown to a user. Only matches that
 * actually enter a UI render path count:
 *
 *   1. Content inside a Lit `` html`…` `` tagged template literal.
 *   2. The string literal on the RHS of `.textContent = "…"` or
 *      `.innerHTML = "…"`.
 *   3. The string literal assigned to an XUL-widget `label=`,
 *      `title=`, or `tooltiptext=` attribute when constructing DOM in JS.
 *
 * A file-wide `// furnace-ignore: hardcoded-text` comment suppresses all
 * findings in that file (matches the pre-existing escape hatch).
 */
export function containsHardcodedTemplateText(content: string): boolean {
  if (/furnace-ignore:\s*hardcoded-text/.test(content)) {
    return false;
  }

  return (
    hasFlaggedTextInLitTemplates(content) ||
    hasFlaggedTextInDomAssignment(content) ||
    hasFlaggedTextInXulAttribute(content)
  );
}

function isFlaggableText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\$\{/.test(trimmed)) return false;
  if (Array.from(trimmed).length <= 1) return false;
  if (isSymbolOnlyText(trimmed)) return false;
  return true;
}

function hasFlaggedTextInLitTemplates(content: string): boolean {
  for (const region of collectLitTemplateRegions(content)) {
    const textPattern = />([^<$\s][^<$]*)</g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textPattern.exec(region)) !== null) {
      const text = textMatch[1] ?? '';
      if (!isFlaggableText(text)) continue;
      if (isWithinLocalizedElement(region, textMatch.index)) continue;
      return true;
    }
  }
  return false;
}

function hasFlaggedTextInDomAssignment(content: string): boolean {
  // `<expr>.textContent = "abc"` and `<expr>.innerHTML = "abc"`: these are
  // user-visible render paths. Template-literal RHS is excluded (usually
  // dynamic), matching the `${` guard used elsewhere in this helper.
  const assignPattern = /\.(?:textContent|innerHTML)\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = assignPattern.exec(content)) !== null) {
    const text = match[2] ?? '';
    if (isFlaggableText(text)) return true;
  }
  return false;
}

function hasFlaggedTextInXulAttribute(content: string): boolean {
  // Assignments like `node.setAttribute("label", "Save")` or JS-built XUL
  // attributes `label="…"` / `title="…"` / `tooltiptext="…"` in template
  // literals outside Lit blocks. Covers DOM built via createXULElement.
  const setAttrPattern =
    /setAttribute\s*\(\s*["'](?:label|title|tooltiptext)["']\s*,\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  let setAttrMatch: RegExpExecArray | null;
  while ((setAttrMatch = setAttrPattern.exec(content)) !== null) {
    const text = setAttrMatch[2] ?? '';
    if (isFlaggableText(text)) return true;
  }
  return false;
}

/** Detects whether a component opts into shadow-root focus delegation. */
function hasDelegatesFocusEnabled(content: string): boolean {
  return /shadowRootOptions[\s\S]*?delegatesFocus\s*:\s*true/.test(content);
}
