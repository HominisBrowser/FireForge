// SPDX-License-Identifier: EUPL-1.2
/**
 * `re-export --hunks-from` / `--exclude-hunks` export a shared file by hunk,
 * so a peer's unexported line in the same file stays out of the patch.
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedHunk } from '../../core/patch-parse.js';
import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { reExportCommand } from '../re-export.js';
import { applyHunksByContext, splitRawSections } from '../re-export-hunks.js';

vi.mock('../../utils/logger.js', () => ({
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

const SHARED = 'shared.toml';
const OLD_BODY = [
  `diff --git a/${SHARED} b/${SHARED}`,
  'index 1111111..2222222 100644',
  `--- a/${SHARED}`,
  `+++ b/${SHARED}`,
  '@@ -1,3 +1,4 @@',
  ' a',
  '+mine-old',
  ' b',
  ' c',
  '',
].join('\n');

/** This session's own edit, taken against the patch-applied file. */
const MINE = [
  `diff --git a/${SHARED} b/${SHARED}`,
  `--- a/${SHARED}`,
  `+++ b/${SHARED}`,
  '@@ -1,3 +1,4 @@',
  ' a',
  ' mine-old',
  '+mine-new',
  ' b',
  '',
].join('\n');

/** The peer's unexported edit, taken against the file before it. */
const PEER = [
  `diff --git a/${SHARED} b/${SHARED}`,
  `--- a/${SHARED}`,
  `+++ b/${SHARED}`,
  '@@ -3,2 +3,3 @@',
  ' mine-new',
  ' b',
  '+peer-line',
  '',
].join('\n');

function hunk(lines: string[], oldStart: number, newStart: number): ParsedHunk {
  return {
    oldStart,
    oldCount: lines.filter((line) => !line.startsWith('+')).length,
    newStart,
    newCount: lines.filter((line) => !line.startsWith('-')).length,
    lines,
    noNewlineAtEndOld: false,
    noNewlineAtEndNew: false,
  };
}

describe('applyHunksByContext', () => {
  it('places a hunk by its context when lines above it moved', () => {
    const shifted = 'x\ny\na\nb\nc\n';
    expect(applyHunksByContext(shifted, [hunk([' a', '+n', ' b'], 1, 1)], false, 'f')).toBe(
      'x\ny\na\nn\nb\nc\n'
    );
  });

  it('reverses a hunk and refuses one whose context is gone', () => {
    expect(applyHunksByContext('a\nn\nb\n', [hunk([' a', '+n', ' b'], 1, 1)], true, 'f')).toBe(
      'a\nb\n'
    );
    expect(() => applyHunksByContext('q\n', [hunk([' a', '+n'], 1, 1)], false, 'f')).toThrow(
      /does not apply to the patch body of f/
    );
  });

  it('inserts into an empty file and splits raw sections by target', () => {
    expect(applyHunksByContext('', [hunk(['+first'], 0, 1)], false, 'f')).toBe('first\n');
    expect([...splitRawSections(`${OLD_BODY}${MINE}`).keys()]).toEqual([SHARED]);
  });
});

describe('re-export by hunk', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), { [SHARED]: 'a\nb\nc\n' });
    await writeFiles(projectRoot, {
      'patches/patches.json': JSON.stringify({
        version: 1,
        patches: [
          {
            filename: '001-ui-shared.patch',
            order: 1,
            category: 'ui',
            name: 'shared',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: [SHARED],
          },
        ],
      }),
      'patches/001-ui-shared.patch': OLD_BODY,
      'mine.diff': MINE,
      'peer.diff': PEER,
      // The engine carries both sessions' lines.
      [`engine/${SHARED}`]: 'a\nmine-old\nmine-new\nb\npeer-line\nc\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it.each([
    ['--hunks-from', 'hunksFrom', 'mine.diff'],
    ['--exclude-hunks', 'excludeHunks', 'peer.diff'],
  ] as const)(
    '%s exports this session’s lines and leaves the peer’s out',
    async (_flag, key, diff) => {
      await reExportCommand(projectRoot, ['001'], {
        [key]: join(projectRoot, diff),
        skipLint: true,
      });
      const body = await readProjectText(projectRoot, 'patches/001-ui-shared.patch');
      expect(body).toContain('+mine-old');
      expect(body).toContain('+mine-new');
      expect(body).not.toContain('peer-line');
      expect(body).toContain(`diff --git a/${SHARED} b/${SHARED}`);
      // The engine is left exactly as it was.
      await expect(readProjectText(projectRoot, `engine/${SHARED}`)).resolves.toBe(
        'a\nmine-old\nmine-new\nb\npeer-line\nc\n'
      );
    }
  );

  it('refuses a diff naming a file the patch does not own, and bad combinations', async () => {
    await writeFiles(projectRoot, { 'other.diff': MINE.replaceAll(SHARED, 'other.toml') });
    await expect(
      reExportCommand(projectRoot, ['001'], {
        hunksFrom: join(projectRoot, 'other.diff'),
        skipLint: true,
      })
    ).rejects.toThrow(/All selected patches failed/);
    await expect(
      reExportCommand(projectRoot, ['001'], { hunksFrom: 'a.diff', excludeHunks: 'b.diff' })
    ).rejects.toThrow(/alternatives/);
    await expect(
      reExportCommand(projectRoot, ['001'], { hunksFrom: 'a.diff', scan: true })
    ).rejects.toThrow(/exactly one patch/);
  });
});
