// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the new-file text/binary decision against real files: a
 * NUL byte or any byte sequence that is not valid UTF-8 must route the file
 * to the binary-patch arm, and a text file must come back with its exact
 * decoded content (BOM included).
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { readNewFileContent, withForcedBinaryAttribute } from '../git-diff-new-file.js';

describe('withForcedBinaryAttribute', () => {
  it('hands the task a -c core.attributesFile pair naming an anchored literal pattern', async () => {
    let attributesFile = '';
    const result = await withForcedBinaryAttribute('a dir/we[i]rd*?.rc', async (args) => {
      expect(args[0]).toBe('-c');
      attributesFile = (args[1] ?? '').replace(/^core\.attributesFile=/, '');
      // Glob metacharacters are backslash-escaped, then the C-quoting doubles
      // each backslash so git unquotes back to the single-escaped literal.
      expect(await readFile(attributesFile, 'utf-8')).toBe(
        '"/a dir/we\\\\[i\\\\]rd\\\\*\\\\?.rc" -diff\n'
      );
      return 'done';
    });

    expect(result).toBe('done');
    // The throwaway attributes file does not outlive the task.
    await expect(stat(attributesFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('escapes a backslash and a quote in the path so git matches them literally', async () => {
    // A backslash in the filename needs escaping twice over: once so the
    // glob layer reads it as a literal, and again for the C-quoting. A `"`
    // is not a glob metacharacter, so it takes the quoting escape only.
    // Escaping in two passes cannot tell either apart from its own output.
    await withForcedBinaryAttribute('a\\b"c.rc', async (args) => {
      const attributesFile = (args[1] ?? '').replace(/^core\.attributesFile=/, '');
      expect(await readFile(attributesFile, 'utf-8')).toBe('"/a\\\\\\\\b\\"c.rc" -diff\n');
    });
  });

  it('removes the temp attributes file when the task throws', async () => {
    let attributesFile = '';
    await expect(
      withForcedBinaryAttribute('x.rc', (args) => {
        attributesFile = (args[1] ?? '').replace(/^core\.attributesFile=/, '');
        return Promise.reject(new Error('git exploded'));
      })
    ).rejects.toThrow('git exploded');
    await expect(stat(attributesFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('readNewFileContent', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempProject('ff-new-file-');
  });

  afterEach(async () => {
    await removeTempProject(root);
  });

  it('returns decoded content for a valid UTF-8 file', async () => {
    await writeFile(join(root, 'app.properties'), 'greeting=Grüße 👋\n', 'utf-8');

    await expect(readNewFileContent(root, 'app.properties')).resolves.toEqual({
      binary: false,
      content: 'greeting=Grüße 👋\n',
    });
  });

  it('keeps a UTF-8 BOM in the content so the body matches the blob hash', async () => {
    await writeFile(join(root, 'bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));

    await expect(readNewFileContent(root, 'bom.txt')).resolves.toEqual({
      binary: false,
      content: '﻿a\n',
    });
  });

  it('classifies a Latin-1 file (no NUL, invalid UTF-8) as binary', async () => {
    await writeFile(join(root, 'latin1.rc'), Buffer.from('caf\xe9=Caf\xe9\n', 'latin1'));

    await expect(readNewFileContent(root, 'latin1.rc')).resolves.toEqual({ binary: true });
  });

  it('classifies a file with a NUL byte as binary', async () => {
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]));

    await expect(readNewFileContent(root, 'blob.bin')).resolves.toEqual({ binary: true });
  });

  it('returns empty text content for an empty file', async () => {
    await writeFile(join(root, 'empty.txt'), '');

    await expect(readNewFileContent(root, 'empty.txt')).resolves.toEqual({
      binary: false,
      content: '',
    });
  });
});
