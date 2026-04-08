// SPDX-License-Identifier: EUPL-1.2
/**
 * browser.xhtml — DOM fragment insertion.
 */

import { join, relative } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { toRootRelativePath } from '../utils/paths.js';
import { escapeRegex } from '../utils/regex.js';
import { withParserFallback } from './parser-fallback.js';
import { tokenizeXhtml } from './wire-utils.js';

const BROWSER_XHTML = 'browser/base/content/browser.xhtml';

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
    throw new GeneralError('Could not find insertion point in browser.xhtml');
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
    throw new GeneralError('Could not find insertion point in browser.xhtml');
  }

  lines.splice(insertIndex, 0, includeDirective);
  return lines.join('\n');
}

/**
 * Inserts a `#include` directive for an `.inc.xhtml` file into browser.xhtml,
 * before `#include browser-sets.inc`.
 *
 * If the file's content was previously inlined (detected by root element id=),
 * the inlined block is automatically replaced with the `#include` directive.
 *
 * @param engineDir - Engine source root
 * @param domFilePath - Path to the `.inc.xhtml` file relative to engine root
 * @returns true if inserted, false if already present
 */
export async function addDomFragment(engineDir: string, domFilePath: string): Promise<boolean> {
  const browserXhtmlPath = join(engineDir, BROWSER_XHTML);
  const safeDomFilePath = toRootRelativePath(engineDir, domFilePath);

  if (!(await pathExists(browserXhtmlPath))) {
    throw new GeneralError(`${BROWSER_XHTML} not found in engine`);
  }

  // Compute include path relative to browser/base/content/ (where browser.xhtml lives)
  const includePath = relative('browser/base/content', safeDomFilePath).replace(/\\/g, '/');
  const includeDirective = `#include ${includePath}`;

  let content = await readText(browserXhtmlPath);

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
        await writeText(browserXhtmlPath, content);
        return true;
      }
    }
  }

  // Normal insertion
  const { value } = withParserFallback(
    () => addDomFragmentTokenized(content, includeDirective),
    () => legacyAddDomFragment(content, includeDirective),
    BROWSER_XHTML
  );

  await writeText(browserXhtmlPath, value);
  return true;
}
