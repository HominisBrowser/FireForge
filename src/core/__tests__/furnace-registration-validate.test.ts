// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { FurnaceError } from '../../errors/furnace.js';
import {
  describeTagNameProblem,
  validateRegistrationPlacement,
  validateTagName,
} from '../furnace-registration-validate.js';

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

  it('throws FurnaceError for a name starting with a hyphen', () => {
    expect(() => {
      validateTagName('-foo');
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

describe('describeTagNameProblem', () => {
  it('returns the rule instead of throwing, so a prompt can re-ask', () => {
    // `furnace create`'s interactive tag prompt passed the THROWING
    // `validateTagName` to clack's `validate` callback, which expects a
    // returned message. An invalid name escaped clack's validation loop as a
    // FurnaceError and killed the prompt instead of showing the rule inline.
    const problem = describeTagNameProblem('NotAValidTag');
    expect(problem).toBeTypeOf('string');
    expect(problem).toContain('NotAValidTag');
  });

  it('returns undefined for a valid tag name', () => {
    expect(describeTagNameProblem('moz-my-widget')).toBeUndefined();
  });

  it('agrees with the throwing sibling', () => {
    // The two must never disagree: `validateTagName` is implemented in terms
    // of this one precisely so they cannot drift.
    expect(() => {
      validateTagName('NotAValidTag');
    }).toThrow(/NotAValidTag/);
    expect(() => {
      validateTagName('moz-my-widget');
    }).not.toThrow();
  });
});
