// SPDX-License-Identifier: EUPL-1.2
import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { generationDeltaPaths } from '../../core/engine-session-lock.js';
import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import { warn } from '../../utils/logger.js';
import { describePerfStaleImpact, perfGenerationTolerance } from '../test-perf-scope.js';

const SEP = '\x1f';

/** A generation token: HEAD, NUL, then `git status --porcelain=v1 -z` records. */
function token(head: string, ...records: string[]): string {
  return `${head}\0${records.map((record) => `${record}\0`).join('')}`;
}

describe('generationDeltaPaths', () => {
  it('names both sides of changed records, including renames, and HEAD moves', () => {
    expect(
      generationDeltaPaths(
        token('a', ' M kept.js', ' M old.js'),
        token('b', ' M kept.js', 'R  new.js', 'old.js', '?? dir/')
      )
    ).toEqual({ headMoved: true, paths: ['dir/', 'new.js', 'old.js'] });
  });
});

describe.skipIf(process.platform === 'win32')('perf sample scope', () => {
  let projectRoot: string;
  let engineDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject('ff-perf-scope-');
    engineDir = join(projectRoot, 'engine');
    const live = join(engineDir, 'browser/base/content/live.js');
    await writeFiles(engineDir, {
      'browser/base/content/test/perf/browser.toml': '["browser_startup.js"]\n',
      'browser/base/content/test/perf/browser_startup.js': 'sample',
      'browser/base/content/test/perf/head.js': 'head',
      'browser/base/content/live.js': 'live',
      'widget/cocoa/nsView.mm': 'cpp',
      'obj-test/faster/Makefile': 'INSTALL_MANIFESTS = dist/bin\n',
      'obj-test/faster/install_dist_bin': ['5', ['1', 'live.js', live].join(SEP)].join('\n'),
    });
    const dest = join(engineDir, 'obj-test/dist/bin/live.js');
    await mkdir(dirname(dest), { recursive: true });
    await symlink(live, dest);
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it("separates the sampled test's stale inputs from stale files elsewhere", async () => {
    await expect(
      describePerfStaleImpact(
        engineDir,
        ['browser/base/content/test/perf/head.js', 'browser/base/content/live.js'],
        ['browser/base/content/test/perf/browser_startup.js']
      )
    ).resolves.toBe(
      'Perf sample impact: 1 stale file(s) are staging inputs of the sampled test ' +
        '(browser/base/content/test/perf/head.js), so the sample would measure the old content; ' +
        '1 stale packaged file(s) lie outside them (browser/base/content/live.js) and affect the ' +
        'sample only if the measured path loads them. Repackage first, or pass --allow-stale-build ' +
        'to take the sample knowingly.'
    );
  });

  it('says when the fixture is unaffected, and when no test path was named', async () => {
    const elsewhere = Array.from({ length: 7 }, (_, i) => `toolkit/f${i}.js`);
    const unaffected = await describePerfStaleImpact(engineDir, elsewhere, [
      'browser/base/content/test/perf/browser_startup.js',
    ]);
    expect(unaffected).toContain("the sampled test's own staging inputs are unaffected");
    expect(unaffected).toContain('toolkit/f4.js, … (+2 more)');
    await expect(describePerfStaleImpact(engineDir, ['toolkit/a.js'], [])).resolves.toContain(
      'no test paths were named, so every stale file may be measured.'
    );
  });

  it('keeps a perf sample when only unpackaged files changed mid-run', async () => {
    const tolerate = perfGenerationTolerance(engineDir);
    await expect(
      tolerate(token('h'), token('h', ' M widget/cocoa/nsView.mm', '?? docs/new/'))
    ).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the sample stands'));
  });

  it.each([
    ['a packaged chrome file', token('h', ' M browser/base/content/live.js')],
    ['a test file', token('h', ' M browser/base/content/test/perf/head.js')],
    ['a directory the build installs from', token('h', '?? browser/base/')],
  ])('still invalidates the sample on %s', async (_label, after) => {
    await expect(perfGenerationTolerance(engineDir)(token('h'), after)).resolves.toBe(false);
  });

  it('still invalidates on a HEAD move, an empty delta, or an unreadable objdir', async () => {
    const tolerate = perfGenerationTolerance(engineDir);
    await expect(tolerate(token('h'), token('i', ' M widget/cocoa/nsView.mm'))).resolves.toBe(
      false
    );
    await expect(tolerate(token('h'), token('h'))).resolves.toBe(false);
    await expect(
      perfGenerationTolerance(join(projectRoot, 'missing'))(
        token('h'),
        token('h', ' M widget/cocoa/nsView.mm')
      )
    ).resolves.toBe(false);
  });
});
