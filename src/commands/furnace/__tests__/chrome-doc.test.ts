// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as config from '../../../core/config.js';
import { ensureDir, writeText } from '../../../utils/fs.js';
import { furnaceChromeDocCreateCommand } from '../chrome-doc.js';
import { furnaceChromeDocRemoveCommand } from '../chrome-doc-remove.js';
import {
  generateChromeDocCss,
  generateChromeDocFtl,
  generateChromeDocJs,
  generateChromeDocXhtml,
  jarIncMnEntryForChromeDoc,
  jarMnEntriesForChromeDoc,
  localeJarMnEntryForChromeDoc,
} from '../chrome-doc-templates.js';

describe('chrome-doc templates', () => {
  it('emits an xhtml shell with windowtype when titlebar is enabled', () => {
    const xhtml = generateChromeDocXhtml('mybrowser', true, 'MPL-2.0');
    expect(xhtml).toContain('<?xml version="1.0"?>');
    expect(xhtml).toContain('SPDX-License-Identifier: MPL-2.0');
    expect(xhtml).toContain('windowtype="navigator:browser"');
    expect(xhtml).toContain('titlebar-buttonbox');
    // data-l10n-id stays only on the leaf <title>. Binding it on the root
    // <window> would let Fluent's first-paint pass overwrite the entire
    // body subtree (the Mozilla "data-l10n-id non-leaf" failure mode); the
    // FTL stub gives the message a value rather than an attribute-only
    // shape, so a root-level binding really would replace children.
    const occurrences = xhtml.match(/data-l10n-id="mybrowser-window-title"/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(xhtml).toContain('<title data-l10n-id="mybrowser-window-title"></title>');
  });

  it('does not emit data-l10n-id on the root <window> element', () => {
    // Regression guard for the "Fluent translation wipes body subtree"
    // failure mode (see the leaf-only assertion above for the why).
    const xhtml = generateChromeDocXhtml('mybrowser', true, 'MPL-2.0');
    const rootMatch = /<window[^>]*>/.exec(xhtml);
    expect(rootMatch).not.toBeNull();
    if (rootMatch) {
      expect(rootMatch[0]).not.toContain('data-l10n-id');
    }
    const framelessXhtml = generateChromeDocXhtml('overlay', false, 'MPL-2.0');
    const framelessRoot = /<window[^>]*>/.exec(framelessXhtml);
    expect(framelessRoot).not.toBeNull();
    if (framelessRoot) {
      expect(framelessRoot[0]).not.toContain('data-l10n-id');
    }
  });

  it('emits the navigator:browser minimum attribute set under --with-titlebar', () => {
    // Without these attributes a fork that ships the scaffold output
    // verbatim opens at the OS intrinsic minimum size on first launch and
    // forgets geometry across restarts. `customtitlebar="true"` pairs with
    // the buttonbox CSS the css template emits; `persist=...` lets
    // XULStore remember the user's last-known geometry.
    const xhtml = generateChromeDocXhtml('mybrowser', true, 'MPL-2.0');
    expect(xhtml).toContain('customtitlebar="true"');
    expect(xhtml).toContain('width="1024"');
    expect(xhtml).toContain('height="640"');
    expect(xhtml).toContain('persist="screenX screenY width height sizemode"');
  });

  it('does not leak navigator:browser minimums when titlebar is disabled', () => {
    const xhtml = generateChromeDocXhtml('overlay', false, 'MPL-2.0');
    expect(xhtml).not.toContain('customtitlebar');
    expect(xhtml).not.toContain('persist=');
    expect(xhtml).not.toContain('width="1024"');
    expect(xhtml).not.toContain('height="640"');
  });

  it('loads the toolkit customElements.js registry ahead of the per-doc subscript', () => {
    // Without customElements.js, every <moz-*> the author drops into the
    // body silently degrades to HTMLUnknownElement and the upstream
    // a11y/keyboard semantics are lost. Matches the webrtcIndicator.xhtml
    // shape upstream uses for non-browser.xhtml chrome documents.
    const xhtml = generateChromeDocXhtml('mybrowser', true, 'MPL-2.0');
    expect(xhtml).toContain('<script src="chrome://global/content/customElements.js"></script>');
    const registryIdx = xhtml.indexOf('chrome://global/content/customElements.js');
    const subscriptIdx = xhtml.indexOf('chrome://browser/content/mybrowser.js');
    expect(registryIdx).toBeGreaterThan(-1);
    expect(subscriptIdx).toBeGreaterThan(-1);
    expect(registryIdx).toBeLessThan(subscriptIdx);
  });

  it('omits the windowtype and titlebar markup when titlebar is disabled', () => {
    const xhtml = generateChromeDocXhtml('overlay', false, 'MPL-2.0');
    expect(xhtml).not.toContain('windowtype="navigator:browser"');
    expect(xhtml).not.toContain('titlebar-buttonbox');
  });

  it('stamps the fork-neutral data-furnace-chrome-doc sentinel on the root element', () => {
    // Platform modules that assume browser.xhtml's DOM (DevToolsStartup,
    // PageActions, …) can guard on this attribute in fork-side patches
    // to skip the walk on a custom chrome doc. Both the titlebar and
    // no-titlebar scaffolds must carry it because both can legitimately
    // set windowtype="navigator:browser".
    expect(generateChromeDocXhtml('mybrowser', true, 'MPL-2.0')).toContain(
      'data-furnace-chrome-doc="mybrowser"'
    );
    expect(generateChromeDocXhtml('overlay', false, 'MPL-2.0')).toContain(
      'data-furnace-chrome-doc="overlay"'
    );
  });

  it('emits a JS bootstrap that fires the startup topic', () => {
    const js = generateChromeDocJs('about-onboarding', '// header');
    expect(js).toContain('DOMContentLoaded');
    expect(js).toContain('"about-onboarding-startup"');
    expect(js).toContain('requestIdleCallback');
  });

  it('emits the titlebar carve-out only when titlebar is disabled', () => {
    const withTitlebar = generateChromeDocCss('mybrowser', true, '/* */');
    const frameless = generateChromeDocCss('mybrowser', false, '/* */');
    // Frameless overlays still need to suppress the platform titlebar
    // buttons that global.css inherits on macOS.
    expect(frameless).toContain(':root[windowtype="navigator:browser"] .titlebar-button');
    expect(frameless).toContain('display: none');
    // The full-titlebar variant should NOT carry the suppression rule —
    // emitting it would silently hide the buttons it just paid the cost
    // of styling.
    expect(withTitlebar).not.toContain(':root[windowtype="navigator:browser"] .titlebar-button');
  });

  it('emits navigator:browser titlebar styling under --with-titlebar', () => {
    // Pairs with the navigator:browser minimum attribute set that the
    // XHTML template emits. -moz-window-dragging makes the buttonbox
    // container a drag region; -moz-window-button-box opts the inner
    // buttonbox into the platform-native traffic-light appearance.
    const css = generateChromeDocCss('mybrowser', true, '/* */');
    expect(css).toContain('-moz-window-dragging: drag');
    expect(css).toContain('.titlebar-buttonbox-container');
    expect(css).toContain('-moz-default-appearance: -moz-window-button-box');
  });

  it('does not emit navigator:browser titlebar styling when titlebar is disabled', () => {
    const css = generateChromeDocCss('overlay', false, '/* */');
    expect(css).not.toContain('-moz-window-dragging');
    expect(css).not.toContain('-moz-window-button-box');
  });

  it('emits an FTL stub keyed on the document name', () => {
    const ftl = generateChromeDocFtl('mybrowser', '# header');
    expect(ftl).toContain('mybrowser-window-title');
  });

  it('emits jar entries for xhtml, js, css, and ftl without spurious preprocessor flags', () => {
    const xhtmlJs = jarMnEntriesForChromeDoc('mybrowser');
    expect(xhtmlJs).toHaveLength(2);
    // Neither entry carries the `*` preprocessor flag — the scaffolded
    // XHTML/JS contain no `#filter`/`#expand`/`#include` directives, and
    // mach's install manifest processor fails with "no preprocessor
    // directives found" when a `*`-flagged entry has nothing to preprocess.
    expect(xhtmlJs[0]).toMatch(/^\s+content\/browser\/mybrowser\.xhtml/);
    expect(xhtmlJs[0]).not.toMatch(/^\*/);
    expect(xhtmlJs[1]).toMatch(/content\/browser\/mybrowser\.js/);
    expect(xhtmlJs[1]).not.toMatch(/^\*/);

    // jar.inc.mn is included from theme-specific manifests
    // (browser/themes/{osx,linux,windows}/jar.mn) — the source path must be
    // `../shared/…` so it resolves under `browser/themes/shared/` rather
    // than the theme-specific directory that the includer lives in.
    const incEntry = jarIncMnEntryForChromeDoc('mybrowser');
    expect(incEntry).toContain('mybrowser-chrome.css');
    expect(incEntry).toContain('(../shared/mybrowser-chrome.css)');
    expect(localeJarMnEntryForChromeDoc('mybrowser')).toContain('locale/browser/mybrowser.ftl');
  });
});

describe('furnaceChromeDocCreateCommand', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ff-chrome-doc-'));
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      binaryName: 'mybrowser',
      name: 'MyBrowser',
      vendor: 'Vendor',
      appId: 'com.vendor.mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      license: 'MPL-2.0',
    } as never);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects names that do not match the name pattern', async () => {
    await ensureDir(join(projectRoot, 'engine'));
    await expect(furnaceChromeDocCreateCommand(projectRoot, 'BAD_NAME')).rejects.toThrow(
      /lowercase/
    );
    await expect(furnaceChromeDocCreateCommand(projectRoot, '0-leading-digit')).rejects.toThrow(
      /lowercase/
    );
  });

  it('accepts single-word and hyphenated names', async () => {
    // Validated indirectly: the command must fail later with "engine dir
    // not found" or "already exists", NOT with the name-pattern error.
    await expect(furnaceChromeDocCreateCommand(projectRoot, 'mybrowser')).rejects.toThrow(
      /Engine directory not found/
    );
    await expect(furnaceChromeDocCreateCommand(projectRoot, 'about-onboarding')).rejects.toThrow(
      /Engine directory not found/
    );
  });

  it('throws when the engine directory does not exist', async () => {
    await expect(furnaceChromeDocCreateCommand(projectRoot, 'mybrowser')).rejects.toThrow(
      /Engine directory not found/
    );
  });

  it('writes xhtml/js/css/ftl + jar.mn entries when the engine exists', async () => {
    const engineDir = join(projectRoot, 'engine');
    // Pre-create every jar.mn + directory so the command's idempotent append paths can find them.
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '# existing header\n');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '# existing shared\n');
    await writeText(join(engineDir, 'browser/locales/jar.mn'), '# existing locales\n');

    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');

    const xhtml = await readFile(join(engineDir, 'browser/base/content/mybrowser.xhtml'), 'utf8');
    expect(xhtml).toContain('mybrowser-window-title');

    const js = await readFile(join(engineDir, 'browser/base/content/mybrowser.js'), 'utf8');
    expect(js).toContain('"mybrowser-startup"');

    const css = await readFile(
      join(engineDir, 'browser/themes/shared/mybrowser-chrome.css'),
      'utf8'
    );
    expect(css).toContain('mybrowser-main');

    const ftl = await readFile(
      join(engineDir, 'browser/locales/en-US/browser/mybrowser.ftl'),
      'utf8'
    );
    expect(ftl).toContain('mybrowser-window-title');

    const jarMn = await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8');
    expect(jarMn).toContain('content/browser/mybrowser.xhtml');
    expect(jarMn).toContain('content/browser/mybrowser.js');

    const jarIncMn = await readFile(join(engineDir, 'browser/themes/shared/jar.inc.mn'), 'utf8');
    expect(jarIncMn).toContain('mybrowser-chrome.css');

    const localeJarMn = await readFile(join(engineDir, 'browser/locales/jar.mn'), 'utf8');
    expect(localeJarMn).toContain('locale/browser/mybrowser.ftl');
  });

  it('previews the chrome-doc scaffold without writing files', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/locales/jar.mn'), '# header\n');

    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser', {
      withTests: true,
      dryRun: true,
    });

    const { pathExists } = await import('../../../utils/fs.js');
    expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(false);
    expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.js'))).toBe(false);
    expect(
      await pathExists(join(engineDir, 'browser/base/content/test/mybrowser-xpcshell/mybrowser'))
    ).toBe(false);

    const jarMn = await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8');
    expect(jarMn).toBe('# header\n');
  });

  it('rejects an empty name', async () => {
    await ensureDir(join(projectRoot, 'engine'));
    await expect(furnaceChromeDocCreateCommand(projectRoot, '   ')).rejects.toThrow(
      /name is required/
    );
  });

  it('throws when a required jar.mn does not exist in the fork layout', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    // Intentionally omit browser/base/jar.mn to trigger the "required jar
    // file does not exist" branch in appendJarEntryIfAbsent.
    await expect(furnaceChromeDocCreateCommand(projectRoot, 'mybrowser')).rejects.toThrow(
      /Required jar file/
    );
  });

  it('is idempotent when the same entry is already present in a jar.mn', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    // Pre-populate the jar.mn files with entries that match the scaffold's
    // current emit (no `*` preprocessor flag on xhtml/js, `../shared/` source
    // path on the CSS). The idempotency helper compares by exact substring so
    // the pre-populated lines must mirror what `jarMnEntriesForChromeDoc` /
    // `jarIncMnEntryForChromeDoc` now produce.
    await writeText(
      join(engineDir, 'browser/base/jar.mn'),
      '#header\n    content/browser/mybrowser.xhtml                (content/mybrowser.xhtml)\n    content/browser/mybrowser.js                   (content/mybrowser.js)\n'
    );
    await writeText(
      join(engineDir, 'browser/themes/shared/jar.inc.mn'),
      '#header\n    content/browser/mybrowser-chrome.css           (../shared/mybrowser-chrome.css)\n'
    );
    await writeText(
      join(engineDir, 'browser/locales/jar.mn'),
      '#header\n    locale/browser/mybrowser.ftl                    (%mybrowser.ftl)\n'
    );

    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
    // No duplicate jar.mn entries — the idempotency branch short-circuits
    // the append.
    const { readFile } = await import('node:fs/promises');
    const jarMn = await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8');
    expect(jarMn.match(/content\/browser\/mybrowser\.xhtml/g)?.length).toBe(1);
  });

  it('scaffolds an xpcshell packaging-verification test when --with-tests is set', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/locales/jar.mn'), '# header\n');

    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser', { withTests: true });

    const testPath = join(
      engineDir,
      'browser/base/content/test/mybrowser-xpcshell/mybrowser/test_mybrowser_packaging.js'
    );
    const manifestPath = join(
      engineDir,
      'browser/base/content/test/mybrowser-xpcshell/mybrowser/xpcshell.toml'
    );

    const testContent = await readFile(testPath, 'utf8');
    // Probes the filesystem directly rather than going through chrome:// URI
    // resolution — that is the whole point of this scaffold.
    expect(testContent).toContain('Services.dirsvc.get("XCurProcD"');
    // Must probe the xhtml, css under /chrome/browser/...
    expect(testContent).toContain('mybrowser.xhtml');
    expect(testContent).toContain('mybrowser-chrome.css');
    // Must warn about packed-omnijar limitation so an operator on a
    // packed-tree build does not think the scaffold is buggy when the
    // probe fails.
    expect(testContent).toContain('omni.ja');

    const manifestContent = await readFile(manifestPath, 'utf8');
    // firefox-appdir = "browser" is required for XCurProcD to resolve to
    // the browser subdir — otherwise the probe walks the wrong tree.
    expect(manifestContent).toContain('firefox-appdir = "browser"');
    expect(manifestContent).toContain('["test_mybrowser_packaging.js"]');
  });

  it('removes scaffolded chrome-doc files, tests, and jar entries', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/locales/jar.mn'), '# header\n');

    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser', { withTests: true });
    await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true });

    const { pathExists } = await import('../../../utils/fs.js');
    expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(false);
    expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.js'))).toBe(false);
    expect(await pathExists(join(engineDir, 'browser/themes/shared/mybrowser-chrome.css'))).toBe(
      false
    );
    expect(await pathExists(join(engineDir, 'browser/locales/en-US/browser/mybrowser.ftl'))).toBe(
      false
    );
    expect(
      await pathExists(join(engineDir, 'browser/base/content/test/mybrowser-xpcshell/mybrowser'))
    ).toBe(false);

    expect(await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8')).not.toContain(
      'mybrowser'
    );
    expect(
      await readFile(join(engineDir, 'browser/themes/shared/jar.inc.mn'), 'utf8')
    ).not.toContain('mybrowser');
    expect(await readFile(join(engineDir, 'browser/locales/jar.mn'), 'utf8')).not.toContain(
      'mybrowser'
    );
  });

  it('previews chrome-doc removal without writing files', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/locales/jar.mn'), '# header\n');

    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
    await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { dryRun: true });

    const { pathExists } = await import('../../../utils/fs.js');
    expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(true);
    expect(await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8')).toContain('mybrowser');
  });

  it('omits test scaffolding by default so no test files land without --with-tests', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/locales/jar.mn'), '# header\n');

    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');

    const { pathExists } = await import('../../../utils/fs.js');
    expect(await pathExists(join(engineDir, 'browser/base/content/test/mybrowser-xpcshell'))).toBe(
      false
    );
  });

  it('skips the locale jar.mn per-file entry when a [localization] wildcard already captures the FTL', async () => {
    // Forks that have migrated to a `(%browser/**/*.ftl)` wildcard already
    // pick up the scaffolded FTL automatically; appending a per-file
    // `locale/...` entry is dead weight (and a build break on forks that
    // dropped the `% locale browser` registration). The scaffolder must
    // detect the wildcard and skip.
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '# header\n');
    await writeText(
      join(engineDir, 'browser/locales/jar.mn'),
      '# header\n[localization] @AB_CD@.jar:\n  browser (%browser/**/*.ftl)\n'
    );

    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');

    const localeJarMn = await readFile(join(engineDir, 'browser/locales/jar.mn'), 'utf8');
    // The wildcard line stays as-is and the per-file entry is NOT appended.
    expect(localeJarMn).toContain('browser (%browser/**/*.ftl)');
    expect(localeJarMn).not.toContain('locale/browser/mybrowser.ftl');
    // Sanity: the rest of the scaffold did write — the skip is targeted,
    // not a wholesale abort.
    const xhtml = await readFile(join(engineDir, 'browser/base/content/mybrowser.xhtml'), 'utf8');
    expect(xhtml).toContain('mybrowser-window-title');
  });

  it('still appends the per-file locale jar.mn entry when no wildcard is present', async () => {
    // Regression guard: forks on the legacy `% locale browser ...`
    // registration with no `[localization]` wildcard still get the
    // per-file entry.
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '# header\n');
    await writeText(join(engineDir, 'browser/locales/jar.mn'), '# header\n');

    await furnaceChromeDocCreateCommand(projectRoot, 'legacyfork');

    const localeJarMn = await readFile(join(engineDir, 'browser/locales/jar.mn'), 'utf8');
    expect(localeJarMn).toContain('locale/browser/legacyfork.ftl');
    expect(localeJarMn).toContain('(%browser/legacyfork.ftl)');
  });

  it('refuses to clobber an existing xhtml with the same name', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/base/content'));
    await writeText(
      join(engineDir, 'browser/base/content/existing.xhtml'),
      '<?xml version="1.0"?>\n'
    );
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    await writeText(join(engineDir, 'browser/base/jar.mn'), '');
    await writeText(join(engineDir, 'browser/themes/shared/jar.inc.mn'), '');
    await writeText(join(engineDir, 'browser/locales/jar.mn'), '');

    await expect(furnaceChromeDocCreateCommand(projectRoot, 'existing')).rejects.toThrow(
      /already exists/
    );
  });
});
