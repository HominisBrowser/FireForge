// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ValidationIssue } from '../../types/furnace.js';
import {
  parseMinComponents,
  parseOptInChecks,
  parseTokenSiblingSheets,
  parseValidationExceptions,
} from '../furnace-config-validate-exceptions.js';
import { validateAccessibility } from '../furnace-validate-accessibility.js';
import {
  applyValidationExceptions,
  countValidationSeverities,
  EXCEPTION_ON_ERROR_CHECK,
  STALE_VALIDATION_EXCEPTION_CHECK,
} from '../furnace-validate-exceptions.js';
import { countUnlabelledIconButtons } from '../furnace-validate-icon-button.js';

const issue = (
  component: string,
  check: string,
  severity: 'error' | 'warning' = 'warning'
): ValidationIssue => ({ component, check, severity, message: `${check} on ${component}` });

describe('parseValidationExceptions', () => {
  it('accepts well-formed entries', () => {
    expect(
      parseValidationExceptions([{ component: 'moz-a', check: 'no-aria-role', reason: 'native' }])
    ).toEqual([{ component: 'moz-a', check: 'no-aria-role', reason: 'native' }]);
  });

  it.each<[string, unknown, RegExp]>([
    ['a non-array', {}, /"validationExceptions" must be an array/],
    ['a non-object entry', ['x'], /"validationExceptions\[0\]" must be an object/],
    [
      'an unknown key',
      [{ component: 'a', check: 'b', reason: 'c', extra: 1 }],
      /has unknown key "extra"/,
    ],
    ['a missing reason', [{ component: 'a', check: 'b' }], /\.reason" must be a non-empty string/],
    [
      'a blank component',
      [{ component: ' ', check: 'b', reason: 'c' }],
      /\.component" must be a non-empty string/,
    ],
    [
      'a duplicate component and check',
      [
        { component: 'a', check: 'b', reason: 'c' },
        { component: 'a', check: 'b', reason: 'd' },
      ],
      /repeats the exception for a \[b\]/,
    ],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parseValidationExceptions(raw)).toThrow(message);
  });
});

describe('parseOptInChecks', () => {
  it('accepts known checks and de-duplicates', () => {
    expect(parseOptInChecks(['icon-button-label', 'icon-button-label'])).toEqual([
      'icon-button-label',
    ]);
  });

  it('refuses a non-array and an unknown check', () => {
    expect(() => parseOptInChecks('icon-button-label')).toThrow('must be an array');
    expect(() => parseOptInChecks(['nope'])).toThrow(
      '"optInChecks" entry "nope" is not an opt-in check. Valid: icon-button-label'
    );
  });
});

describe('applyValidationExceptions', () => {
  it('passes findings through untouched without exceptions', () => {
    const issues = [issue('a', 'x')];
    expect(applyValidationExceptions(issues, undefined, () => true)).toEqual({
      issues,
      excepted: [],
      stale: [],
    });
  });

  it('suppresses every warning of the excepted check on the component only', () => {
    const outcome = applyValidationExceptions(
      [issue('a', 'x'), issue('a', 'x'), issue('b', 'x')],
      [{ component: 'a', check: 'x', reason: 'reviewed' }],
      () => true
    );
    expect(outcome.issues).toEqual([issue('b', 'x')]);
    expect(outcome.excepted).toHaveLength(2);
    expect(outcome.excepted[0]?.reason).toBe('reviewed');
    expect(outcome.stale).toEqual([]);
  });

  it('never suppresses an error, and reports the exception that tried', () => {
    const outcome = applyValidationExceptions(
      [issue('a', 'x', 'error')],
      [{ component: 'a', check: 'x', reason: 'reviewed' }],
      () => true
    );
    expect(outcome.excepted).toEqual([]);
    expect(outcome.stale).toEqual([]);
    expect(outcome.issues).toEqual([
      issue('a', 'x', 'error'),
      expect.objectContaining({
        component: 'a',
        severity: 'error',
        check: EXCEPTION_ON_ERROR_CHECK,
      }),
    ]);
  });

  it('suppresses a tagged finding only when its tag entries cover every tag', () => {
    const tagged = (tags: string[]): ValidationIssue => ({
      ...issue('a', 'no-keyboard-handler'),
      tags,
    });
    const exceptions = [
      { component: 'a', check: 'no-keyboard-handler', tag: 'panel-item', reason: 'menu row' },
      { component: 'a', check: 'no-keyboard-handler', tag: 'li', reason: 'list row' },
    ];
    const covered = applyValidationExceptions(
      [tagged(['panel-item', 'li'])],
      exceptions,
      () => true
    );
    expect(covered.issues).toEqual([]);
    expect(covered.excepted[0]?.reason).toBe('menu row; list row');

    const partial = applyValidationExceptions(
      [tagged(['panel-item', 'div'])],
      exceptions,
      () => true
    );
    expect(partial.issues).toHaveLength(2);
    expect(partial.issues[0]?.tags).toEqual(['panel-item', 'div']);
    // The panel-item entry is in use; only the li entry is stale.
    expect(partial.stale).toEqual([exceptions[1]]);
  });

  it('suppresses a file-scoped finding only when its file entries cover every file', () => {
    const inFiles = (files: string[]): ValidationIssue => ({
      ...issue('a', 'hardcoded-text'),
      files,
    });
    const vendor = {
      component: 'a',
      check: 'hardcoded-text',
      file: 'a-vendor.mjs',
      reason: 'pinned bundle',
    };
    const covered = applyValidationExceptions([inFiles(['a-vendor.mjs'])], [vendor], () => true);
    expect(covered.issues).toEqual([]);
    expect(covered.excepted[0]?.reason).toBe('pinned bundle');

    // An authored module beside the bundle keeps the check.
    const partial = applyValidationExceptions(
      [inFiles(['a-vendor.mjs', 'a-panel.mjs'])],
      [vendor],
      () => true
    );
    expect(partial.issues).toEqual([inFiles(['a-vendor.mjs', 'a-panel.mjs'])]);
    expect(partial.stale).toEqual([]);

    // A file entry does not cover a tag-scoped finding.
    const tagged = applyValidationExceptions(
      [{ ...issue('a', 'hardcoded-text'), tags: ['a-vendor.mjs'] }],
      [vendor],
      () => true
    );
    expect(tagged.issues).toHaveLength(2);
    expect(tagged.stale).toEqual([vendor]);
  });

  it('reports an unused exception as stale only when its component was judged', () => {
    const exceptions = [
      { component: 'a', check: 'x', reason: 'r' },
      { component: 'b', check: 'y', reason: 'r' },
    ];
    const outcome = applyValidationExceptions([], exceptions, (component) => component === 'a');
    expect(outcome.stale).toEqual([exceptions[0]]);
    expect(outcome.issues).toEqual([
      expect.objectContaining({
        component: 'a',
        severity: 'warning',
        check: STALE_VALIDATION_EXCEPTION_CHECK,
      }),
    ]);
  });

  it('counts severities', () => {
    expect(countValidationSeverities([issue('a', 'x'), issue('a', 'y', 'error')])).toEqual({
      errors: 1,
      warnings: 1,
    });
  });
});

describe('countUnlabelledIconButtons', () => {
  const module = (template: string): string =>
    `import { html } from "chrome://global/content/vendor/lit.all.mjs";\n` +
    `export const render = () => html\`${template}\`;\n`;

  it('flags icon-only buttons with no accessible name', () => {
    expect(
      countUnlabelledIconButtons(
        module(
          '<moz-button type="icon" iconsrc="chrome://x.svg"></moz-button>' +
            '<moz-button type="icon ghost" @click=${this.go}></moz-button>' +
            '<moz-button .iconSrc=${this.icon}></moz-button>'
        )
      )
    ).toBe(3);
  });

  it('accepts data-l10n-id, aria-label and the ariaLabel property', () => {
    expect(
      countUnlabelledIconButtons(
        module(
          '<moz-button type="icon" data-l10n-id="close"></moz-button>' +
            '<moz-button iconsrc="x.svg" aria-label=${this.label}></moz-button>' +
            '<moz-button type="icon" .ariaLabel=${this.label}></moz-button>'
        )
      )
    ).toBe(0);
  });

  it('ignores buttons with a label or text, and non-icon buttons', () => {
    expect(
      countUnlabelledIconButtons(
        module(
          '<moz-button type="icon" label="Close"></moz-button>' +
            '<moz-button iconsrc="x.svg">Close</moz-button>' +
            '<moz-button type="primary"></moz-button>'
        )
      )
    ).toBe(0);
  });

  it('reads only text outside tags as a visible label', () => {
    expect(
      countUnlabelledIconButtons(
        module(
          '<moz-button iconsrc="x.svg"><img src="x.svg"> </moz-button>' +
            '<moz-button iconsrc="x.svg"><span class="icon" title="a > b"></span></moz-button>' +
            '<moz-button iconsrc="x.svg"><span>Close</span></moz-button>'
        )
      )
    ).toBe(2);
  });

  it('ignores markup outside Lit templates', () => {
    expect(
      countUnlabelledIconButtons('const s = "<moz-button type=\\"icon\\"></moz-button>";')
    ).toBe(0);
  });
});

describe('validateAccessibility icon-button-label opt-in', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ff-icon-button-'));
    await writeFile(
      join(dir, 'moz-tool.mjs'),
      'import { html } from "lit";\n' +
        'export const t = () => html`<moz-button type="icon" iconsrc="a.svg"></moz-button>`;\n'
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stays silent unless furnace.json opts in', async () => {
    const issues = await validateAccessibility(dir, 'moz-tool');
    expect(issues.some((entry) => entry.check === 'icon-button-label')).toBe(false);
  });

  it('warns once per module, counting the unlabelled buttons, when opted in', async () => {
    const issues = await validateAccessibility(dir, 'moz-tool', undefined, ['icon-button-label']);
    expect(issues).toContainEqual({
      component: 'moz-tool',
      severity: 'warning',
      check: 'icon-button-label',
      message:
        '1 icon-only <moz-button> without an accessible name. Add data-l10n-id (with the label in its Fluent message) or aria-label.',
    });
  });
});

describe('validateAccessibility judges the composed component', () => {
  let dir: string;
  const lit = 'import { html } from "lit";\n';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ff-composed-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads companion modules beside the host, and names the synthetic tags', async () => {
    await writeFile(join(dir, 'moz-menu.mjs'), `${lit}export const host = 1;\n`);
    await writeFile(
      join(dir, 'moz-menu-row.mjs'),
      `${lit}export const t = () => html\`<div @click=\${go}>Row</div>\`;\n`
    );
    await writeFile(
      join(dir, 'moz-menu-row.test.mjs'),
      `${lit}export const t = () => html\`<span @click=\${go}></span>\`;\n`
    );
    const finding = (await validateAccessibility(dir, 'moz-menu')).find(
      (entry) => entry.check === 'no-keyboard-handler'
    );
    expect(finding?.tags).toEqual(['div']);
    expect(finding?.message).toContain('on <div>');
  });

  it('names the modules a hardcoded-text finding is in, each judged on its own', async () => {
    await writeFile(join(dir, 'moz-editor.mjs'), `${lit}export const host = 1;\n`);
    await writeFile(
      join(dir, 'moz-editor-vendor.mjs'),
      'probe.textContent = "abc def ghi jkl mno pqr stu";\n'
    );
    await writeFile(
      join(dir, 'moz-editor-ignored.mjs'),
      '// furnace-ignore: hardcoded-text\nnode.textContent = "Not judged";\n'
    );
    const finding = (await validateAccessibility(dir, 'moz-editor')).find(
      (entry) => entry.check === 'hardcoded-text'
    );
    expect(finding?.files).toEqual(['moz-editor-vendor.mjs']);
    expect(finding?.message).toContain('in moz-editor-vendor.mjs');
  });

  it('counts a keyboard handler in a companion for a click in the host', async () => {
    await writeFile(
      join(dir, 'moz-menu.mjs'),
      `${lit}export const t = () => html\`<div @click=\${go}>Row</div>\`;\n`
    );
    await writeFile(
      join(dir, 'moz-menu-keys.mjs'),
      `${lit}export const k = () => html\`<div @keydown=\${key}></div>\`;\n`
    );
    const issues = await validateAccessibility(dir, 'moz-menu');
    expect(issues.some((entry) => entry.check === 'no-keyboard-handler')).toBe(false);
  });

  it('treats a toolkit panel-item as natively keyboard-activated', async () => {
    await writeFile(
      join(dir, 'moz-menu.mjs'),
      `${lit}export const t = () => html\`<panel-list><panel-item @click=\${go}>Import</panel-item></panel-list>\`;\n`
    );
    const issues = await validateAccessibility(dir, 'moz-menu');
    expect(issues.some((entry) => entry.check === 'no-keyboard-handler')).toBe(false);
  });
});

describe('parseValidationExceptions tag', () => {
  it('accepts a tag and keys duplicates by it', () => {
    const entries = [
      { component: 'moz-a', check: 'no-keyboard-handler', tag: 'li', reason: 'r' },
      { component: 'moz-a', check: 'no-keyboard-handler', tag: 'div', reason: 'r' },
    ];
    expect(parseValidationExceptions(entries)).toEqual(entries);
    expect(() => parseValidationExceptions([entries[0], entries[0]])).toThrow(/on <li>/);
  });
});

describe('parseValidationExceptions file', () => {
  it('accepts a file name and keys duplicates by it', () => {
    const entries = [
      { component: 'moz-a', check: 'hardcoded-text', file: 'moz-a-vendor.mjs', reason: 'r' },
      { component: 'moz-a', check: 'hardcoded-text', reason: 'r' },
    ];
    expect(parseValidationExceptions(entries)).toEqual(entries);
    expect(() => parseValidationExceptions([entries[0], entries[0]])).toThrow(
      /in moz-a-vendor\.mjs/
    );
  });

  it('refuses a path, and a tag beside a file', () => {
    const base = { component: 'moz-a', check: 'hardcoded-text', reason: 'r' };
    for (const file of ['vendor/a.mjs', '..', 'a\\b.mjs']) {
      expect(() => parseValidationExceptions([{ ...base, file }])).toThrow(/not a path/);
    }
    expect(() =>
      parseValidationExceptions([{ ...base, file: 'moz-a-vendor.mjs', tag: 'div' }])
    ).toThrow(/a "tag" or a "file", not both/);
  });
});

describe('furnace.json minComponents and tokenSiblingSheets', () => {
  it('parses a positive floor and refuses anything else', () => {
    expect(parseMinComponents(3)).toBe(3);
    for (const bad of [0, -1, 1.5, '2']) {
      expect(() => parseMinComponents(bad)).toThrow(/"minComponents" must be a positive integer/);
    }
  });

  it('parses sibling sheet partners and refuses empty lists and traversal', () => {
    const raw = { 'browser/**/*.css': ['browser/base/host.css'] };
    expect(parseTokenSiblingSheets(raw)).toEqual(raw);
    expect(() => parseTokenSiblingSheets([])).toThrow(/must be an object/);
    expect(() => parseTokenSiblingSheets({ 'a.css': [] })).toThrow(/non-empty list/);
    expect(() => parseTokenSiblingSheets({ 'a.css': ['../x.css'] })).toThrow(/no "\.\."/);
  });
});
