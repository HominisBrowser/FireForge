// SPDX-License-Identifier: EUPL-1.2
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

import { elementJarEntry } from '../register/index.js';
import { SYNTHETIC_FIREFOX_FILES } from '../testing/firefox.js';
import {
  elementEntries,
  missingJarFiles,
  planJar,
  registerElement,
  unregisterElement,
} from './registration.js';

const JAR = String(SYNTHETIC_FIREFOX_FILES['toolkit/content/jar.mn']);
const ELEMENTS = String(SYNTHETIC_FIREFOX_FILES['toolkit/content/customElements.js']);

const lines = (text: string): string[] => text.split('\n');
const parses = (text: string): void => {
  parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
};

describe('planJar', () => {
  it('adds a component’s files among the element lines, in tag order, with the neighbour’s layout', () => {
    const wanted = ['moz-chip.mjs', 'moz-chip.css'].map((file) =>
      elementJarEntry('widgets/moz-chip', file)
    );
    const rows = lines(planJar(JAR, wanted, ['widgets/moz-chip']));
    const at = (needle: string): number => rows.findIndex((row) => row.includes(needle));
    expect(at('moz-card.mjs')).toBeLessThan(at('moz-chip.css'));
    expect(at('moz-chip.css')).toBeLessThan(at('moz-chip.mjs'));
    expect(at('moz-chip.mjs')).toBeLessThan(at('moz-toggle.mjs'));
    expect(rows[at('moz-chip.css')]).toBe(
      '   content/global/elements/moz-chip.css    (widgets/moz-chip/moz-chip.css)'
    );
  });

  it('keeps an existing line, never duplicating it', () => {
    const wanted = ['moz-card.css', 'moz-card.mjs'].map((file) =>
      elementJarEntry('widgets/moz-card', file)
    );
    expect(planJar(JAR, wanted, ['widgets/moz-card'])).toBe(JAR);
  });

  it('drops owned lines that are not wanted and leaves everything else, prefix names included', () => {
    const text = planJar(
      JAR,
      [elementJarEntry('widgets/moz-card', 'moz-card.mjs')],
      ['widgets/moz-card', 'widgets/moz-gone']
    );
    expect(text).not.toContain('moz-card.css');
    expect(text).toContain('moz-card.mjs');
    expect(text).toContain('moz-toggle.mjs');
    expect(text).toContain('findbar.js');
  });

  it('refuses a target upstream registers with another source', () => {
    const clash = [
      { target: 'content/global/elements/moz-toggle.mjs', source: 'widgets/x/moz-toggle.mjs' },
    ];
    expect(() => planJar(JAR, clash, ['widgets/x'])).toThrow(/different source/);
  });

  it('names the wanted lines a manifest lacks', () => {
    const wanted = [
      elementJarEntry('widgets/moz-card', 'moz-card.mjs'),
      elementJarEntry('widgets/moz-card', 'x.css'),
    ];
    expect(missingJarFiles(JAR, wanted)).toEqual([wanted[1]]);
  });
});

describe('registerElement', () => {
  it('lists a module element in the DOMContentLoaded list, in tag order, with the marker', () => {
    const text = registerElement(ELEMENTS, 'moz-chip', 'ACME');
    parses(text);
    const rows = lines(text);
    const chip = rows.findIndex((row) => row.includes('"moz-chip"'));
    expect(rows[chip]).toBe(
      '      ["moz-chip", "chrome://global/content/elements/moz-chip.mjs"],  // ACME:'
    );
    expect(rows[chip - 1]).toContain('"moz-card"');
    expect(elementEntries(text).find((entry) => entry.tag === 'moz-chip')?.module).toBe(true);
  });

  it('copies a multi-line neighbour', () => {
    const text = registerElement(ELEMENTS, 'moz-tree', 'ACME');
    parses(text);
    expect(text).toContain(
      [
        '      [  // ACME:',
        '        "moz-tree",  // ACME:',
        '        "chrome://global/content/elements/moz-tree.mjs",  // ACME:',
        '      ],  // ACME:',
      ].join('\n')
    );
  });

  it('adds a comma after a last entry that has none', () => {
    const text = 'for (let [t, s] of x) {}\nlet x = [\n  ["moz-a", "a.mjs"]\n];\n';
    const wrapped = `document.addEventListener("DOMContentLoaded", () => { for (let [t, s] of list) {} });\nlet list = [\n  ["moz-a", "a.mjs"]\n];\n`;
    expect(() => registerElement(text, 'moz-b', 'M')).toThrow(/DOMContentLoaded/);
    const next = registerElement(wrapped, 'moz-b', 'M');
    parses(next);
    expect(elementEntries(next).map((entry) => entry.tag)).toEqual(['moz-a', 'moz-b']);
  });

  it('changes nothing for a listed module element or one with its own callback', () => {
    expect(registerElement(ELEMENTS, 'moz-card', 'ACME')).toBe(ELEMENTS);
    const own = `${ELEMENTS}customElements.setElementCreationCallback("moz-own", () => {});\n`;
    expect(registerElement(own, 'moz-own', 'ACME')).toBe(own);
  });

  it('moves an element listed among the subscripts into the module list', () => {
    const text = registerElement(ELEMENTS, 'menulist', 'ACME');
    parses(text);
    const entries = elementEntries(text).filter((entry) => entry.tag === 'menulist');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.module).toBe(true);
  });

  it('refuses a file that does not parse', () => {
    expect(() => registerElement('for (let [a] of [', 'moz-x', 'M')).toThrow(/does not parse/);
  });
});

describe('unregisterElement', () => {
  it('removes a single-line entry with its marker and line', () => {
    const added = registerElement(ELEMENTS, 'moz-chip', 'ACME');
    expect(unregisterElement(added, 'moz-chip')).toBe(ELEMENTS);
  });

  it('removes a multi-line entry and keeps the file valid', () => {
    const text = unregisterElement(ELEMENTS, 'moz-toggle');
    parses(text);
    expect(text).not.toContain('moz-toggle');
    expect(text).toContain('"moz-card"');
  });

  it('leaves a file without the tag alone, and never touches a same-named literal outside a list', () => {
    const text = `${ELEMENTS}const unrelated = ["moz-x", "y"];\n`;
    expect(unregisterElement(text, 'moz-x')).toBe(text);
  });
});
