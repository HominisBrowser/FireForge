// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared CSS fragment markers. A component stylesheet names a fragment of
 * shared rules with a directive on its own line; its deployed copy has the
 * fragment inlined after the directive and fenced by a matching end line:
 *
 *     /* @fireforge-include base-button.css *\/
 *     ...the fragment's text...
 *     /* @fireforge-end-include base-button.css *\/
 */

const INCLUDE = /^\s*\/\*\s*@fireforge-include\s+([\w./-]+)\s*\*\/\s*$/;
const END = /^\s*\/\*\s*@fireforge-end-include\s+([\w./-]+)\s*\*\/\s*$/;

/**
 * The fragment a line includes, or undefined when it is no include directive.
 *
 * @param line - One line of a stylesheet
 */
export function fragmentInclude(line: string): string | undefined {
  return INCLUDE.exec(line)?.[1];
}

/**
 * The end marker of a fragment.
 *
 * @param name - The fragment
 */
export function fragmentEnd(name: string): string {
  return `/* @fireforge-end-include ${name} */`;
}

/**
 * The fenced expansions of a stylesheet's lines: each directive and the
 * line of its matching end marker. A directive without one is not fenced.
 *
 * @param lines - The stylesheet's lines
 * @returns Zero-based `[directive, end]` line pairs, in order
 */
export function fragmentExpansions(lines: readonly string[]): [number, number][] {
  const fenced: [number, number][] = [];
  for (let index = 0; index < lines.length; index++) {
    const name = fragmentInclude(lines[index] ?? '');
    if (name === undefined) continue;
    const end = lines.findIndex((line, at) => at > index && END.exec(line)?.[1] === name);
    if (end === -1) continue;
    fenced.push([index, end]);
    index = end;
  }
  return fenced;
}

/**
 * The fragment names a stylesheet includes, in order, each once.
 *
 * @param css - Stylesheet text
 */
export function fragmentIncludes(css: string): string[] {
  const names: string[] = [];
  for (const line of css.split('\n')) {
    const name = fragmentInclude(line);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}
