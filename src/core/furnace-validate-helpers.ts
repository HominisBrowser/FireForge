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

/** Detects Lit-style template click handlers. */
export function hasTemplateClickHandler(content: string): boolean {
  return /@click\s*=\s*\$\{/.test(content);
}

/** Detects Lit-style template keyboard handlers. */
export function hasTemplateKeyboardHandler(content: string): boolean {
  return /@key(down|press|up)\s*=\s*\$\{/.test(content);
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
