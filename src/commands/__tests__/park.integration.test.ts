// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge park` sets a session's edits in a patch's files aside and puts
 * them back with a three-way merge after the owner's commit.
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listParks, mergeThreeWay, planRestore, removedLines } from '../../core/park-store.js';
import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { info, warn } from '../../utils/logger.js';
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

const FTL = 'browser/locales/shared.ftl';
const MARKUP = 'browser/base/content/peer.xhtml';
const BODY = [
  `diff --git a/${FTL} b/${FTL}`,
  'index 1111111..2222222 100644',
  `--- a/${FTL}`,
  `+++ b/${FTL}`,
  '@@ -1,2 +1,3 @@',
  ' a = A',
  '+b = B',
  ' z = Z',
  '',
].join('\n');

function row(filename: string, order: number, filesAffected: string[]): Record<string, unknown> {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.slice(4, -6),
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

function lines(mock: typeof info): string {
  return vi
    .mocked(mock)
    .mock.calls.map((call) => call[0])
    .join('\n');
}

describe('park helpers', () => {
  it('computes removed lines as a multiset and merges cleanly or with markers', async () => {
    expect(removedLines('a\nb\nb\n', 'a\nb\n')).toEqual(['b']);
    await expect(
      mergeThreeWay('x\nb\nc\nd\n', 'a\nb\nc\nd\n', 'a\nb\nc\ny\n', 'f')
    ).resolves.toEqual({ content: 'x\nb\nc\ny\n', conflicts: 0 });
    const conflict = await mergeThreeWay('x\n', 'a\n', 'y\n', 'f');
    expect(conflict.conflicts).toBe(1);
    expect(conflict.content).toContain('<<<<<<< f (now)');
  });

  it('plans absence as a conflict unless the file is untouched', async () => {
    const file = { path: 'f', before: 'mine\n', after: null };
    await expect(planRestore(file, null)).resolves.toEqual({
      outcome: 'restored',
      content: 'mine\n',
    });
    await expect(planRestore(file, 'mine\n')).resolves.toEqual({
      outcome: 'unchanged',
      content: 'mine\n',
    });
    await expect(planRestore(file, 'other\n')).resolves.toMatchObject({ outcome: 'conflict' });
  });
});

describe('fireforge park', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      [FTL]: 'a = A\nz = Z\n',
      [MARKUP]: '<x/>\n',
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': JSON.stringify({
        version: 1,
        patches: [row('001-ui-strings.patch', 1, [FTL]), row('002-ui-peer.patch', 2, [MARKUP])],
      }),
      'patches/001-ui-strings.patch': BODY,
      'patches/002-ui-peer.patch': [
        `diff --git a/${MARKUP} b/${MARKUP}`,
        'index 1111111..2222222 100644',
        `--- a/${MARKUP}`,
        `+++ b/${MARKUP}`,
        '@@ -1 +1 @@',
        '-<x/>',
        '+<x data-l10n-id="c"/>',
        '',
      ].join('\n'),
      // This session added c; the peer's markup already uses it.
      [`engine/${FTL}`]: 'a = A\nb = B\nc = C\nz = Z\n',
      [`engine/${MARKUP}`]: '<x data-l10n-id="c"/>\n',
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('parks to the baseline, warns about a referenced id, and merges back over a commit', async () => {
    await parkCommand(projectRoot, '001', { label: 'mine' });
    await expect(readProjectText(projectRoot, `engine/${FTL}`)).resolves.toBe(
      'a = A\nb = B\nz = Z\n'
    );
    expect(lines(warn)).toContain(`Fluent id "c" (${FTL}) is still referenced by ${MARKUP}`);
    expect((await listParks(projectRoot)).map((park) => park.label)).toEqual(['mine']);

    // The owner commits a line of its own in between.
    await writeFiles(projectRoot, { [`engine/${FTL}`]: 'a = A\nb = B\nz = Z\ny = Y\n' });
    await parkCommand(projectRoot, undefined, { restore: 'mine' });
    await expect(readProjectText(projectRoot, `engine/${FTL}`)).resolves.toBe(
      'a = A\nb = B\nc = C\nz = Z\ny = Y\n'
    );
    await expect(listParks(projectRoot)).resolves.toEqual([]);
  });

  it('parks only the named hunks and keeps the park when the restore conflicts', async () => {
    await writeFiles(projectRoot, {
      'mine.diff': [
        `diff --git a/${FTL} b/${FTL}`,
        `--- a/${FTL}`,
        `+++ b/${FTL}`,
        '@@ -2,2 +2,3 @@',
        ' b = B',
        '+c = C',
        ' z = Z',
        '',
      ].join('\n'),
    });
    await parkCommand(projectRoot, '001', {
      label: 'only-c',
      hunks: join(projectRoot, 'mine.diff'),
    });
    await expect(readProjectText(projectRoot, `engine/${FTL}`)).resolves.toBe(
      'a = A\nb = B\nz = Z\n'
    );

    await writeFiles(projectRoot, { [`engine/${FTL}`]: 'a = A\nb = B\nq = Q\nz = Z\n' });
    await expect(parkCommand(projectRoot, undefined, { restore: 'only-c' })).rejects.toThrow(
      /conflict markers in browser\/locales\/shared\.ftl/
    );
    await expect(readProjectText(projectRoot, `engine/${FTL}`)).resolves.toContain('<<<<<<<');
    expect((await listParks(projectRoot)).map((park) => park.label)).toEqual(['only-c']);
    await parkCommand(projectRoot, undefined, { drop: 'only-c' });
    await expect(listParks(projectRoot)).resolves.toEqual([]);
  });

  it('previews without writing, lists, and refuses ambiguous or unknown requests', async () => {
    await parkCommand(projectRoot, '001', { dryRun: true });
    await expect(readProjectText(projectRoot, `engine/${FTL}`)).resolves.toContain('c = C');
    expect(lines(info)).toContain('[dry-run] would park 1 file(s) of 001-ui-strings.patch');
    await parkCommand(projectRoot, undefined, { list: true });
    expect(lines(info)).toContain('No parks.');
    await expect(parkCommand(projectRoot, '001', { list: true })).rejects.toThrow(/exactly one/);
    await expect(parkCommand(projectRoot, undefined, { restore: 'nope' })).rejects.toThrow(
      /No park named "nope"/
    );
    await expect(parkCommand(projectRoot, undefined, { drop: '../x' })).rejects.toThrow(
      /must be letters/
    );
    await parkCommand(projectRoot, '002', {});
    expect(lines(info)).toContain('nothing to park');
  });
});
