// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { FurnaceError } from '../../errors/furnace.js';
import {
  CUSTOM_ELEMENT_TAG_PATTERN,
  validateRegistrationPlacement,
  validateTagName,
} from '../furnace-registration-validate.js';

describe('CUSTOM_ELEMENT_TAG_PATTERN', () => {
  it('matches valid custom element names', () => {
    expect(CUSTOM_ELEMENT_TAG_PATTERN.test('my-button')).toBe(true);
    expect(CUSTOM_ELEMENT_TAG_PATTERN.test('a-b')).toBe(true);
    expect(CUSTOM_ELEMENT_TAG_PATTERN.test('moz-card123')).toBe(true);
    expect(CUSTOM_ELEMENT_TAG_PATTERN.test('x-y-z')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(CUSTOM_ELEMENT_TAG_PATTERN.test('button')).toBe(false);
    expect(CUSTOM_ELEMENT_TAG_PATTERN.test('My-button')).toBe(false);
    expect(CUSTOM_ELEMENT_TAG_PATTERN.test('')).toBe(false);
    expect(CUSTOM_ELEMENT_TAG_PATTERN.test('-foo')).toBe(false);
  });
});

describe('validateTagName', () => {
  it('accepts valid custom element tag names', () => {
    expect(() => {
      validateTagName('my-button');
    }).not.toThrow();
    expect(() => {
      validateTagName('a-b');
    }).not.toThrow();
    expect(() => {
      validateTagName('moz-card123');
    }).not.toThrow();
  });

  it('throws FurnaceError for tag name without hyphen', () => {
    expect(() => {
      validateTagName('button');
    }).toThrow(FurnaceError);
  });

  it('throws FurnaceError for tag name starting with uppercase', () => {
    expect(() => {
      validateTagName('My-button');
    }).toThrow(FurnaceError);
  });

  it('throws FurnaceError for empty string', () => {
    expect(() => {
      validateTagName('');
    }).toThrow(FurnaceError);
  });

  it('includes the invalid tag name in the error message', () => {
    expect(() => {
      validateTagName('BAD');
    }).toThrow(/Invalid tag name "BAD"/);
  });
});

describe('validateRegistrationPlacement', () => {
  const loadSubScriptBlock = `
for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}`;

  const dclBlock = `
document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});`;

  it('does nothing when tagName is not found in result', () => {
    const result = `${loadSubScriptBlock}\n${dclBlock}`;
    expect(() => {
      validateRegistrationPlacement(result, 'not-present', true);
    }).not.toThrow();
  });

  it('does not throw for ESM component in DOMContentLoaded block', () => {
    const result = `${loadSubScriptBlock}
document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
      ["my-esm", "chrome://global/content/elements/my-esm.mjs"],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});`;

    expect(() => {
      validateRegistrationPlacement(result, 'my-esm', true);
    }).not.toThrow();
  });

  it('throws when ESM component is in loadSubScript block', () => {
    const result = `
for (let [tag, script] of [
    ["my-esm", "chrome://global/content/elements/my-esm.mjs"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}
${dclBlock}`;

    expect(() => {
      validateRegistrationPlacement(result, 'my-esm', true);
    }).toThrow(FurnaceError);
    expect(() => {
      validateRegistrationPlacement(result, 'my-esm', true);
    }).toThrow(/Pattern A/);
  });

  it('throws when non-ESM component is in DOMContentLoaded block', () => {
    const result = `${loadSubScriptBlock}
document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
      ["my-legacy", "chrome://global/content/elements/my-legacy.js"],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});`;

    expect(() => {
      validateRegistrationPlacement(result, 'my-legacy', false);
    }).toThrow(FurnaceError);
    expect(() => {
      validateRegistrationPlacement(result, 'my-legacy', false);
    }).toThrow(/Pattern B/);
  });

  it('does not throw for non-ESM component in loadSubScript block', () => {
    const result = `
for (let [tag, script] of [
    ["my-legacy", "chrome://global/content/elements/my-legacy.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}
${dclBlock}`;

    expect(() => {
      validateRegistrationPlacement(result, 'my-legacy', false);
    }).not.toThrow();
  });
});
