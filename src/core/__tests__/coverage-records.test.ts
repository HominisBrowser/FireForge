// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  runGit,
  writeFiles,
} from '../../test-utils/index.js';
import { type BuildBaseline, DELETED_FILE_FINGERPRINT } from '../build-baseline-types.js';
import { filterByCarriedFullCoverage } from '../coverage-dispatch.js';
import {
  collectStagingInputs,
  createCoverageRecord,
  findChangedInputs,
  hashEngineFile,
  isTestManifestPath,
  isUnderPath,
  manifestExternalReferences,
  narrowAnchor,
  normalizeRequestPath,
  readEngineContentState,
} from '../coverage-records.js';

const MOZCONFIG = 'ac_add_options --enable-application=browser\n';
const FULL_SUITE = '(entire suite)';

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

describe('coverage path helpers', () => {
  it('normalizes request paths', () => {
    expect(normalizeRequestPath(' browser\\a\\test/ ')).toBe('browser/a/test');
    expect(normalizeRequestPath('./browser/./a')).toBe('browser/a');
    expect(normalizeRequestPath('.')).toBe('');
  });

  it('matches a path, its descendants, and everything under the empty prefix', () => {
    expect(isUnderPath('a/b/c.js', 'a/b')).toBe(true);
    expect(isUnderPath('a/b', 'a/b')).toBe(true);
    expect(isUnderPath('a/bc.js', 'a/b')).toBe(false);
    expect(isUnderPath('anything', '')).toBe(true);
  });

  it('recognizes test manifests by basename', () => {
    expect(isTestManifestPath('a/test/xpcshell.toml')).toBe(true);
    expect(isTestManifestPath('a/test/moz.build')).toBe(false);
  });

  it('extracts manifest references outside the manifest directory', () => {
    const text = [
      '[DEFAULT]',
      'head = "head.js ../common/head_common.js"',
      'support-files = [',
      '  "file_a.html",',
      '  "!/browser/base/content/test/general/head.js",',
      '  "/toolkit/shared/fixture.json",',
      '  "../fixtures/**",',
      '  "sub/dir/x.js",',
      '  "../../../../escape.js",',
      ']',
      '# https://bugzilla.mozilla.org/show_bug.cgi?id=1',
    ].join('\n');
    expect(manifestExternalReferences('browser/a/test/browser.toml', text)).toEqual([
      'browser/a/common/head_common.js',
      'browser/base/content/test/general/head.js',
      'toolkit/shared/fixture.json',
      'browser/a/fixtures',
    ]);
  });
});

describe('coverage records against a git engine', () => {
  let projectRoot: string;
  let engineDir: string;
  let head: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-coverage-records-');
    engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      '.gitignore': 'mozconfig\n',
      'browser/a/test/browser.toml':
        'support-files = ["../data/**"]\n["browser/browser_nested.js"]\n',
      'browser/a/test/browser/browser_nested.js': 'nested\n',
      'browser/a/data/x.json': '{}\n',
      'browser/b/test/unit/xpcshell.toml': '["test_b.js"]\n',
      'browser/b/test/unit/test_b.js': 'b\n',
      'browser/b/test/unit/deep/xpcshell.toml': 'head = "../../../../shared/head.js"\n',
      'browser/shared/head.js': 'shared\n',
      'loose/no_manifest.js': 'loose\n',
      'top.js': 'top\n',
    });
    await writeFiles(engineDir, { mozconfig: MOZCONFIG });
    head = (await runGit(engineDir, ['rev-parse', 'HEAD'])).trim();
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('anchors a nested test file to the manifest directory above it', async () => {
    await expect(
      collectStagingInputs(engineDir, 'browser/a/test/browser/browser_nested.js')
    ).resolves.toEqual(['browser/a/data', 'browser/a/test']);
  });

  it('reads manifests beneath a directory request', async () => {
    await expect(collectStagingInputs(engineDir, 'browser/b/test/unit/')).resolves.toEqual([
      'browser/b/test/unit',
      'browser/shared/head.js',
    ]);
  });

  it('falls back to the containing directory, or the file itself at the top level', async () => {
    await expect(collectStagingInputs(engineDir, 'loose/no_manifest.js')).resolves.toEqual([
      'loose',
    ]);
    await expect(collectStagingInputs(engineDir, 'top.js')).resolves.toEqual(['top.js']);
    await expect(collectStagingInputs(engineDir, 'missing/dir/test.js')).resolves.toEqual([
      'missing/dir',
    ]);
  });

  it('hashes files, marks deletions, and refuses to vouch for unreadable paths', async () => {
    await expect(hashEngineFile(engineDir, 'top.js')).resolves.toBe(sha256('top\n'));
    await expect(hashEngineFile(engineDir, 'gone.js')).resolves.toBe(DELETED_FILE_FINGERPRINT);
    await expect(hashEngineFile(engineDir, 'browser')).resolves.toBeUndefined();
  });

  it('records a path with its dirty inputs and detects later edits and new files', async () => {
    await writeFiles(engineDir, { 'browser/b/test/unit/test_b.js': 'b edit\n' });
    const state = await readEngineContentState(engineDir);
    const record = await createCoverageRecord(state, 'browser/b/test/unit', sha256(MOZCONFIG));
    expect(record).toEqual({
      engineHeadSha: head,
      mozconfigHash: sha256(MOZCONFIG),
      inputs: ['browser/b/test/unit', 'browser/shared/head.js'],
      fingerprints: { 'browser/b/test/unit/test_b.js': sha256('b edit\n') },
    });
    if (record === undefined) return;

    await expect(
      findChangedInputs(await readEngineContentState(engineDir), record, record.inputs)
    ).resolves.toEqual([]);

    await writeFiles(engineDir, {
      'browser/shared/head.js': 'shared edit\n',
      'browser/b/test/unit/new_fixture.txt': 'new\n',
      'top.js': 'outside\n',
    });
    await expect(
      findChangedInputs(await readEngineContentState(engineDir), record, record.inputs)
    ).resolves.toEqual(['browser/b/test/unit/new_fixture.txt', 'browser/shared/head.js']);

    // Reverting a recorded dirty file to HEAD is a change too.
    await runGit(engineDir, ['checkout', '--', 'browser/b/test/unit/test_b.js']);
    await expect(
      findChangedInputs(
        await readEngineContentState(engineDir),
        record,
        ['browser/b/test/unit'],
        ['browser/b/test/unit/new_fixture.txt']
      )
    ).resolves.toEqual(['browser/b/test/unit/test_b.js']);
  });

  it('narrows a baseline-wide anchor to the inputs it is asked about', async () => {
    await writeFiles(engineDir, { 'browser/shared/head.js': 'edit\n' });
    const state = await readEngineContentState(engineDir);
    const narrowed = await narrowAnchor(
      state,
      {
        engineHeadSha: head,
        mozconfigHash: sha256(MOZCONFIG),
        fingerprints: { 'top.js': sha256('x'), 'browser/a/data/x.json': sha256('y') },
      },
      ['browser/a'],
      ['browser/shared/head.js', 'browser/a/data/x.json']
    );
    expect(narrowed?.fingerprints).toEqual({ 'browser/a/data/x.json': sha256('{}\n') });
  });

  it('cannot record or compare without a HEAD', async () => {
    const unborn = join(projectRoot, 'unborn');
    await writeFiles(unborn, { 'a.js': 'a' });
    await runGit(unborn, ['init', '-q']);
    const state = await readEngineContentState(unborn);
    expect(state.head).toBeUndefined();
    expect(state.dirty.has('a.js')).toBe(true);
    await expect(createCoverageRecord(state, 'a.js', sha256(MOZCONFIG))).resolves.toBeUndefined();
    await expect(
      findChangedInputs(
        state,
        { engineHeadSha: 'x', mozconfigHash: '', fingerprints: {} },
        undefined
      )
    ).resolves.toBeUndefined();
  });

  describe('filterByCarriedFullCoverage', () => {
    const anchor = (): {
      engineHeadSha: string;
      mozconfigHash: string;
      fingerprints: Record<string, string>;
    } => ({
      engineHeadSha: head,
      mozconfigHash: sha256(MOZCONFIG),
      fingerprints: {},
    });
    const baseline = (fullCoverageAnchor = anchor()): BuildBaseline => ({
      engineHeadSha: head,
      builtAt: '2026-10-01T00:00:00.000Z',
      binaryName: 'mybrowser',
      testPackagingCoverage: ['browser/a/test'],
      fullCoverageAnchor,
    });

    it('returns every path unresolved without a carried anchor', async () => {
      await expect(
        filterByCarriedFullCoverage(engineDir, undefined, ['browser/b/test/unit'], FULL_SUITE)
      ).resolves.toEqual([{ path: 'browser/b/test/unit', changed: [] }]);
    });

    it('covers a path whose own inputs are unchanged and names the inputs that changed', async () => {
      await writeFiles(engineDir, { 'browser/shared/head.js': 'edit\n' });
      await expect(
        filterByCarriedFullCoverage(
          engineDir,
          baseline(),
          [
            'loose/no_manifest.js',
            'browser/b/test/unit/test_b.js',
            'browser/b/test/unit',
            FULL_SUITE,
          ],
          FULL_SUITE
        )
      ).resolves.toEqual([
        { path: 'browser/b/test/unit', changed: ['browser/shared/head.js'] },
        { path: FULL_SUITE, changed: ['browser/shared/head.js'] },
      ]);
    });

    it('does not cover anything once the mozconfig changed', async () => {
      await writeFiles(engineDir, { mozconfig: 'other\n' });
      await expect(
        filterByCarriedFullCoverage(engineDir, baseline(), ['loose/no_manifest.js'], FULL_SUITE)
      ).resolves.toEqual([{ path: 'loose/no_manifest.js', changed: [] }]);
    });

    it('does not cover anything when the engine state cannot be read', async () => {
      const notGit = join(projectRoot, 'not-a-repo');
      await writeFiles(notGit, { mozconfig: MOZCONFIG });
      await expect(
        filterByCarriedFullCoverage(notGit, baseline(), ['loose/no_manifest.js'], FULL_SUITE)
      ).resolves.toEqual([{ path: 'loose/no_manifest.js', changed: [] }]);
    });

    it('keeps a path whose anchor HEAD cannot be compared', async () => {
      await expect(
        filterByCarriedFullCoverage(
          engineDir,
          baseline({ ...anchor(), engineHeadSha: 'f'.repeat(40) }),
          ['loose/no_manifest.js'],
          FULL_SUITE
        )
      ).resolves.toEqual([{ path: 'loose/no_manifest.js', changed: [] }]);
    });
  });
});
