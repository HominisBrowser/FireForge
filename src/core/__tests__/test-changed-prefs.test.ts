// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { changedPrefNoiseVerdictNote, describeChangedPrefNoise } from '../test-changed-prefs.js';

const COLD_STARTUP =
  'TEST-UNEXPECTED-FAIL | browser/base/test/browser_prefs.js | ' +
  'changed preference: browser.startup.lastColdStartupCheck';
const GPC =
  'TEST-UNEXPECTED-FAIL | browser/base/test/browser_prefs.js | ' +
  'changed preference: privacy.globalprivacycontrol.enabled';

describe('describeChangedPrefNoise', () => {
  it('describes a run whose every unexpected result is the time-driven pair', () => {
    const note = describeChangedPrefNoise(`${COLD_STARTUP}\n${GPC}\n`);
    expect(note).toContain('lastColdStartupCheck');
    expect(note).toContain('globalprivacycontrol');
    expect(note).toContain('run LENGTH');
    expect(note).toContain('--chunk');
  });

  it('declines when a real assertion failure sits beside the noise', () => {
    const realFailure =
      'TEST-UNEXPECTED-FAIL | browser/base/test/browser_thing.js | ' +
      'the widget should be visible - got false, expected true';
    expect(describeChangedPrefNoise(`${COLD_STARTUP}\n${realFailure}\n`)).toBeUndefined();
  });

  it('declines when a DIFFERENT preference changed', () => {
    const otherPref =
      'TEST-UNEXPECTED-FAIL | browser/base/test/browser_prefs.js | ' +
      'changed preference: browser.hominis.someRealPref';
    expect(describeChangedPrefNoise(`${COLD_STARTUP}\n${otherPref}\n`)).toBeUndefined();
  });

  it('declines on output with no unexpected results at all', () => {
    expect(describeChangedPrefNoise('Ran 84 checks\nUnexpected results: 0\n')).toBeUndefined();
  });
});

describe('changedPrefNoiseVerdictNote', () => {
  it('is a short parenthetical for the verdict line', () => {
    expect(changedPrefNoiseVerdictNote(`${COLD_STARTUP}\n`)).toBe(
      'all unexpected results are time-driven changed-pref checks'
    );
  });

  it('is undefined when the shape does not apply', () => {
    expect(changedPrefNoiseVerdictNote('Unexpected results: 0')).toBeUndefined();
  });
});
