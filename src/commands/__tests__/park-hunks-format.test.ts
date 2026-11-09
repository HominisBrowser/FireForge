// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listParks } from '../../core/park-store.js';
import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { success } from '../../utils/logger.js';
import { parkCommand } from '../park.js';

vi.mock('../../utils/logger.js', () => ({
  isVerbose: vi.fn(() => false),
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
}));

const file = 'browser/skin/tokens.css';
const font = 'browser/skin/font.woff2';
const original = ':root {\n  --token: mine;\n}\n';
const hunk = '@@ -1,3 +1,3 @@\n :root {\n-  --token: baseline;\n+  --token: mine;\n }\n';
const text = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunk}`;
const binary = `diff --git a/${font} b/${font}\nBinary files a/${font} and b/${font} differ\n`;

describe('park hunk input formats', () => {
  let root: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await createTempProject();
    await writeFireForgeConfig(root);
    await initCommittedRepo(join(root, 'engine'), { [file]: original });
    await writeFiles(root, {
      'patches/patches.json': JSON.stringify({
        version: 1,
        patches: [
          {
            filename: '001-ui-tokens.patch',
            order: 1,
            category: 'ui',
            name: 'tokens',
            description: '',
            createdAt: '2026-11-05T00:00:00.000Z',
            sourceEsrVersion: '153.6.0esr',
            filesAffected: [file, font],
          },
        ],
      }),
      'patches/001-ui-tokens.patch': text,
      [`engine/${font}`]: Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0xff, 0x80, 1]),
    });
  });
  afterEach(async () => removeTempProject(root));

  async function assertUntouched(): Promise<void> {
    expect(await readProjectText(root, `engine/${file}`)).toBe(original);
    expect(await readFile(join(root, 'engine', font))).toEqual(
      Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0xff, 0x80, 1])
    );
    expect(await listParks(root)).toEqual([]);
    expect(success).not.toHaveBeenCalled();
  }

  it.each([
    ['empty', ''],
    ['unrecognized text', 'session edits, no diff\n'],
    ['bare hunk', hunk],
    ['binary without file headers', `Binary files a/${font} and b/${font} differ\n`],
    ['metadata only', `diff --git a/${file} b/${file}\nold mode 100644\nnew mode 100755\n`],
    ['binary stub', binary],
    [
      'binary payload',
      `diff --git a/${font} b/${font}\nGIT binary patch\nliteral 1\nLc${'0'.repeat(8)}\n`,
    ],
    ['mixed text and binary', text + binary],
    ['context only', `diff --git a/${file} b/${file}\n@@ -1,1 +1,1 @@\n :root {\n`],
    ['truncated hunk', `diff --git a/${file} b/${file}\n@@ -1,2 +1,2 @@\n-before\n+after\n`],
  ])('refuses %s before creating a park or changing any bytes', async (_name, diff) => {
    await writeFiles(root, { 'selection.diff': diff });
    await expect(
      parkCommand(root, '001', { label: 'mine', hunks: join(root, 'selection.diff') })
    ).rejects.toThrow(/--hunks.*(?:diff section|text hunks|@@ hunks)/);
    await assertUntouched();
  });

  it('parks plain unified text hunks with timestamps and restores them while binary bytes stay intact', async () => {
    const beforeFont = await readFile(join(root, 'engine', font));
    await writeFiles(root, {
      'selection.diff':
        `--- engine/${file}\t2026-11-05 10:00:00\n+++ engine/${file}\t2026-11-05 10:01:00\n${hunk}`.replaceAll(
          '\n',
          '\r\n'
        ),
    });
    await parkCommand(root, '001', { label: 'plain', hunks: join(root, 'selection.diff') });
    expect(await readProjectText(root, `engine/${file}`)).toBe(
      ':root {\n  --token: baseline;\n}\n'
    );
    expect((await listParks(root)).map((park) => park.label)).toEqual(['plain']);
    expect(await readFile(join(root, 'engine', font))).toEqual(beforeFont);
    await parkCommand(root, undefined, { restore: 'plain' });
    expect(await readProjectText(root, `engine/${file}`)).toBe(original);
    expect(await listParks(root)).toEqual([]);
    expect(await readFile(join(root, 'engine', font))).toEqual(beforeFont);
  });

  it('refuses a full park containing binary sections explicitly, while a narrow text park remains usable', async () => {
    await writeFiles(root, { 'patches/001-ui-tokens.patch': text + binary });
    await expect(parkCommand(root, '001', { label: 'full' })).rejects.toThrow(
      /contains binary sections.*--hunks/
    );
    await assertUntouched();
    await writeFiles(root, { 'selection.diff': text });
    await parkCommand(root, '001', { label: 'text-only', hunks: join(root, 'selection.diff') });
    expect(await readProjectText(root, `engine/${file}`)).toContain('--token: baseline;');
    expect(await readFile(join(root, 'engine', font))).toEqual(
      Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0xff, 0x80, 1])
    );
  });
});
