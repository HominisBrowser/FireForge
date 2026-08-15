// SPDX-License-Identifier: EUPL-1.2
/**
 * Hardcoded-text detection for the localization validator.
 *
 * Until 0.41.0 the symbol test exempted every code point above U+00FF, so all
 * CJK, Cyrillic, Greek, Arabic, Hebrew, Devanagari and Thai text was invisible
 * to a rule whose entire purpose is finding strings that need translating —
 * the scripts most likely to need it were the ones it could not see.
 */
import { describe, expect, it } from 'vitest';

import { containsHardcodedTemplateText } from '../furnace-validate-helpers.js';

/** Wraps text in a Lit template, the rule's primary detection path. */
function litTemplate(text: string): string {
  return [
    'class Widget extends MozLitElement {',
    '  render() {',
    `    return html\`<div>${text}</div>\`;`,
    '  }',
    '}',
  ].join('\n');
}

describe('containsHardcodedTemplateText — non-Latin scripts', () => {
  it.each([
    ['Japanese', '設定を開く'],
    ['Simplified Chinese', '打开设置'],
    ['Russian', 'Открыть настройки'],
    ['Greek', 'Άνοιγμα ρυθμίσεων'],
    ['Arabic', 'افتح الإعدادات'],
    ['Hebrew', 'פתח הגדרות'],
    ['Hindi', 'सेटिंग्स खोलें'],
    ['Thai', 'เปิดการตั้งค่า'],
    ['Korean', '설정 열기'],
  ])('flags hardcoded %s text', (_label, text) => {
    expect(containsHardcodedTemplateText(litTemplate(text))).toBe(true);
  });

  it('flags Latin text, as it always did', () => {
    expect(containsHardcodedTemplateText(litTemplate('Open settings'))).toBe(true);
  });
});

describe('containsHardcodedTemplateText — decoration stays exempt', () => {
  it.each([
    ['an arrow', '→'],
    ['maths operators', '+-*='],
    ['an emoji', '🎉'],
    ['a chevron pair', '<<'],
  ])('does not flag %s', (_label, text) => {
    expect(containsHardcodedTemplateText(litTemplate(text))).toBe(false);
  });

  it('does not flag a localized element', () => {
    const source = [
      'class Widget extends MozLitElement {',
      '  render() {',
      '    return html`<div data-l10n-id="widget-title"></div>`;',
      '  }',
      '}',
    ].join('\n');
    expect(containsHardcodedTemplateText(source)).toBe(false);
  });

  it('honours the furnace-ignore escape hatch', () => {
    const source = `// furnace-ignore: hardcoded-text\n${litTemplate('設定')}`;
    expect(containsHardcodedTemplateText(source)).toBe(false);
  });
});
