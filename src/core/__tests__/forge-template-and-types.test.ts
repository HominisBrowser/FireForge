// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  containsHardcodedTemplateText,
  validateAccessibility,
} from '../furnace-validate-accessibility.js';
import { collectLitTemplateRegions, parseTemplateAttributes } from '../lit-template-regions.js';
import { collectTokenInventory } from '../token-inventory.js';
import { runTypecheck } from '../typecheck.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ff-forge-parsing-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Lit accessibility regressions', () => {
  it('sees text after nested style strings and later templates in either method order', () => {
    const nested = 'html`<div style=${`top:${value}%`}></div>`';
    const text = 'html`<span class="find-ul">ab</span>`';
    expect(containsHardcodedTemplateText(`const a = ${nested}; const b = ${text};`)).toBe(true);
    expect(containsHardcodedTemplateText(`const b = ${text}; const a = ${nested};`)).toBe(true);
    expect(
      containsHardcodedTemplateText('html`<div>${html`<span>Nested text</span>`}</div>`')
    ).toBe(true);
    expect(containsHardcodedTemplateText('html`<div>${"ab"}</div>`')).toBe(false);
    expect(
      collectLitTemplateRegions(
        'const a = `not Lit`; const b = html`<div>${{ x: `nested` }}</div>`;'
      )
    ).toEqual(['<div>${expression}</div>']);
    expect(collectLitTemplateRegions('html`<div>Complete</div>`; "unterminated')).toEqual([
      '<div>Complete</div>',
    ]);
  });

  it.each([
    '<input @input=${event => this.onInput(event)} data-l10n-id="search" />',
    '<input data-l10n-id="search" @input=${event => this.onInput(event)} />',
    '<input title="quoted > bracket id=x" @input=${event => this.onInput(event)} />',
  ])('does not mistake Fluent ids or binding arrows for a name: %s', async (markup) => {
    await writeFile(join(root, 'widget.mjs'), 'const tpl = html`' + markup + '`;');
    const issues = await validateAccessibility(root, 'widget');
    expect(issues.some((issue) => issue.check === 'unlabelled-form-input')).toBe(true);
  });

  it.each([
    '<input @input=${event => this.onInput(event)} aria-label="Search" />',
    '<input aria-label="Search" @input=${event => this.onInput(event)} />',
    '<input id="search" />',
    '<input type="hidden" />',
    '<label>Search <input /></label>',
  ])('recognizes genuine labels regardless of order: %s', async (markup) => {
    await writeFile(join(root, 'widget.mjs'), 'const tpl = html`' + markup + '`;');
    expect(
      (await validateAccessibility(root, 'widget')).some(
        (issue) => issue.check === 'unlabelled-form-input'
      )
    ).toBe(false);
  });

  it('ignores attribute-like text inside quoted values', () => {
    const attrs = parseTemplateAttributes(
      'title="has id=x aria-label=y" data-l10n-id="name" disabled'
    );
    expect(attrs.has('id')).toBe(false);
    expect(attrs.has('aria-label')).toBe(false);
    expect(attrs.get('data-l10n-id')).toBe('name');
    expect(attrs.has('disabled')).toBe(true);
  });

  it('lists categories after nested CSS blocks without admitting dark/variant companions', () => {
    const inventory = collectTokenInventory(
      `:root {
  /* = Color = */
  --color: red;
  @media not (forced-colors) {
    --bridge: blue;
  }
  /* = Elevation = */
  --shadow: 1px;
}
:root[dark] {
 /* = Dark = */
 --shadow: 2px;
}`.split('\n')
    );
    expect(inventory.map((group) => group.category)).toEqual(['Color', 'Elevation']);
    expect(inventory[1]?.tokens[0]?.name).toBe('--shadow');
  });
});

describe('typecheck diagnostics and Gecko constructors', () => {
  async function setup(files: Record<string, string>): Promise<void> {
    await mkdir(join(root, 'p'));
    await writeFile(
      join(root, 'p/jsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: true,
        },
        include: ['*.mjs'],
      })
    );
    for (const [file, source] of Object.entries(files))
      await writeFile(join(root, 'p', file), source);
  }

  it('keeps warm, changed, and cold verdicts equal for imported null members and global scripts', async () => {
    await setup({
      'model.mjs': 'export class Model { _expiresAt = null; }',
      'use.mjs': 'import { Model } from "./model.mjs"; export const model = new Model();',
      'global.mjs': 'const marker = 1;',
    });
    const cfg = { projects: ['p/jsconfig.json'] };
    await runTypecheck(root, cfg);
    await writeFile(
      join(root, 'p/use.mjs'),
      'import { Model } from "./model.mjs"; export const other = new Model();'
    );
    expect(await runTypecheck(root, cfg)).toEqual(await runTypecheck(root, cfg, { noCache: true }));
    await writeFile(join(root, 'p/global.mjs'), 'const marker = 2;');
    expect(await runTypecheck(root, cfg)).toEqual(await runTypecheck(root, cfg, { noCache: true }));
  });

  it('accepts Gecko isInstance and narrows the DOM type without suppressing real errors', async () => {
    await setup({
      'transition.mjs':
        '/** @param {Animation} a */\nexport function transition(a) { if (CSSTransition.isInstance(a)) return a.transitionProperty; return MouseEvent.MOZ_SOURCE_PEN; }',
    });
    const cfg = { projects: ['p/jsconfig.json'] };
    expect((await runTypecheck(root, cfg, { noCache: true }))[0]?.issues).toEqual([]);
    await writeFile(
      join(root, 'p/transition.mjs'),
      '/** @param {Animation} a */\nexport function transition(a) { if (CSSTransition.isInstance(a)) return a.notARealProperty; }'
    );
    expect(
      (await runTypecheck(root, cfg, { noCache: true }))[0]?.issues.some(
        (issue) => issue.code === 2339
      )
    ).toBe(true);
  });
});
