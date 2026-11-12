// SPDX-License-Identifier: EUPL-1.2
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git } from '../testing/git.js';
import { createSourceFixture, type SourceFixture } from '../testing/source.js';
import { useTempDir } from '../testing/temp.js';
import { override, readSourceFile, restore, verifySource, writeSourceFile } from './index.js';

const dir = useTempDir();
const MANIFEST = 'browser/manifest.txt';
const RECORD = `.fireforge-sources/overrides/${MANIFEST}.json`;

async function fixture(): Promise<SourceFixture> {
  return createSourceFixture(dir());
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'none',
    (error: unknown) => (error as { code: string }).code
  );
}

describe('override', () => {
  it('records the upstream identity and seeds the owned file with pristine bytes', async () => {
    const value = await fixture();
    const project = await value.load();
    const { record, driverInstalled } = await override(project, value.pristine, MANIFEST, {
      component: 'ui-sidebar',
    });
    expect(driverInstalled).toBe(true);
    const blob = (await git(value.pristine.repo, ['rev-parse', `HEAD:${MANIFEST}`])).trim();
    expect(record).toEqual({
      kind: 'override',
      base: { commit: value.pristine.commit, blob, mode: '100644' },
      component: 'ui-sidebar',
      classification: 'registration',
    });
    expect(JSON.parse(await readFile(join(value.root, RECORD), 'utf8'))).toEqual(record);
    expect(await readFile(join(value.root, 'src', MANIFEST), 'utf8')).toBe(
      'first\nsecond\nthird\nfourth\nfifth\n'
    );
    // Repeating the same declaration changes nothing; a different one is refused.
    await expect(
      override(project, value.pristine, MANIFEST, { component: 'ui-sidebar' })
    ).resolves.toEqual({ record, driverInstalled: false });
    expect(await failureCode(override(project, value.pristine, MANIFEST))).toBe(
      'source-override-exists'
    );
    expect(await verifySource(project, value.pristine)).toEqual([]);
  });

  it('keeps the executable bit and installs the merge driver configuration', async () => {
    const value = await fixture();
    await override(await value.load(), value.pristine, 'browser/run.sh');
    // Windows has no executable bit.
    if (process.platform !== 'win32') {
      expect((await stat(join(value.root, 'src/browser/run.sh'))).mode & 0o111).not.toBe(0);
    }
    expect(await git(value.root, ['config', '--get', 'merge.fireforge.driver'])).toMatch(
      / %O %A %B %P %S\n$/
    );
  });

  it('refuses an existing undeclared edit, a path upstream lacks, and an exception without its ADR', async () => {
    const value = await fixture();
    const project = await value.load();
    await value.write({ [`src/${MANIFEST}`]: 'edited first\n' });
    expect(await failureCode(override(project, value.pristine, MANIFEST))).toBe(
      'source-undeclared-edit'
    );
    expect(await failureCode(override(project, value.pristine, 'browser/new.js'))).toBe(
      'source-not-upstream'
    );
    expect(
      await failureCode(
        override(project, value.pristine, 'browser/base/jar.mn', { classification: 'exception' })
      )
    ).toBe('source-adr-required');
    expect(
      await failureCode(
        override(project, value.pristine, 'browser/base/jar.mn', {
          classification: 'exception',
          adr: 'docs/adr/missing.md',
        })
      )
    ).toBe('source-adr-missing');
    expect(await failureCode(override(project, value.pristine, '../escape'))).toBe(
      'source-invalid-path'
    );
  });

  it('declares a deletion as a tombstone without an owned file', async () => {
    const value = await fixture();
    const project = await value.load();
    await value.write({ 'docs/adr/drop.md': 'Approved.\n' });
    const { record } = await override(project, value.pristine, MANIFEST, {
      delete: true,
      classification: 'exception',
      adr: 'docs/adr/drop.md',
    });
    expect(record.kind).toBe('delete');
    await expect(readFile(join(value.root, 'src', MANIFEST))).rejects.toThrow();
    expect(await readSourceFile(project, value.pristine, MANIFEST)).toBeUndefined();
  });
});

describe('restore', () => {
  it('refuses uncommitted edits, but not seeded or committed bytes', async () => {
    const value = await fixture();
    const project = await value.load();
    await override(project, value.pristine, MANIFEST);
    await expect(restore(project, MANIFEST)).resolves.toMatchObject({ removedFile: true });
    await override(project, value.pristine, MANIFEST);
    await value.write({ [`src/${MANIFEST}`]: 'committed edit\n' });
    await value.commit();
    await restore(project, MANIFEST);
    await override(project, value.pristine, MANIFEST);
    await value.write({ [`src/${MANIFEST}`]: 'uncommitted edit\n' });
    expect(await failureCode(restore(project, MANIFEST))).toBe('source-uncommitted-edit');
    expect(await readFile(join(value.root, 'src', MANIFEST), 'utf8')).toBe('uncommitted edit\n');
    await restore(project, MANIFEST, { discard: true });
    await expect(readFile(join(value.root, 'src', MANIFEST))).rejects.toThrow();
    await expect(readFile(join(value.root, RECORD))).rejects.toThrow();
    expect(await failureCode(restore(project, MANIFEST))).toBe('source-not-overridden');
  });
});

describe('writeSourceFile', () => {
  it('needs a current override for an upstream path and compares before writing', async () => {
    const value = await fixture();
    const project = await value.load();
    const jar = 'browser/base/jar.mn';
    const next = Buffer.from('browser.jar:\n  content/browser/ours.js (content/ours.js)\n');
    expect(await failureCode(writeSourceFile(project, value.pristine, jar, next))).toBe(
      'source-override-required'
    );
    await override(project, value.pristine, jar);
    const current = await readSourceFile(project, value.pristine, jar);
    await writeSourceFile(project, value.pristine, jar, next, { expected: current ?? null });
    expect(
      await failureCode(
        writeSourceFile(project, value.pristine, jar, Buffer.from('x'), {
          expected: current ?? null,
        })
      )
    ).toBe('source-file-moved');
    expect(await readFile(join(value.root, 'src', jar))).toEqual(next);
    await writeSourceFile(project, value.pristine, 'browser/new.js', Buffer.from('new\n'), {
      expected: null,
    });
    expect(await readSourceFile(project, value.pristine, 'browser/new.js')).toEqual(
      Buffer.from('new\n')
    );
  });

  it('lets exactly one of two writers that read the same bytes replace them', async () => {
    const value = await fixture();
    const project = await value.load();
    const path = 'browser/shared.js';
    await writeSourceFile(project, value.pristine, path, Buffer.from('v1\n'));
    const read = await readSourceFile(project, value.pristine, path);
    const outcomes = await Promise.all(
      ['a', 'b'].map((writer) =>
        failureCode(
          writeSourceFile(project, value.pristine, path, Buffer.from(`${writer}\n`), {
            expected: read ?? null,
          })
        )
      )
    );
    expect(outcomes.sort()).toEqual(['none', 'source-file-moved']);
  });

  it('serialises competing first declarations instead of letting one replace the other', async () => {
    const value = await fixture();
    const project = await value.load();
    const outcomes = await Promise.all(
      ['ui-a', 'ui-b'].map((component) =>
        failureCode(override(project, value.pristine, MANIFEST, { component }))
      )
    );
    expect(outcomes.sort()).toEqual(['none', 'source-override-exists']);
  });
});
