// SPDX-License-Identifier: EUPL-1.2
/**
 * Top-level chrome document — DOM fragment insertion.
 *
 * Default target is `browser/base/content/browser.xhtml`. Forks that replace
 * browser.xhtml with a custom top-level chrome document pass the replacement
 * path in via `targetPath`; the insertion logic is shape-agnostic (looks for
 * `#include browser-sets.inc`, then falls back to `<html:body>`), so any
 * browser.xhtml-shaped xhtml works.
 */

import { dirname, join, relative } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { toRootRelativePath } from '../utils/paths.js';
import { escapeRegex } from '../utils/regex.js';
import { withParserFallback } from './parser-fallback.js';
import { tokenizeXhtml } from './wire-utils.js';

export const DEFAULT_DOM_TARGET = 'browser/base/content/browser.xhtml';

/**
 * Tokenizer-based implementation for DOM fragment insertion.
 */
export function addDomFragmentTokenized(content: string, includeDirective: string): string {
  const lines = content.split('\n');
  const tokens = tokenizeXhtml(lines);

  // Find the #include browser-sets.inc token
  let insertIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token && token.type === 'macro' && token.raw.includes('browser-sets.inc')) {
      insertIndex = i;
      break;
    }
  }

  if (insertIndex === -1) {
    // Fallback: after <html:body>
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token && token.type === 'xml' && /<html:body/.test(token.raw)) {
        insertIndex = i + 1;
        break;
      }
    }
  }

  if (insertIndex === -1) {
    throw new GeneralError('Could not find insertion point in chrome document');
  }

  lines.splice(insertIndex, 0, includeDirective);
  return lines.join('\n');
}

/**
 * Legacy line-based implementation preserved as fallback.
 */
export function legacyAddDomFragment(content: string, includeDirective: string): string {
  const lines = content.split('\n');

  let insertIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/browser-sets\.inc/.test(line)) {
      insertIndex = i;
      break;
    }
  }

  if (insertIndex === -1) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (/<html:body/.test(line)) {
        insertIndex = i + 1;
        break;
      }
    }
  }

  if (insertIndex === -1) {
    throw new GeneralError('Could not find insertion point in chrome document');
  }

  lines.splice(insertIndex, 0, includeDirective);
  return lines.join('\n');
}

/**
 * Dry-run precheck for `addDomFragment`. Reads the resolved chrome
 * document and verifies it either already contains the `#include`
 * directive (the idempotent-skip case) OR offers a locatable insertion
 * point via {@link addDomFragmentTokenized} / {@link legacyAddDomFragment}.
 * Throws the same `Could not find insertion point in chrome document`
 * error the real run would throw when neither condition holds.
 *
 * Motivating case (2026-04-21 eval, Finding #12): `fireforge wire ...
 * --dry-run` previewed a plausible mutation plan against
 * `tokenHostDocuments[0]`, then `fireforge wire ...` without
 * `--dry-run` threw `Could not find insertion point in chrome document`
 * on the same arguments. The real run had always called the insertion
 * helpers; dry-run did not. This helper runs the same check in the
 * preview pass so plan and execution disagree less.
 */
export async function probeDomFragmentInsertionPoint(
  engineDir: string,
  domFilePath: string,
  targetPath: string = DEFAULT_DOM_TARGET
): Promise<void> {
  const targetAbsPath = join(engineDir, targetPath);
  if (!(await pathExists(targetAbsPath))) {
    // The callers in `wire.ts` run their own existence probe before
    // invoking this helper, but a well-behaved probe is paranoid — if
    // something changed between the two checks, fail with the same
    // error the real run would surface.
    throw new GeneralError(`${targetPath} not found in engine`);
  }

  const safeDomFilePath = toRootRelativePath(engineDir, domFilePath);
  const targetDir = dirname(targetPath);
  const includePath = relative(targetDir, safeDomFilePath).replace(/\\/g, '/');
  const includeDirective = `#include ${includePath}`;

  const content = await readText(targetAbsPath);
  if (new RegExp(`^${escapeRegex(includeDirective)}$`, 'm').test(content)) {
    // Already wired — the real run would idempotent-skip here, so
    // dry-run is allowed to proceed too.
    return;
  }

  // Check the tokenised and legacy insertion paths symmetrically with
  // the real run. Either helper returning without throwing is sufficient
  // evidence that the real run can land the directive.
  withParserFallback(
    () => addDomFragmentTokenized(content, includeDirective),
    () => legacyAddDomFragment(content, includeDirective),
    targetPath
  );
}

/**
 * Inserts a `#include` directive for an `.inc.xhtml` file into the top-level
 * chrome document (default: `browser/base/content/browser.xhtml`), before
 * `#include browser-sets.inc`.
 *
 * If the file's content was previously inlined (detected by root element id=),
 * the inlined block is automatically replaced with the `#include` directive.
 *
 * @param engineDir - Engine source root
 * @param domFilePath - Path to the `.inc.xhtml` file relative to engine root
 * @param targetPath - Chrome document to insert into, relative to engine
 *   root. Defaults to {@link DEFAULT_DOM_TARGET}. Forks that replace
 *   browser.xhtml with a custom top-level chrome document pass the
 *   replacement path here.
 * @returns true if inserted, false if already present
 */
export async function addDomFragment(
  engineDir: string,
  domFilePath: string,
  targetPath: string = DEFAULT_DOM_TARGET
): Promise<boolean> {
  const targetAbsPath = join(engineDir, targetPath);
  const safeDomFilePath = toRootRelativePath(engineDir, domFilePath);

  if (!(await pathExists(targetAbsPath))) {
    throw new GeneralError(`${targetPath} not found in engine`);
  }

  // Compute include path relative to the target's directory — the `#include`
  // directive is resolved by the preprocessor relative to the file that
  // contains it, so this must track the chrome doc's location, not a
  // hardcoded `browser/base/content/`.
  const targetDir = dirname(targetPath);
  const includePath = relative(targetDir, safeDomFilePath).replace(/\\/g, '/');
  const includeDirective = `#include ${includePath}`;

  let content = await readText(targetAbsPath);

  // Idempotency: check if the #include directive already exists (line-anchored to avoid substring matches)
  if (new RegExp(`^${escapeRegex(includeDirective)}$`, 'm').test(content)) {
    return false;
  }

  // Migration: check if inlined content from this file exists (by id= match)
  // and replace it with the #include directive
  const domFileFullPath = join(engineDir, safeDomFilePath);
  if (await pathExists(domFileFullPath)) {
    const domContent = await readText(domFileFullPath);
    const idMatch = /id\s*=\s*["']([^"']+)["']/.exec(domContent);
    if (idMatch && content.includes(`id="${idMatch[1]}"`)) {
      const lines = content.split('\n');
      const rootId = idMatch[1];
      const startIdx = lines.findIndex((l) => l.includes(`id="${rootId}"`));
      if (startIdx !== -1) {
        let endIdx = startIdx;
        for (let i = startIdx; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (i > startIdx && (/^#include\s/.test(line.trim()) || line.trim() === '')) {
            endIdx = i;
            break;
          }
          endIdx = i + 1;
        }
        lines.splice(startIdx, endIdx - startIdx, includeDirective);
        content = lines.join('\n');
        await writeText(targetAbsPath, content);
        return true;
      }
    }
  }

  // Normal insertion
  const { value } = withParserFallback(
    () => addDomFragmentTokenized(content, includeDirective),
    () => legacyAddDomFragment(content, includeDirective),
    targetPath
  );

  await writeText(targetAbsPath, value);
  return true;
}
