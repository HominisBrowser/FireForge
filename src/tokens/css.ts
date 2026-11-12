// SPDX-License-Identifier: EUPL-1.2
/**
 * Finding and editing the blocks of the token file: the base `:root`, the
 * custom properties written directly in a block, and splicing declarations
 * into a block's lines. Parsing is `src/syntax`'s.
 */
import {
  type CssBlock,
  type CssDeclaration,
  customProperties,
  type Stylesheet,
} from '../syntax/index.js';

/** The base `:root` block: the first top-level rule that has `:root` as one of its selectors. */
export function baseRoot(sheet: Stylesheet): CssBlock | undefined {
  return sheet.blocks.find(
    (block) =>
      block.parent === undefined &&
      block.selector.split(',').some((part) => part.trim() === ':root')
  );
}

/** The custom properties written directly in a block. */
export function declarationsIn(sheet: Stylesheet, block: CssBlock): CssDeclaration[] {
  return customProperties(sheet).filter((declaration) => declaration.block === block);
}

/**
 * Gives a block's closing brace its own line, so a declaration can go in
 * front of it. A rule written on one line, or closed after a declaration,
 * is split. Mutates `lines`.
 *
 * @returns The line now holding the closing brace
 */
export function isolateClose(lines: string[], block: CssBlock): number {
  const line = lines[block.close] ?? '';
  const indent = /^\s*/.exec(lines[block.open] ?? '')?.[0] ?? '';
  const tail = `${indent}${line.slice(block.closeCol)}`;
  if (block.open === block.close) {
    const body = line.slice(block.openCol + 1, block.closeCol).trim();
    const replacement = [
      line.slice(0, block.openCol + 1),
      ...(body === '' ? [] : [`${indent}  ${body}`]),
      tail,
    ];
    lines.splice(block.close, 1, ...replacement);
    return block.close + replacement.length - 1;
  }
  const before = line.slice(0, block.closeCol);
  if (before.trim() === '') return block.close;
  lines.splice(block.close, 1, before.trimEnd(), tail);
  return block.close + 1;
}

/**
 * Adds lines at the end of a block's content, after its last non-blank line.
 * Mutates `lines`.
 */
export function appendToBlock(lines: string[], block: CssBlock, add: readonly string[]): void {
  const close = isolateClose(lines, block);
  let at = close;
  for (let i = close - 1; i > block.open; i--) {
    if ((lines[i] ?? '').trim() !== '') {
      at = i + 1;
      break;
    }
  }
  lines.splice(at, 0, ...add);
}
