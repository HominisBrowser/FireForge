// SPDX-License-Identifier: EUPL-1.2
import { tokenizer } from 'acorn';

/** Collects Lit html quasis, masking expressions while preserving nested templates. */
export function collectLitTemplateRegions(content: string): string[] {
  const regions: string[] = [];
  const stack: Array<{ html: boolean; text: string }> = [];
  let previous = '';
  let previousValue: unknown;
  try {
    for (const token of tokenizer(content, { ecmaVersion: 'latest', sourceType: 'module' })) {
      const label = token.type.label;
      if (label === '`') {
        if (previous === 'template' || previous === 'invalidTemplate') {
          const closed = stack.pop();
          if (closed?.html) regions.push(closed.text);
        } else {
          stack.push({ html: previous === 'name' && previousValue === 'html', text: '' });
        }
      } else if (label === 'template') {
        const current = stack.at(-1);
        if (current) current.text += content.slice(token.start, token.end);
      } else if (label === '${') {
        const current = stack.at(-1);
        if (current) current.text += '${expression}';
      }
      previous = label;
      previousValue = content.slice(token.start, token.end);
    }
  } catch {
    // Keep completed regions from a file being edited; never re-pair backticks.
  }
  return regions;
}

/** Reads actual attribute names and values, skipping quoted values as indivisible tokens. */
export function parseTemplateAttributes(source: string): Map<string, string | undefined> {
  const attributes = new Map<string, string | undefined>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return attributes;
}
