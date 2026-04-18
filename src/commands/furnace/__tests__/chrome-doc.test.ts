// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as config from '../../../core/config.js';
import { ensureDir, writeText } from '../../../utils/fs.js';
import { furnaceChromeDocCreateCommand } from '../chrome-doc.js';
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
    expect(xhtml).toContain('data-l10n-id="mybrowser-window-title"');
  });

  it('omits the windowtype and titlebar markup when titlebar is disabled', () => {
    const xhtml = generateChromeDocXhtml('overlay', false, 'MPL-2.0');
    expect(xhtml).not.toContain('windowtype="navigator:browser"');
    expect(xhtml).not.toContain('titlebar-buttonbox');
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
    expect(withTitlebar).not.toContain('.titlebar-button');
    expect(frameless).toContain('.titlebar-button');
    expect(frameless).toContain('display: none');
  });

  it('emits an FTL stub keyed on the document name', () => {
    const ftl = generateChromeDocFtl('mybrowser', '# header');
    expect(ftl).toContain('mybrowser-window-title');
  });

  it('emits jar entries for xhtml, js, css, and ftl', () => {
    const xhtmlJs = jarMnEntriesForChromeDoc('mybrowser');
    expect(xhtmlJs).toHaveLength(2);
    expect(xhtmlJs[0]).toMatch(/^\*\s+content\/browser\/mybrowser\.xhtml/);
    expect(xhtmlJs[1]).toMatch(/content\/browser\/mybrowser\.js/);

    expect(jarIncMnEntryForChromeDoc('mybrowser')).toContain('mybrowser-chrome.css');
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
    // Pre-populate the jar.mn files with entries that will match.
    await writeText(
      join(engineDir, 'browser/base/jar.mn'),
      '#header\n*   content/browser/mybrowser.xhtml                (content/mybrowser.xhtml)\n    content/browser/mybrowser.js                   (content/mybrowser.js)\n'
    );
    await writeText(
      join(engineDir, 'browser/themes/shared/jar.inc.mn'),
      '#header\n    content/browser/mybrowser-chrome.css           (shared/mybrowser-chrome.css)\n'
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
