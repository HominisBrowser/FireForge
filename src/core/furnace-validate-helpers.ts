// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type {
  ComponentType,
  CustomComponentConfig,
  FurnaceConfig,
  ValidationIssue,
} from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import { getProjectPaths } from './config.js';
import { extractComponentChecksums } from './furnace-checksum-utils.js';

/** Creates a normalized validation issue object. */
export function createIssue(
  component: string,
  severity: ValidationIssue['severity'],
  check: ValidationIssue['check'],
  message: string
): ValidationIssue {
  return { component, severity, check, message };
}

/** Detects whether template or script content assigns an ARIA role. */
export function hasAriaRole(content: string): boolean {
  return (
    /role\s*=\s*["']/.test(content) ||
    /\.role\s*=/.test(content) ||
    /setAttribute\(\s*["']role["']/.test(content)
  );
}

/** Detects generic elements being used as custom interactive controls. */
export function hasGenericInteractiveElement(content: string): boolean {
  return /<(div|span)\b(?=[^>]*(?:@click|@key(?:down|press|up)|\btabindex\s*=|\.onclick\s*=))/i.test(
    content
  );
}

/** Detects a positive tabindex value, which disrupts natural tab order. */
export function hasPositiveTabindex(content: string): boolean {
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
 * tags still contains non-whitespace — an empty or tag-only wrapper provides
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
export function hasUnlabelledFormInput(content: string): boolean {
  // Look for <input> or <select> or <textarea> without aria-label, aria-labelledby, or id
  // (id implies an external <label for="..."> could exist). A control wrapped
  // in a <label> that carries actual text is implicitly associated and is
  // exempt as well.
  const labelledSpans = collectLabelledSpans(content);
  const inputPattern = /<(input|select|textarea)\b([^>]*)>/gi;
  let inputMatch: RegExpExecArray | null;
  while ((inputMatch = inputPattern.exec(content)) !== null) {
    const attrs = inputMatch[2] ?? '';
    if (
      /aria-label\s*=/.test(attrs) ||
      /aria-labelledby\s*=/.test(attrs) ||
      /\bid\s*=/.test(attrs) ||
      /type\s*=\s*["']hidden["']/i.test(attrs)
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
export function hasTemplateClickHandler(content: string): boolean {
  return /@click\s*=\s*\$\{/.test(content);
}

/** Detects Lit-style template keyboard handlers. */
export function hasTemplateKeyboardHandler(content: string): boolean {
  return /@key(down|press|up)\s*=\s*\$\{/.test(content);
}

/**
 * Native HTML elements that dispatch `click` on Enter and Space via the
 * platform. Attaching `@click` to these is NOT a keyboard-a11y bug because
 * the browser already handles the keyboard activation path — a duplicate
 * `@keydown`/`@keypress` handler would usually double-fire the action.
 *
 * `<a>` is accepted only when an `href` attribute is present; bare `<a>` is
 * non-interactive and is treated as synthetic.
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
export function isKeyboardCoveredByComposition(
  customConfig: CustomComponentConfig | undefined
): boolean {
  if (!customConfig) return false;
  if (customConfig.keyboardCovered === true) return true;
  const composes = customConfig.composes ?? [];
  return composes.some((tag) => NATIVE_CLICK_INTERACTIVE_TAGS.has(tag));
}

/**
 * Returns true when `content` has at least one `@click=${...}` handler on a
 * *synthetic* interactive element (e.g. `<div @click>`), which lacks native
 * keyboard activation and therefore needs an explicit key handler for
 * Enter/Space. Returns false when every `@click` handler sits on a native
 * interactive element — those already fire `click` on keyboard activation.
 */
export function hasTemplateClickOnSyntheticInteractive(content: string): boolean {
  const pattern = /@click\s*=\s*\$\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (isClickOnSyntheticInteractive(content, match.index)) {
      return true;
    }
  }
  return false;
}

/**
 * Given the offset of an `@click=${...}` occurrence, walks backwards to find
 * the opening `<tag` that owns it and decides whether that tag is a native
 * interactive element (no warning needed) or a synthetic one (warning needed).
 */
function isClickOnSyntheticInteractive(content: string, clickIndex: number): boolean {
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
      return true;
    }
    i--;
  }
  if (tagOpenIndex < 0) return true;

  const tagMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(content.slice(tagOpenIndex));
  if (!tagMatch?.[1]) return true;
  const tagName = tagMatch[1].toLowerCase();

  if (tagName === 'a') {
    // Bare <a> (no href) is non-interactive; require a keyboard handler.
    // Look forward from the tag open for the closing `>` and scan the
    // attribute text in between for an href attribute.
    const tagEnd = content.indexOf('>', tagOpenIndex);
    if (tagEnd < 0) return true;
    const attrs = content.slice(tagOpenIndex, tagEnd);
    return !/\shref\s*=/.test(attrs);
  }

  return !NATIVE_CLICK_INTERACTIVE_TAGS.has(tagName);
}

/** ASCII punctuation that reads as decoration rather than localizable text. */
const SYMBOL_ONLY_ASCII = '+-*=<>|/\\^~@#&!?%';

/**
 * Reports whether `text` is decoration (arrows, maths, emoji, bare
 * punctuation) rather than user-facing prose that needs localizing.
 *
 * The letter/number/mark test comes first and is script-agnostic. Until
 * 0.41.0 the only non-ASCII rule was `code > 0xff`, which classified *every*
 * code point above U+00FF as a symbol — so all CJK, Cyrillic, Greek, Arabic,
 * Hebrew, Devanagari and Thai text was exempted from a **localization**
 * validator, i.e. the rule was blind to precisely the strings most likely to
 * need translating.
 *
 * Combining marks are deliberately NOT counted as text: the check is an
 * `every()`, so a script's base letters already disqualify the string, and
 * treating marks as text would flag emoji carrying a variation selector
 * (U+FE0F is category Mn — `⚙️` is U+2699 + U+FE0F).
 *
 * High code points that are not letters — emoji, arrows, CJK punctuation —
 * stay exempt, which is the rule's original intent.
 *
 * A handful of emoji are ALSO Unicode letters, and the letter test alone gets
 * them wrong. U+2139 (`ℹ`, the base of the very common `ℹ️`) is category Ll, so
 * the `\p{L}` branch classified an info badge as prose needing localization.
 * Non-ASCII code points carrying `Emoji` are therefore read as symbols before
 * the letter test. The ASCII guard matters: `\p{Emoji}` also covers the digits
 * `0`-`9`, `#` and `*`, which must keep their existing classification.
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
 * findings (matches the pre-existing escape hatch).
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
  // Match `html\`…\`` regions, anchored on a non-identifier char before `html`
  // so substrings like `otherhtml` do not spuriously open a template.
  const htmlPattern = /(?:^|[^a-zA-Z0-9_$])html`([\s\S]*?)`/g;
  let litMatch: RegExpExecArray | null;
  while ((litMatch = htmlPattern.exec(content)) !== null) {
    const region = litMatch[1] ?? '';
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
  // `<expr>.textContent = "abc"` and `<expr>.innerHTML = "abc"` — these are
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
export function hasDelegatesFocusEnabled(content: string): boolean {
  return /shadowRootOptions[\s\S]*?delegatesFocus\s*:\s*true/.test(content);
}

/** Removes CSS block comments before running simple string-based checks. */
export function stripCssBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Detects relative ES module imports in a component module file. */
export function hasRelativeModuleImport(mjsContent: string): boolean {
  return (
    /^\s*import\s.*from\s+["']\.\.?\//m.test(mjsContent) ||
    /^\s*import\s+["']\.\.?\//m.test(mjsContent)
  );
}

/** Detects whether a module defines a custom element at runtime. */
export function hasCustomElementDefineCall(mjsContent: string): boolean {
  return /customElements\.define\s*\(/.test(mjsContent);
}

/**
 * Detects whether the module's `customElements.define(...)` call includes a
 * literal `extends:` option (third argument). That shape is the marker for
 * a customized built-in element — the class extends a specific
 * `HTMLxxxElement` rather than the autonomous `MozLitElement` path.
 *
 * Firefox's own widgets use this pattern for toolkit anchors (e.g.
 * `moz-support-link` extends `HTMLAnchorElement` with
 * `customElements.define("moz-support-link", ..., { extends: "a" })`), and
 * the validator's `not-moz-lit-element` check must allow them through or
 * `furnace override` of a valid upstream component fails its own
 * `furnace validate` pass with nothing the operator can fix.
 */
function hasCustomElementExtendsOption(mjsContent: string): boolean {
  // Match `customElements.define(..., { ..., extends: "..." })`. Tolerant of
  // whitespace, line breaks, and other object properties. The `[^)]*` stops
  // the inner greedy match at the closing define call paren so a later
  // `define` call on a different custom element in the same module does
  // not bleed its options in.
  return /customElements\.define\s*\([^)]*\bextends\s*:\s*["'`]/.test(mjsContent);
}

/**
 * Checks whether a declared component class extends a valid element base.
 *
 * Two shapes are accepted:
 *
 * 1. Autonomous custom element: `class X extends MozLitElement` — the
 *    default FireForge pattern for fork-authored components and most
 *    toolkit widgets.
 * 2. Customized built-in: `class X extends HTML<Something>Element` paired
 *    with a `customElements.define(..., ..., { extends: "<tagname>" })`
 *    call. Firefox's `moz-support-link`, `moz-button-group` tabbing
 *    widgets, and a handful of other toolkit components use this form;
 *    `furnace override` of those components writes the original source
 *    verbatim and the validator must not reject them.
 *
 * A class that extends a plain `HTMLElement` WITHOUT a `extends:` option
 * is still rejected — that's the legitimate `not-moz-lit-element` case
 * the rule was originally designed to catch.
 */
export function classExtendsMozLitElement(mjsContent: string): boolean {
  const hasClassDeclaration = /class\s+\w+\s+extends\s+/.test(mjsContent);
  if (!hasClassDeclaration) {
    // No class declaration — skip this check since the component may use a
    // different pattern (e.g. function-based). Other validators will catch
    // structural issues.
    return true;
  }

  if (/class\s+\w+\s+extends\s+MozLitElement\b/.test(mjsContent)) {
    return true;
  }

  // Customized built-in: extend a specific HTMLxxxElement AND the define
  // call carries an `extends:` option. Both halves are required — a class
  // that extends `HTMLAnchorElement` without the matching define option is
  // almost certainly an author mistake, and a define call with `extends:`
  // without a matching class is unreachable.
  const extendsCustomizedBuiltin = /class\s+\w+\s+extends\s+HTML[A-Z]\w*Element\b/.test(mjsContent);
  if (extendsCustomizedBuiltin && hasCustomElementExtendsOption(mjsContent)) {
    return true;
  }

  return false;
}

/** Collects CSS custom property references used via var(--token-name). */
export function collectCssVariableReferences(cssContent: string): string[] {
  const referencedVariables: string[] = [];
  const variablePattern = /var\(\s*(--[\w-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = variablePattern.exec(cssContent)) !== null) {
    const variableName = match[1];
    if (variableName) {
      referencedVariables.push(variableName);
    }
  }

  return referencedVariables;
}

/**
 * Collects CSS custom property *declarations* — names appearing on the
 * left-hand side of a `--name:` declaration. Used to auto-exempt
 * component-local runtime variables from the token-prefix check: if the
 * component both declares and consumes a variable in its own CSS file, it
 * is a local runtime channel, not a design-token reference.
 *
 * The anchor `(?:^|[{;,\s])` rules out `var(--name)` occurrences (which are
 * always preceded by `(`), so references are not mistaken for declarations.
 */
export function collectCssVariableDeclarations(cssContent: string): Set<string> {
  const declared = new Set<string>();
  const pattern = /(?:^|[{;,\s])(--[\w-]+)\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cssContent)) !== null) {
    const name = match[1];
    if (name) declared.add(name);
  }
  return declared;
}

async function collectInheritedOverrideVariables(
  tagName: string,
  config: FurnaceConfig,
  root: string
): Promise<Set<string>> {
  const inheritedVariables = new Set<string>();
  const basePath = config.overrides[tagName]?.basePath;
  if (!basePath) {
    return inheritedVariables;
  }

  const { engine: engineDir } = getProjectPaths(root);
  const originalCssPath = join(engineDir, basePath, `${tagName}.css`);
  if (!(await pathExists(originalCssPath))) {
    return inheritedVariables;
  }

  const originalCssContent = stripCssBlockComments(await readText(originalCssPath));
  for (const variableName of collectCssVariableReferences(originalCssContent)) {
    inheritedVariables.add(variableName);
  }

  return inheritedVariables;
}

/** Builds token-validation context from the config allowlist and inherited override CSS. */
export async function getTokenPrefixContext(
  tagName: string,
  type: ComponentType,
  config: FurnaceConfig,
  root: string | undefined
): Promise<{
  allowlist: Set<string>;
  inheritedOverrideVars: Set<string>;
  runtimeVariables: Set<string>;
}> {
  const allowlist = new Set(config.tokenAllowlist ?? []);
  const runtimeVariables = new Set(config.runtimeVariables ?? []);
  if (type !== 'override' || !root) {
    return { allowlist, inheritedOverrideVars: new Set<string>(), runtimeVariables };
  }

  return {
    allowlist,
    inheritedOverrideVars: await collectInheritedOverrideVariables(tagName, config, root),
    runtimeVariables,
  };
}

/**
 * Flags engine-side files that a previous deploy of `tagName` left behind
 * after their workspace source was renamed or removed (field report D1).
 *
 * Detection keys on the furnace state file: every `appliedChecksums` entry
 * under `custom/<tagName>/` whose workspace source no longer exists but
 * whose engine target is still present is an orphan — the next deploy will
 * prune it, but until then jar.mn and the deployed directory disagree with
 * the workspace, and a re-export could capture the stale state into a patch.
 *
 * Custom components only: override undeploys restore the upstream baseline
 * rather than deleting files, so "orphan" has no meaning there.
 */
export async function findOrphanedEngineFiles(
  root: string,
  config: FurnaceConfig,
  tagName: string,
  state: { appliedChecksums?: Record<string, string> },
  ftlDir: string
): Promise<ValidationIssue[]> {
  const customConfig = config.custom[tagName];
  if (!customConfig) return [];

  const previous = extractComponentChecksums(state.appliedChecksums, 'custom', tagName);
  const fileNames = Object.keys(previous);
  if (fileNames.length === 0) return [];

  const { engine: engineDir, componentsDir } = getProjectPaths(root);
  const componentDir = join(componentsDir, 'custom', tagName);

  const issues: ValidationIssue[] = [];
  for (const fileName of fileNames) {
    if (await pathExists(join(componentDir, fileName))) continue;
    const enginePath = fileName.endsWith('.ftl')
      ? join(engineDir, ftlDir, fileName)
      : join(engineDir, customConfig.targetPath, fileName);
    if (!(await pathExists(enginePath))) continue;
    issues.push(
      createIssue(
        tagName,
        'warning',
        'orphaned-engine-file',
        `Engine file ${fileName} was deployed by a previous apply but its workspace source ` +
          `is gone (renamed or deleted). The deployed copy${customConfig.register ? ' and any stale jar.mn entry' : ''} ` +
          `will linger until the next deploy prunes it. Run "fireforge furnace deploy ${tagName}".`
      )
    );
  }
  return issues;
}
