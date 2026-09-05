// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchLintIssue } from '../../types/commands/index.js';
import {
  collectTopLevelDeclarations,
  explainUndefinedIdentifiers,
  findLoadSubScriptTargets,
  formatUnmanagedCompanionHint,
  resolveUnmanagedCompanions,
  retargetUnmanagedCompanionHints,
  type UnmanagedCompanion,
} from '../patch-lint-unmanaged-companion.js';
import { UNDEFINED_IDENTIFIER_HINT } from '../typecheck-shim.js';

const HEAD = `
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_settings.js",
  this
);
`;

const COMPANION = `
const SETTINGS_PREF = "browser.hominis.settings";
function openSettings(win) {}
async function waitForSettings() {}
class SettingsHarness {}
  function notTopLevel() {}
`;

function issue(message: string): PatchLintIssue {
  return {
    file: 'browser/test/browser_a.js',
    check: 'checkjs-type-error',
    message,
    severity: 'warning',
  };
}

describe('findLoadSubScriptTargets', () => {
  it('extracts the .js literal from the runtime-path idiom', () => {
    expect(findLoadSubScriptTargets(HEAD)).toEqual(['head_settings.js']);
  });

  it('returns nothing when no loadSubScript call is present', () => {
    expect(findLoadSubScriptTargets('const x = "head_settings.js";')).toEqual([]);
  });
});

describe('collectTopLevelDeclarations', () => {
  it('collects top-level names and ignores indented ones', () => {
    const names = collectTopLevelDeclarations(COMPANION);
    expect([...names].sort()).toEqual([
      'SETTINGS_PREF',
      'SettingsHarness',
      'openSettings',
      'waitForSettings',
    ]);
  });
});

describe('resolveUnmanagedCompanions', () => {
  const owned = new Set(['browser/test/head.js', 'browser/test/browser_a.js']);
  const read = (rel: string): Promise<string | undefined> =>
    Promise.resolve(rel === 'browser/test/head_settings.js' ? COMPANION : undefined);

  it('resolves a same-directory companion that no patch owns', async () => {
    const companions = await resolveUnmanagedCompanions(
      [{ file: 'browser/test/head.js', source: HEAD }],
      owned,
      read
    );
    expect(companions).toHaveLength(1);
    expect(companions[0]?.file).toBe('browser/test/head_settings.js');
    expect(companions[0]?.loadedBy).toBe('browser/test/head.js');
  });

  // Once the companion is adopted the honest program can see it, and the
  // hint must go back to the generic advice.
  it('ignores a companion the queue already owns', async () => {
    const companions = await resolveUnmanagedCompanions(
      [{ file: 'browser/test/head.js', source: HEAD }],
      new Set([...owned, 'browser/test/head_settings.js']),
      read
    );
    expect(companions).toEqual([]);
  });

  it('ignores a target that does not exist on disk', async () => {
    const companions = await resolveUnmanagedCompanions(
      [{ file: 'browser/test/head.js', source: HEAD }],
      owned,
      () => Promise.resolve(undefined)
    );
    expect(companions).toEqual([]);
  });
});

describe('explainUndefinedIdentifiers', () => {
  const companion: UnmanagedCompanion = {
    file: 'browser/test/head_settings.js',
    loadedBy: 'browser/test/head.js',
    declarations: new Set(['openSettings', 'SETTINGS_PREF']),
  };

  it('explains a file whose every undefined name is declared in the companion', () => {
    const found = explainUndefinedIdentifiers(
      ["Line 3: Cannot find name 'openSettings'.", "Line 9: Cannot find name 'SETTINGS_PREF'."],
      [companion]
    );
    expect(found).toBe(companion);
  });

  // One unresolved name means the file may genuinely be missing a helper.
  // Claiming the companion explains everything would hide exactly the bug
  // the shim remedy hides, which is what this detection exists to prevent.
  it('refuses when any name is not declared in the companion', () => {
    const found = explainUndefinedIdentifiers(
      ["Line 3: Cannot find name 'openSettings'.", "Line 9: Cannot find name 'typoHelper'."],
      [companion]
    );
    expect(found).toBeUndefined();
  });
});

describe('retargetUnmanagedCompanionHints', () => {
  const companion: UnmanagedCompanion = {
    file: 'browser/test/head_settings.js',
    loadedBy: 'browser/test/head.js',
    declarations: new Set(['openSettings']),
  };

  it('replaces the shim hint with the ownership hint', () => {
    const [out] = retargetUnmanagedCompanionHints(
      [issue(`Line 3: Cannot find name 'openSettings'. ${UNDEFINED_IDENTIFIER_HINT}`)],
      [companion]
    );
    expect(out?.message).not.toContain(UNDEFINED_IDENTIFIER_HINT);
    expect(out?.message).toContain('--scan-file browser/test/head_settings.js');
    expect(out?.message).toContain('Do NOT add these globals to the extra shim');
  });

  it('leaves non-undefined-identifier issues untouched', () => {
    const other = issue('Line 4: Type string is not assignable to number.');
    const [out] = retargetUnmanagedCompanionHints([other], [companion]);
    expect(out).toEqual(other);
  });

  it('keeps the generic hint when no companion explains the names', () => {
    const original = issue(
      `Line 3: Cannot find name 'somethingElse'. ${UNDEFINED_IDENTIFIER_HINT}`
    );
    const [out] = retargetUnmanagedCompanionHints([original], [companion]);
    expect(out?.message).toContain(UNDEFINED_IDENTIFIER_HINT);
  });
});

describe('formatUnmanagedCompanionHint', () => {
  it('names the companion, its loader and the adoption command', () => {
    const hint = formatUnmanagedCompanionHint({
      file: 'browser/test/head_settings.js',
      loadedBy: 'browser/test/head.js',
      declarations: new Set(),
    });
    expect(hint).toContain('browser/test/head_settings.js');
    expect(hint).toContain('browser/test/head.js');
    expect(hint).toContain('fireforge re-export <patch> --scan --scan-file');
  });
});
