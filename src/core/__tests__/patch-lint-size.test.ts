// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch-size measurement and thresholds: the `diff` / `addedCode` metrics,
 * registration files, per-class counting, configurable bands and the
 * wording of each band.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getPatchSizeThresholds as fromPublicApi,
  isTestFile as isTestFromPublicApi,
} from '../../index.js';
import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import type { FireForgeConfig, PatchLintConfig } from '../../types/config.js';
import {
  countNonBinaryDiffLines,
  getPatchSizeThresholds,
  isTestFile,
  lintPatchSize,
  measurePatchSize,
  type PatchSizeMeasurement,
} from '../patch-lint-size.js';
import { isPatchSizeRegistrationFile } from '../patch-lint-size-thresholds.js';

const cfg = (patchLint: PatchLintConfig): Pick<FireForgeConfig, 'patchLint'> => ({ patchLint });

/** A new-file diff section whose added lines are exactly `lines`. */
function newFileSection(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function measured(overrides: Partial<PatchSizeMeasurement>): PatchSizeMeasurement {
  return { metric: 'diff', lines: 0, testLines: 0, files: 1, registrationFiles: 0, ...overrides };
}

describe('getPatchSizeThresholds', () => {
  it('is the public-API binding and keeps the built-in defaults without config', () => {
    expect(fromPublicApi).toBe(getPatchSizeThresholds);
    expect(isTestFromPublicApi).toBe(isTestFile);
    expect(getPatchSizeThresholds('general')).toEqual({
      lines: { notice: 800, warning: 1500, error: 3000 },
      files: { notice: 5, warning: 5, error: null },
      maxFiles: 5,
    });
    expect(getPatchSizeThresholds('test').lines).toEqual({
      notice: 1500,
      warning: 3000,
      error: 6000,
    });
    expect(getPatchSizeThresholds('branding').maxFiles).toBe(60);
  });

  it('returns the configured values', () => {
    const config = cfg({
      patchSizeThresholds: {
        general: {
          lines: { notice: 1000, warning: 2000, error: 4000 },
          files: { notice: 8, warning: 12, error: 24 },
        },
        branding: { lines: { warning: 20000 } },
      },
    });
    expect(getPatchSizeThresholds('general', config)).toEqual({
      lines: { notice: 1000, warning: 2000, error: 4000 },
      files: { notice: 8, warning: 12, error: 24 },
      maxFiles: 12,
    });
    expect(getPatchSizeThresholds('branding', config).lines).toEqual({
      notice: 8000,
      warning: 20000,
      error: 30000,
    });
    expect(getPatchSizeThresholds('test', config).lines.notice).toBe(1500);
  });

  it('lets an unset files.notice follow a configured files.warning', () => {
    const config = cfg({ patchSizeThresholds: { test: { files: { warning: 9 } } } });
    expect(getPatchSizeThresholds('test', config).files).toEqual({
      notice: 9,
      warning: 9,
      error: null,
    });
  });
});

describe('isPatchSizeRegistrationFile', () => {
  const globs = ['jar.mn', 'moz.build', '*.toml', 'jsconfig*.json', 'browser/installer/**'];

  it('matches a slash-free glob against the basename', () => {
    expect(isPatchSizeRegistrationFile('browser/base/jar.mn', globs)).toBe(true);
    expect(isPatchSizeRegistrationFile('a/b/moz.build', globs)).toBe(true);
    expect(isPatchSizeRegistrationFile('a/test/browser.toml', globs)).toBe(true);
    expect(isPatchSizeRegistrationFile('jsconfig.tools.json', globs)).toBe(true);
    expect(isPatchSizeRegistrationFile('a/jar.mn.bak', globs)).toBe(false);
  });

  it('matches a glob with a slash against the whole path, ** crossing segments', () => {
    expect(isPatchSizeRegistrationFile('browser/installer/a/b.in', globs)).toBe(true);
    expect(isPatchSizeRegistrationFile('mobile/browser/installer/b.in', globs)).toBe(false);
    expect(isPatchSizeRegistrationFile('x/a.js', ['x/?.js', 'y/**/z.js'])).toBe(true);
    expect(isPatchSizeRegistrationFile('y/z.js', ['y/**/z.js'])).toBe(true);
    expect(isPatchSizeRegistrationFile('y/p/q/z.js', ['y/**/z.js'])).toBe(true);
  });

  it('matches nothing without globs', () => {
    expect(isPatchSizeRegistrationFile('jar.mn', [])).toBe(false);
  });
});

describe('measurePatchSize', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempProject('fireforge-patch-size-');
  });

  afterEach(async () => {
    await removeTempProject(root);
  });

  it('defaults to the diff metric, equal to countNonBinaryDiffLines', async () => {
    const diff = newFileSection('a.js', ['// c', 'x();']) + '\n';
    const result = await measurePatchSize(root, diff, ['a.js'], cfg({}));
    expect(result).toEqual({
      metric: 'diff',
      lines: countNonBinaryDiffLines(diff).textLines,
      testLines: 0,
      files: 1,
      registrationFiles: 0,
    });
  });

  it('leaves registration files out of both counts under diff', async () => {
    const js = newFileSection('a/x.js', ['x();']);
    const reg = newFileSection('a/jar.mn', ['  content/x.js (x.js)', '  content/y.js (y.js)']);
    const diff = `${js}\n${reg}\n`;
    const result = await measurePatchSize(
      root,
      diff,
      ['a/x.js', 'a/jar.mn'],
      cfg({ patchSizeRegistrationFiles: ['jar.mn'] })
    );
    expect(result.lines).toBe(countNonBinaryDiffLines(`${js}\n`).textLines);
    expect(result.files).toBe(1);
    expect(result.registrationFiles).toBe(1);
  });

  it('counts added code lines from the post-image, by class, under addedCode', async () => {
    const code = ['/**', ' * Doc.', ' */', 'export const a = 1;', '', 'export const b = 2;'];
    const test = ['// header', 'add_task(async () => {', '  ok(true);', '});'];
    await writeFiles(root, {
      'browser/modules/A.sys.mjs': code.join('\n') + '\n',
      'browser/base/content/test/browser_a.js': test.join('\n') + '\n',
      'browser/modules/moz.build': 'EXTRA_JS_MODULES += ["A.sys.mjs"]\n',
    });
    const diff = [
      newFileSection('browser/modules/A.sys.mjs', code),
      newFileSection('browser/base/content/test/browser_a.js', test),
      newFileSection('browser/modules/moz.build', ['EXTRA_JS_MODULES += ["A.sys.mjs"]']),
      '',
    ].join('\n');
    const result = await measurePatchSize(
      root,
      diff,
      [
        'browser/modules/A.sys.mjs',
        'browser/base/content/test/browser_a.js',
        'browser/modules/moz.build',
      ],
      cfg({ patchSizeMetric: 'addedCode', patchSizeRegistrationFiles: ['moz.build'] })
    );
    expect(result).toEqual({
      metric: 'addedCode',
      lines: 5,
      testLines: 3,
      files: 2,
      registrationFiles: 1,
    });
  });

  it('reads comment state from the post-image when a hunk starts inside a block comment', async () => {
    const post = ['/*', ' * long comment', ' * still comment', ' */', 'const a = 1;', ''].join(
      '\n'
    );
    await writeFiles(root, { 'a.js': post });
    // The hunk carries only the tail of the comment: no `/*` in sight.
    const diff = [
      'diff --git a/a.js b/a.js',
      'index 1111111..2222222 100644',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -2,3 +2,4 @@',
      ' * long comment',
      '+ * still comment',
      ' */',
      '+const a = 1;',
      '',
    ].join('\n');
    const result = await measurePatchSize(
      root,
      diff,
      ['a.js'],
      cfg({ patchSizeMetric: 'addedCode' })
    );
    expect(result.lines).toBe(1);
  });

  it('skips lines inside a Furnace include span found in the post-image', async () => {
    const post = [
      ':host {}',
      '/* @fireforge-include shared.css */',
      '@keyframes a {}',
      '@keyframes b {}',
      '/* @fireforge-end-include shared.css */',
      '.local {}',
      '',
    ].join('\n');
    await writeFiles(root, { 'w/w.css': post });
    // The hunk starts inside the span and carries no begin marker.
    const diff = [
      'diff --git a/w/w.css b/w/w.css',
      'index 1111111..2222222 100644',
      '--- a/w/w.css',
      '+++ b/w/w.css',
      '@@ -3,3 +3,5 @@',
      ' @keyframes a {}',
      '+@keyframes b {}',
      ' /* @fireforge-end-include shared.css */',
      '+.local {}',
      '',
    ].join('\n');
    const result = await measurePatchSize(
      root,
      diff,
      ['w/w.css'],
      cfg({ patchSizeMetric: 'addedCode' })
    );
    expect(result.lines).toBe(1);
  });

  it('counts non-blank added lines when the post-image is missing, and ignores binary sections', async () => {
    const diff = [
      newFileSection('gone.js', ['// comment', '', 'x();']),
      'diff --git a/i.png b/i.png',
      'new file mode 100644',
      'index 0000000..3333333',
      'GIT binary patch',
      'literal 3',
      '+abc',
      '',
      'literal 0',
      '',
    ].join('\n');
    const result = await measurePatchSize(
      root,
      diff,
      ['gone.js', 'i.png'],
      cfg({ patchSizeMetric: 'addedCode' })
    );
    expect(result.lines).toBe(2);
    expect(result.files).toBe(2);
  });
});

describe('lintPatchSize bands and wording', () => {
  it('keeps the old behaviour for a bare line count', () => {
    const issues = lintPatchSize(['a.js'], 1501);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('Patch is 1501 lines (warning threshold: 1500');
  });

  it('says notice is advisory, over the design target, with no split hint', () => {
    const message = lintPatchSize(['a.js'], 801)[0]?.message ?? '';
    expect(message).toContain('over the design target of 800');
    expect(message).toContain('Advisory; does not fail --max-warnings 0.');
    expect(message).not.toContain('treats as a failure');
    expect(message).not.toContain('move-files');
  });

  it('names the gate and the dial at warning, and the split hint at warning and error', () => {
    const warning = lintPatchSize(['a.js'], 1501)[0]?.message ?? '';
    expect(warning).toContain('treats as a failure');
    expect(warning).toContain('patchLint.patchSizeThresholds');
    expect(warning).toContain('move-files');
    const error = lintPatchSize(['a.js'], 3001)[0]?.message ?? '';
    expect(error).toContain('Patch is 3001 lines (error threshold: 3000).');
    expect(error).toContain('move-files');
  });

  it('gives large-patch-files configurable notice and error bands', () => {
    const config = cfg({
      patchSizeThresholds: { general: { files: { notice: 8, warning: 12, error: 24 } } },
    });
    const filesSeverity = (n: number): string =>
      lintPatchSize(
        Array.from({ length: n }, (_, i) => `f${i}.js`),
        measured({ files: n }),
        undefined,
        config
      ).find((i) => i.check === 'large-patch-files')?.severity ?? 'none';
    expect(filesSeverity(8)).toBe('none');
    expect(filesSeverity(9)).toBe('notice');
    expect(filesSeverity(12)).toBe('notice');
    expect(filesSeverity(13)).toBe('warning');
    expect(filesSeverity(25)).toBe('error');
  });

  it('keeps the default files band warning-only', () => {
    const files = Array.from({ length: 500 }, (_, i) => `f${i}.js`);
    expect(lintPatchSize(files, 1).map((i) => i.severity)).toEqual(['warning']);
  });

  it('names registration files left out of the file count', () => {
    const issue = lintPatchSize(
      Array.from({ length: 8 }, (_, i) => `f${i}.js`),
      measured({ files: 6, registrationFiles: 2 })
    )[0];
    expect(issue?.message).toContain('Patch affects 6 files (not counting 2 registration file(s))');
  });

  it('holds test lines to the test tier and the rest to general inside a mixed patch', () => {
    const files = ['browser/modules/A.sys.mjs', 'browser/base/content/test/browser_a.js'];
    const issues = lintPatchSize(
      files,
      measured({ metric: 'addedCode', lines: 2900, testLines: 2000, files: 2 })
    );
    // 900 non-test code lines: over the general notice (800). 2000 test
    // lines: over the test notice (1500), under its warning (3000).
    expect(issues.map((i) => [i.severity, i.message.split(',')[0]])).toEqual([
      ['notice', 'Patch adds 900 code lines in non-test files'],
      ['notice', 'Patch adds 2000 code lines in test files (test tier)'],
    ]);
    expect(issues.map((i) => i.share)).toEqual(['product', 'test']);
  });

  it('tags an unsplit addedCode measurement as the product share, and diff as none', () => {
    const files = ['browser/modules/A.sys.mjs'];
    const [addedCode] = lintPatchSize(
      files,
      measured({ metric: 'addedCode', lines: 900, testLines: 0, files: 1 })
    );
    expect(addedCode?.share).toBe('product');
    expect(lintPatchSize(files, 2000)[0]).not.toHaveProperty('share');
  });

  it('does not split per class under the diff metric', () => {
    const files = ['browser/modules/A.sys.mjs', 'browser/base/content/test/browser_a.js'];
    expect(lintPatchSize(files, 2000).map((i) => i.severity)).toEqual(['warning']);
  });

  it('measures a whole branding patch against the configured branding tier', () => {
    const files = ['browser/branding/x/a.png', 'browser/branding/x/b.ftl'];
    const config = cfg({ patchSizeThresholds: { branding: { lines: { notice: 10 } } } });
    const issues = lintPatchSize(
      files,
      measured({ metric: 'addedCode', lines: 11, files: 2 }),
      undefined,
      config
    );
    expect(issues.map((i) => i.message.split(',')[0])).toEqual(['Patch adds 11 code lines']);
  });
});
