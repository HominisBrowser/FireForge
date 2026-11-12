// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { makeFurnaceFixture } from '../testing/furnace.js';
import { useTempDir } from '../testing/temp.js';
import {
  applyComponents,
  validateComponents,
  validationPasses,
  type ValidationReport,
} from './index.js';
import { hasHardcodedText } from './validate.js';

const dir = useTempDir();

const CLEAN_MJS = `import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
export default class MozAcmeX extends MozLitElement {
  static shadowRootOptions = { ...MozLitElement.shadowRootOptions, delegatesFocus: true };
  render() {
    return html\`<button @click=\${this.go} data-l10n-id="x-go"></button>\`;
  }
}
customElements.define("moz-acme-x", MozAcmeX);
`;
const CLEAN_CSS = ':host { color: var(--acme-text); }\n';

const entry = {
  description: '',
  targetPath: 'toolkit/content/widgets/moz-acme-x',
  register: true,
  localized: false,
};

async function validate(
  files: Record<string, string>,
  furnace: object = {},
  component?: string
): Promise<ValidationReport> {
  const f = await makeFurnaceFixture(dir(), {
    furnace: {
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--acme-',
      custom: { 'moz-acme-x': entry },
      ...furnace,
    },
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [`components/custom/moz-acme-x/${name}`, text])
    ),
  });
  return validateComponents(f.project, f.tracked, component === undefined ? {} : { component });
}

const checks = (report: ValidationReport): string[] =>
  report.findings.map((finding) => finding.check);

describe('validateComponents', () => {
  it('passes a clean component', async () => {
    const report = await validate({ 'moz-acme-x.mjs': CLEAN_MJS, 'moz-acme-x.css': CLEAN_CSS });
    expect(report).toMatchObject({ findings: [], judged: 1, errors: 0, warnings: 0 });
  });

  it.each([
    [
      'a missing module and stylesheet',
      { 'moz-acme-x-rows.mjs': '' },
      ['missing-mjs', 'missing-css'],
    ],
    [
      'a file outside the naming',
      { 'moz-acme-x.mjs': CLEAN_MJS, 'moz-acme-x.css': CLEAN_CSS, 'other.css': '' },
      ['filename-mismatch'],
    ],
    [
      'conflict markers',
      {
        'moz-acme-x.mjs': `${CLEAN_MJS}<<<<<<< ours\n=======\n>>>>>>> theirs\n`,
        'moz-acme-x.css': CLEAN_CSS,
      },
      ['conflict-markers'],
    ],
    [
      'a missing fragment',
      { 'moz-acme-x.mjs': CLEAN_MJS, 'moz-acme-x.css': '/* @fireforge-include gone.css */\n' },
      ['missing-fragment'],
    ],
    [
      'a raw color, a foreign variable, animation without reduced motion',
      {
        'moz-acme-x.mjs': CLEAN_MJS,
        'moz-acme-x.css': ':host { color: #fff; border-color: var(--other); transition: none; }\n',
      },
      ['raw-color-value', 'token-prefix-violation', 'missing-reduced-motion'],
    ],
    [
      'a relative import and a class that is not a MozLitElement',
      {
        'moz-acme-x.mjs':
          'import { x } from "./x.mjs";\nclass MozAcmeX extends HTMLElement {}\ncustomElements.define("moz-acme-x", MozAcmeX);\n',
        'moz-acme-x.css': CLEAN_CSS,
      },
      ['relative-import', 'not-moz-lit-element'],
    ],
    [
      'a clickable div, hardcoded text, a positive tabindex and an unlabelled input in a companion module',
      {
        'moz-acme-x.mjs': CLEAN_MJS,
        'moz-acme-x-rows.mjs':
          'export const row = html`<div tabindex="2" @click=${go}>Open the thing</div><input type="text">`;\n',
        'moz-acme-x.css': CLEAN_CSS,
      },
      [
        'no-aria-role',
        'no-keyboard-handler',
        'hardcoded-text',
        'positive-tabindex',
        'unlabelled-form-input',
      ],
    ],
  ])('reports %s', async (_what, files, expected) => {
    expect(checks(await validate(files))).toEqual(expected);
  });

  it('reads a multi-line import and judges colours in values only', async () => {
    const report = await validate({
      'moz-acme-x.mjs': `import {\n  row,\n} from "../rows.mjs";\n${CLEAN_MJS}`,
      'moz-acme-x.css': `#add-button, #fade-in { gap: 0; }\n${CLEAN_CSS}`,
    });
    expect(checks(report)).toEqual(['relative-import']);
  });

  it('exempts locally declared, allowlisted and runtime variables from the token prefix', async () => {
    const css =
      ':host { --local: 1px; gap: var(--local); color: var(--card-border-color); top: var(--cam-y); }\n';
    const report = await validate(
      { 'moz-acme-x.mjs': CLEAN_MJS, 'moz-acme-x.css': css },
      { tokenAllowlist: ['--card-border-color'], runtimeVariables: ['--cam-y'] }
    );
    expect(report.findings).toEqual([]);
  });

  it('runs an opt-in check only when furnace.json names it', async () => {
    const mjs = CLEAN_MJS.replace(
      '<button @click=${this.go} data-l10n-id="x-go"></button>',
      '<moz-button iconsrc="chrome://global/skin/icons/x.svg"></moz-button>'
    );
    const files = { 'moz-acme-x.mjs': mjs, 'moz-acme-x.css': CLEAN_CSS };
    expect(checks(await validate(files))).toEqual([]);
    expect(checks(await validate(files, { optInChecks: ['icon-button-label'] }))).toEqual([
      'icon-button-label',
    ]);
  });

  it('applies reviewed exceptions: scoped by file, never to an error, and reports stale ones', async () => {
    const files = {
      'moz-acme-x.mjs': CLEAN_MJS,
      'moz-acme-x-vendor.mjs': 'el.textContent = "abc def ghi";\n',
      'moz-acme-x.css': ':host { color: #000; }\n',
    };
    const report = await validate(
      files,
      {
        validationExceptions: [
          {
            component: 'moz-acme-x',
            check: 'hardcoded-text',
            file: 'moz-acme-x-vendor.mjs',
            reason: 'vendored',
          },
          { component: 'moz-acme-x', check: 'raw-color-value', reason: 'cannot accept an error' },
          { component: 'moz-acme-x', check: 'positive-tabindex', reason: 'long gone' },
          { component: 'moz-other', check: 'missing-css', reason: 'not this run' },
        ],
      },
      'moz-acme-x'
    );
    expect(report.excepted.map((finding) => [finding.check, finding.reason])).toEqual([
      ['hardcoded-text', 'vendored'],
    ]);
    expect(checks(report)).toEqual([
      'raw-color-value',
      'validation-exception-on-error',
      'stale-validation-exception',
    ]);
    expect(report).toMatchObject({ errors: 2, warnings: 1 });
  });

  it('holds a full run to the component floor and the typing files', async () => {
    const report = await validate(
      { 'moz-acme-x.mjs': CLEAN_MJS, 'moz-acme-x.css': CLEAN_CSS },
      { minComponents: 2, typecheckTagMap: 'types/widgets.d.ts' }
    );
    expect(checks(report)).toEqual(['component-floor', 'typing-drift']);
  });

  it('judges the deployment when given the engine', async () => {
    const f = await makeFurnaceFixture(dir(), {
      furnace: { version: 1, componentPrefix: 'moz-', custom: { 'moz-acme-x': entry } },
      files: {
        'components/custom/moz-acme-x/moz-acme-x.mjs': CLEAN_MJS,
        'components/custom/moz-acme-x/moz-acme-x.css': CLEAN_CSS,
      },
    });
    const before = await validateComponents(f.project, f.tracked, { workspace: f.workspace });
    expect(checks(before)).toEqual(['deployment-stale']);
    await applyComponents(f.project, f.workspace);
    expect(
      (await validateComponents(f.project, f.tracked, { workspace: f.workspace })).findings
    ).toEqual([]);
  });

  it('reports a configured component without a directory', async () => {
    expect(checks(await validate({}))).toEqual(['missing-component-dir']);
  });
});

describe('hasHardcodedText', () => {
  it.each([
    ['html`<span>Save</span>`', true],
    ['html`<span data-l10n-id="save">Save</span>`', false],
    ['html`<span>→</span><span>⚙️</span><span>ℹ️</span>`', false],
    ['html`<span>保存</span>`', true],
    ['html`<span>${label}</span>`', false],
    ['if (a > 0 && b < 10) {}', false],
    ['node.setAttribute("label", "Close");', true],
    ['// furnace-ignore: hardcoded-text\nhtml`<b>Text</b>`', false],
  ])('%s: %s', (source, expected) => {
    expect(hasHardcodedText(source)).toBe(expected);
  });
});

describe('validationPasses', () => {
  it('fails on any error, and on warnings past a ceiling', () => {
    const report = (errors: number, warnings: number): ValidationReport => ({
      findings: [],
      excepted: [],
      judged: 1,
      errors,
      warnings,
    });
    expect(validationPasses(report(0, 5))).toBe(true);
    expect(validationPasses(report(0, 5), 5)).toBe(true);
    expect(validationPasses(report(0, 6), 5)).toBe(false);
    expect(validationPasses(report(1, 0))).toBe(false);
  });
});
