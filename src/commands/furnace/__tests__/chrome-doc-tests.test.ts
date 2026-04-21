// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  chromeDocPackagingTestFileName,
  generateChromeDocPackagingManifest,
  generateChromeDocPackagingTest,
} from '../chrome-doc-tests.js';

describe('chromeDocPackagingTestFileName', () => {
  it('derives a stable basename that preserves hyphens in the chrome-doc name', () => {
    expect(chromeDocPackagingTestFileName('mybrowser')).toBe('test_mybrowser_packaging.js');
    expect(chromeDocPackagingTestFileName('about-onboarding')).toBe(
      'test_about-onboarding_packaging.js'
    );
  });
});

describe('generateChromeDocPackagingTest', () => {
  it('emits a probe that reads the packaged tree directly rather than via chrome://', () => {
    const test = generateChromeDocPackagingTest('mybrowser', '// LICENSE');
    expect(test).toContain('// LICENSE');
    // Probes the filesystem, not a chrome:// URI — the chrome-URI path is
    // the one the generated test is specifically avoiding. The helper
    // name is `probeEither` after 0.16.0 to reflect that we try both a
    // primary and a fallback packaged-tree layout before failing.
    expect(test).toContain('Services.dirsvc.get("XCurProcD"');
    expect(test).toMatch(/primaryFile\.exists\(\)|fallbackFile\.exists\(\)/);
    // The assertion chain must not go through NetUtil / newChannel — that
    // would re-introduce the xpcshell chrome-URI registration dependency
    // the scaffold exists to sidestep. We tolerate the string appearing in
    // the explanatory header comment but require no actual call site.
    expect(test).not.toMatch(/^\s*NetUtil\./m);
    expect(test).not.toMatch(/Services\.io\.newChannel/);
    // Task suffix uses underscores but filename preserves hyphens — avoids
    // a JS-identifier parse error in the generated add_task callback.
    expect(test).toContain('test_mybrowser_files_packaged');
  });

  it('replaces hyphens in the task suffix so the add_task name is a valid identifier', () => {
    const test = generateChromeDocPackagingTest('about-onboarding', '// LICENSE');
    expect(test).toContain('test_about_onboarding_files_packaged');
    // The jar.mn target uses the hyphenated form, so the probe path still
    // carries the original basename.
    expect(test).toContain('about-onboarding.xhtml');
    expect(test).toContain('about-onboarding-chrome.css');
  });

  it('probes both the dist/bin/browser and app-bundle layouts for packaged outputs', () => {
    const test = generateChromeDocPackagingTest('mybrowser', '// LICENSE');
    // Primary (dist/bin/browser with firefox-appdir honoured):
    //   <AppDir>/chrome/browser/content/browser/<name>.xhtml
    //   <AppDir>/chrome/browser/content/browser/<name>-chrome.css
    //
    // The scoped CSS is registered through `jar.inc.mn` at
    // `content/browser/<name>-chrome.css` (see
    // `chromeDocJarIncMnCssEntry` in `chrome-doc-templates.ts`), so the
    // packaged file lands under `content/browser/`, not under
    // `skin/classic/browser/`. The 2026-04-21 eval's first
    // `fireforge test --build` run against a scaffolded chrome-doc
    // reported a false failure because the probe had been pinned to the
    // skin layout from an earlier draft of the jar entry.
    expect(test).toContain('"chrome", "browser", "content", "browser", "mybrowser.xhtml"');
    expect(test).toContain('"chrome", "browser", "content", "browser", "mybrowser-chrome.css"');
    // Fallback (macOS app bundle and some ESR layouts where XCurProcD
    // sits one level above `browser/`):
    //   <AppDir>/browser/chrome/browser/content/browser/<name>.xhtml
    //   <AppDir>/browser/chrome/browser/content/browser/<name>-chrome.css
    expect(test).toContain(
      '"browser", "chrome", "browser", "content", "browser", "mybrowser.xhtml"'
    );
    expect(test).toContain(
      '"browser", "chrome", "browser", "content", "browser", "mybrowser-chrome.css"'
    );
    // The CSS probe must not point at the skin layout any more — a
    // regression guard for the 0.16.0 path fix.
    expect(test).not.toContain('skin", "classic", "browser", "mybrowser-chrome.css"');
    // `probeEither` is the helper name that checks both candidates.
    expect(test).toContain('probeEither');
  });

  it('warns about the omni.ja-packed build limitation in the inline comment', () => {
    // A fork that packs omni.ja needs a different probe; the scaffold must
    // flag that explicitly so an operator on a packed-tree build does not
    // assume the scaffold is buggy when the probe fails.
    const test = generateChromeDocPackagingTest('mybrowser', '// LICENSE');
    expect(test).toContain('omni.ja');
  });
});

describe('generateChromeDocPackagingManifest', () => {
  it('declares firefox-appdir = "browser" so XCurProcD resolves to the browser subdir', () => {
    const manifest = generateChromeDocPackagingManifest('mybrowser', '# LICENSE');
    expect(manifest).toContain('# LICENSE');
    expect(manifest).toContain('firefox-appdir = "browser"');
    // The manifest names the test file so mach test can discover it.
    expect(manifest).toContain('["test_mybrowser_packaging.js"]');
  });

  it('preserves hyphens in the test file entry name', () => {
    const manifest = generateChromeDocPackagingManifest('about-onboarding', '# LICENSE');
    expect(manifest).toContain('["test_about-onboarding_packaging.js"]');
  });
});
