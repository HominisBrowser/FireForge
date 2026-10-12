// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ValidationIssue } from '../../types/furnace.js';
import {
  parseOptInChecks,
  parseValidationExceptions,
} from '../furnace-config-validate-exceptions.js';
import { validateAccessibility } from '../furnace-validate-accessibility.js';
import {
  applyValidationExceptions,
  countValidationSeverities,
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

  it('suppresses every finding of the excepted check on the component only', () => {
    const outcome = applyValidationExceptions(
      [issue('a', 'x'), issue('a', 'x', 'error'), issue('b', 'x')],
      [{ component: 'a', check: 'x', reason: 'reviewed' }],
      () => true
    );
    expect(outcome.issues).toEqual([issue('b', 'x')]);
    expect(outcome.excepted).toHaveLength(2);
    expect(outcome.excepted[0]?.reason).toBe('reviewed');
    expect(outcome.stale).toEqual([]);
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
