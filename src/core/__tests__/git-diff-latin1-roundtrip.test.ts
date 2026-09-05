// SPDX-License-Identifier: EUPL-1.2
/**
 * A new non-UTF-8 text file must round-trip byte-for-byte through an
 * exported patch, against a real git repository.
 *
 * The synthesized new-file body used to be built from a UTF-8 decode (every
 * Latin-1 high byte became U+FFFD) while the `index` line's blob hash came
 * from `git hash-object` over the real bytes. The patch applied cleanly but
 * wrote different bytes than the tree held, so the blob hash never matched
 * and drift checks flagged the file forever. Such files now travel as a
 * `GIT binary patch`. These tests pin that every new-file arm agrees and
 * that `git apply` in a fresh clone reproduces the original bytes.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, runGit } from '../../test-utils/index.js';
import { generateFullFilePatch, getAllDiff, getDiffForFilesAgainstHead } from '../git-diff.js';

const LATIN1_FILE = 'browser/locales/en-US/app.properties';
// Latin-1 bytes with no NUL: git's own heuristic calls this text, but the
// 0xE9 / 0xFC bytes are not valid UTF-8.
const LATIN1_BYTES = Buffer.from('caf\xe9=Caf\xe9\ngr\xfcsse=Gr\xfcsse\n', 'latin1');

describe('new Latin-1 file export (real git)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await removeTempProject(root);
      root = undefined;
    }
  });

  async function initRepo(): Promise<{ repo: string; clone: string }> {
    root = await createTempProject('ff-latin1-');
    const repo = join(root, 'repo');
    await mkdir(repo);
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.email', 'fireforge@example.test']);
    await runGit(repo, ['config', 'user.name', 'FireForge Tests']);
    await runGit(repo, ['config', 'core.autocrlf', 'false']);
    await writeFile(join(repo, 'tracked.js'), 'const a = 1;\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'initial']);

    // The pristine clone is where the exported patch gets applied.
    const clone = join(root, 'clone');
    await runGit(root, ['clone', '-q', repo, clone]);
    // A clone does not inherit the source repo's config: without this, a
    // Windows runner with a global core.autocrlf=true rewrites LF to CRLF on
    // checkout and the applied file no longer matches the original bytes.
    await runGit(clone, ['config', 'core.autocrlf', 'false']);
    await runGit(clone, ['config', 'core.eol', 'lf']);

    await mkdir(join(repo, 'browser/locales/en-US'), { recursive: true });
    await writeFile(join(repo, LATIN1_FILE), LATIN1_BYTES);
    return { repo, clone };
  }

  async function applyAndReadBack(clone: string, patch: string): Promise<Buffer> {
    const patchPath = join(clone, '..', 'export.patch');
    await writeFile(patchPath, patch);
    await runGit(clone, ['apply', '--index', patchPath]);
    return readFile(join(clone, LATIN1_FILE));
  }

  it('getDiffForFilesAgainstHead emits a binary patch that applies byte-for-byte', async () => {
    const { repo, clone } = await initRepo();

    const patch = await getDiffForFilesAgainstHead(repo, [LATIN1_FILE]);

    expect(patch).toContain('GIT binary patch');
    expect(patch).not.toContain('�');
    expect(await applyAndReadBack(clone, patch)).toEqual(LATIN1_BYTES);
    // The blob the clone now holds is the one the export hashed.
    const expectedBlob = (await runGit(repo, ['hash-object', LATIN1_FILE])).trim();
    const appliedBlob = (await runGit(clone, ['rev-parse', `:${LATIN1_FILE}`])).trim();
    expect(appliedBlob).toBe(expectedBlob);
  });

  it('getAllDiff emits a binary patch that applies byte-for-byte', async () => {
    const { repo, clone } = await initRepo();

    const patch = await getAllDiff(repo);

    expect(patch).toContain('GIT binary patch');
    expect(patch).not.toContain('�');
    expect(await applyAndReadBack(clone, patch)).toEqual(LATIN1_BYTES);
  });

  it('generateFullFilePatch emits a binary patch that applies byte-for-byte', async () => {
    const { repo, clone } = await initRepo();

    const patch = await generateFullFilePatch(repo, LATIN1_FILE);

    expect(patch).toContain('GIT binary patch');
    expect(await applyAndReadBack(clone, patch)).toEqual(LATIN1_BYTES);
  });

  it('forces the binary attribute for a path with spaces and glob characters', async () => {
    const { repo, clone } = await initRepo();
    const oddPath = 'browser/locales/en-US/odd name [1].properties';
    await writeFile(join(repo, oddPath), LATIN1_BYTES);

    const patch = await getDiffForFilesAgainstHead(repo, [oddPath]);

    expect(patch).toContain('GIT binary patch');
    const patchPath = join(clone, '..', 'odd.patch');
    await writeFile(patchPath, patch);
    await runGit(clone, ['apply', '--index', patchPath]);
    expect(await readFile(join(clone, oddPath))).toEqual(LATIN1_BYTES);
  });

  it('still emits a plain text body for a new UTF-8 file', async () => {
    const { repo } = await initRepo();
    await writeFile(join(repo, 'browser/locales/en-US/utf8.properties'), 'k=Grüße\n', 'utf-8');

    const patch = await getDiffForFilesAgainstHead(repo, ['browser/locales/en-US/utf8.properties']);

    expect(patch).toContain('+k=Grüße');
    expect(patch).not.toContain('GIT binary patch');
  });
});
