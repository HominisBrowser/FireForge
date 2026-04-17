// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { ComponentType, FurnaceConfig, ValidationIssue } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import { getProjectPaths } from './config.js';

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

/** Detects form inputs without associated labels. */
export function hasUnlabelledFormInput(content: string): boolean {
  // Look for <input> or <select> or <textarea> without aria-label, aria-labelledby, or id
  // (id implies an external <label for="..."> could exist)
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

function isSymbolOnlyText(text: string): boolean {
  return Array.from(text).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0xff || '+-*=<>|/\\^~@#&!?%'.includes(character);
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

/** Detects hardcoded user-visible template text that should usually be localized. */
export function containsHardcodedTemplateText(content: string): boolean {
  if (/furnace-ignore:\s*hardcoded-text/.test(content)) {
    return false;
  }

  const textPattern = />([^<$\s][^<$]*)</g;
  let textMatch: RegExpExecArray | null;
  while ((textMatch = textPattern.exec(content)) !== null) {
    const text = textMatch[1]?.trim() ?? '';
    if (/\$\{/.test(text)) {
      continue;
    }

    if (Array.from(text).length <= 1) {
      continue;
    }

    if (isSymbolOnlyText(text)) {
      continue;
    }

    if (isWithinLocalizedElement(content, textMatch.index)) {
      continue;
    }

    return true;
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

/** Checks whether a declared component class extends MozLitElement. */
export function classExtendsMozLitElement(mjsContent: string): boolean {
  const hasClassDeclaration = /class\s+\w+\s+extends\s+/.test(mjsContent);
  if (!hasClassDeclaration) {
    // No class declaration — skip this check since the component may use a
    // different pattern (e.g. function-based). Other validators will catch
    // structural issues.
    return true;
  }

  return /class\s+\w+\s+extends\s+MozLitElement\b/.test(mjsContent);
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
): Promise<{ allowlist: Set<string>; inheritedOverrideVars: Set<string> }> {
  const allowlist = new Set(config.tokenAllowlist ?? []);
  if (type !== 'override' || !root) {
    return { allowlist, inheritedOverrideVars: new Set<string>() };
  }

  return {
    allowlist,
    inheritedOverrideVars: await collectInheritedOverrideVariables(tagName, config, root),
  };
}
