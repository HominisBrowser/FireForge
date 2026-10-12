// SPDX-License-Identifier: EUPL-1.2
import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import {
  classifyRuntimeDelivery,
  type InstallManifestIndex,
  installsFromDirectory,
  loadInstallManifestIndex,
} from '../objdir-install-manifests.js';
import {
  findSingleObjDir,
  formatStaleExemptions,
  partitionStaleCandidates,
} from '../test-stale-exempt.js';

const SEP = '\x1f';
const OBJ = 'obj-test';

async function link(engineDir: string, dest: string, source: string): Promise<void> {
  const path = join(engineDir, OBJ, dest);
  await mkdir(dirname(path), { recursive: true });
  await symlink(join(engineDir, source), path);
}

// Symlinked objdir entries are the dev-build shape on macOS and Linux. On
// Windows mozpack copies instead, which the classifier reports as packaged.
describe.skipIf(process.platform === 'win32')('objdir install manifests', () => {
  let projectRoot: string;
  let engineDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-install-manifests-');
    engineDir = join(projectRoot, 'engine');
    const abs = (path: string): string => join(engineDir, path);
    const manifest = (...lines: string[][]): string =>
      ['5', ...lines.map((fields) => fields.join(SEP))].join('\n');
    await writeFiles(engineDir, {
      'browser/a/test/browser_a.js': 'a',
      'testing/mochitest/browser-test.js': 'harness',
      'toolkit/copied.js': 'copied',
      'browser/pre.xhtml': 'pre',
      'browser/base/content/live.js': 'live',
      'browser/base/content/broken.js': 'broken',
      'browser/data/d.json': '{}',
      'browser/pcopy/a/b.css': 'css',
      'xpcom/x.idl': 'idl',
      'browser/unified.js': 'unified',
      [`${OBJ}/_build_manifests/install/_test_files`]: manifest([
        '1',
        'testing/mochitest/browser/browser/a/test/browser_a.js',
        abs('browser/a/test/browser_a.js'),
      ]),
      [`${OBJ}/_build_manifests/install/_tests`]: manifest(
        ['1', 'testing/mochitest/browser-test.js', abs('testing/mochitest/browser-test.js')],
        ['1', 'elsewhere.js', '/somewhere/else/elsewhere.js']
      ),
      [`${OBJ}/_build_manifests/install/dist_bin`]: manifest(
        ['2', 'copied.js', abs('toolkit/copied.js')],
        ['7', 'pre.xhtml', abs('browser/pre.xhtml'), 'deps', '#'],
        ['3', 'exists.txt']
      ),
      [`${OBJ}/_build_manifests/install/xpidl`]: manifest(['1', 'x.idl', abs('xpcom/x.idl')]),
      [`${OBJ}/_build_manifests/install/.test_install_stamp`]: 'stamp',
      [`${OBJ}/faster/Makefile`]: 'INSTALL_MANIFESTS = dist/bin/browser\n',
      [`${OBJ}/faster/install_dist_bin_browser`]: manifest(
        ['1', 'chrome/browser/content/live.js', abs('browser/base/content/live.js')],
        ['1', 'chrome/browser/content/broken.js', abs('browser/base/content/broken.js')],
        ['5', 'chrome/data/*.json', abs('browser/data'), '*.json', 'chrome/data'],
        ['6', 'chrome/pc/**', abs('browser/pcopy'), '**/*.css', 'chrome/pc'],
        ['5', 'x/../y', abs('browser/up'), '../y/**', 'x']
      ),
      [`${OBJ}/faster/install_dist_bin_browser.track`]: 'ignored',
      [`${OBJ}/faster/unified_install_dist_bin`]: manifest([
        '1',
        'browser/unified.js',
        abs('browser/unified.js'),
      ]),
      [`${OBJ}/dist/bin/browser/chrome/browser/content/broken.js`]: 'a real copy',
    });
    await link(engineDir, 'dist/bin/browser/unified.js', 'browser/unified.js');
    await link(
      engineDir,
      'dist/bin/browser/chrome/browser/content/live.js',
      'browser/base/content/live.js'
    );
    await link(engineDir, 'dist/bin/browser/chrome/data/d.json', 'browser/data/d.json');
    await link(
      engineDir,
      '_tests/testing/mochitest/browser-test.js',
      'testing/mochitest/browser-test.js'
    );
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  async function index(): Promise<InstallManifestIndex> {
    const loaded = await loadInstallManifestIndex(engineDir, OBJ);
    if (loaded === undefined) throw new Error('index did not load');
    return loaded;
  }

  it.each([
    ['browser/a/test/browser_a.js', 'at-dispatch'],
    ['testing/mochitest/browser-test.js', 'live'],
    ['toolkit/copied.js', 'packaged'],
    ['browser/pre.xhtml', 'packaged'],
    ['browser/base/content/live.js', 'live'],
    ['browser/base/content/broken.js', 'packaged'],
    ['browser/data/d.json', 'live'],
    ['browser/data/sub/e.json', 'unlisted'],
    ['browser/pcopy/a/b.css', 'packaged'],
    ['xpcom/x.idl', 'packaged'],
    ['other/unlisted.js', 'unlisted'],
    ['browser/unified.js', 'live'],
  ])('classifies %s as %s', async (path, expected) => {
    await expect(classifyRuntimeDelivery(await index(), engineDir, path)).resolves.toBe(expected);
  });

  it('answers whether anything is installed from a directory', async () => {
    const loaded = await index();
    expect(installsFromDirectory(loaded, 'browser/base/')).toBe(true);
    expect(installsFromDirectory(loaded, 'browser/data/sub/')).toBe(true);
    expect(installsFromDirectory(loaded, 'browser/pcopy')).toBe(true);
    expect(installsFromDirectory(loaded, 'nothing/')).toBe(false);
  });

  it('loads nothing from an objdir without manifests', async () => {
    await writeFiles(engineDir, { 'obj-empty/x.txt': 'x' });
    await expect(loadInstallManifestIndex(engineDir, 'obj-empty')).resolves.toBeUndefined();
  });

  it('partitions stale candidates into stale and served paths', async () => {
    await expect(findSingleObjDir(engineDir)).resolves.toBe(OBJ);
    const result = await partitionStaleCandidates(engineDir, [
      'browser/base/content/live.js',
      'browser/a/test/browser_a.js',
      'browser/a/test/browser_new.js',
      'toolkit/copied.js',
      'other/unlisted.js',
    ]);
    expect(result).toEqual({
      stale: ['toolkit/copied.js', 'other/unlisted.js'],
      exempt: [
        { path: 'browser/base/content/live.js', why: 'symlinked' },
        { path: 'browser/a/test/browser_a.js', why: 'test-only' },
        { path: 'browser/a/test/browser_new.js', why: 'test-only' },
      ],
    });
    expect(formatStaleExemptions(result.exempt, 2)).toBe(
      'browser/base/content/live.js (objdir symlink to the source), browser/a/test/browser_a.js (test file, restaged at dispatch), … (+1 more)'
    );
  });

  it('keeps every path stale without exactly one objdir', async () => {
    await writeFiles(engineDir, { 'obj-other/x.txt': 'x' });
    await expect(findSingleObjDir(engineDir)).resolves.toBeUndefined();
    await expect(
      partitionStaleCandidates(engineDir, ['browser/base/content/live.js'])
    ).resolves.toEqual({ stale: ['browser/base/content/live.js'], exempt: [] });
    await expect(findSingleObjDir(join(projectRoot, 'missing'))).resolves.toBeUndefined();
    await expect(partitionStaleCandidates(engineDir, [])).resolves.toEqual({
      stale: [],
      exempt: [],
    });
  });
});
