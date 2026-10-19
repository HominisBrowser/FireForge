// SPDX-License-Identifier: EUPL-1.2
/**
 * The patch history log moved out of the tracked patch queue: it was
 * committed with every export and grew to tens of megabytes. These tests pin
 * the new location, the configurable path, the migration of a legacy log
 * (no record lost, whichever files exist), and the per-invocation identity
 * that lets a session pick out its own lines.
 */
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});
vi.mock('../../utils/logger.js', () => createLoggerMock());

import { info } from '../../utils/logger.js';
import { appendHistory } from '../destructive.js';
import {
  appendHistoryLine,
  DEFAULT_HISTORY_LOG_PATH,
  HISTORY_SESSION_ENV,
  historyRecordIdentity,
  LEGACY_HISTORY_LOG_FILENAME,
  migrateLegacyHistoryLog,
  resolveHistoryLogPath,
} from '../history-log-file.js';

let projectRoot: string;
let patchesDir: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'ff-history-log-'));
  patchesDir = join(projectRoot, 'patches');
  await mkdir(patchesDir);
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path, 'utf-8');
  return content
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeConfig(history: unknown): Promise<void> {
  await writeFile(
    join(projectRoot, 'fireforge.json'),
    JSON.stringify({ name: 'X', history }),
    'utf-8'
  );
}

describe('resolveHistoryLogPath', () => {
  it('defaults to .fireforge/history.jsonl, outside the patch queue', async () => {
    await expect(resolveHistoryLogPath(projectRoot)).resolves.toBe(
      join(projectRoot, '.fireforge', 'history.jsonl')
    );
  });

  it('honours fireforge.json#history.path', async () => {
    await writeConfig({ path: 'logs/patch-history.jsonl' });
    await expect(resolveHistoryLogPath(projectRoot)).resolves.toBe(
      join(projectRoot, 'logs', 'patch-history.jsonl')
    );
  });

  it.each([
    ['an escaping path', { path: '../outside.jsonl' }],
    ['an absolute path', { path: '/tmp/history.jsonl' }],
    ['a non-string path', { path: 42 }],
    ['a non-object block', 'logs/history.jsonl'],
  ])('falls back to the default on %s', async (_label, history) => {
    await writeConfig(history);
    await expect(resolveHistoryLogPath(projectRoot)).resolves.toBe(
      join(projectRoot, DEFAULT_HISTORY_LOG_PATH)
    );
  });

  it('falls back to the default when fireforge.json is not JSON', async () => {
    await writeFile(join(projectRoot, 'fireforge.json'), '{ nope', 'utf-8');
    await expect(resolveHistoryLogPath(projectRoot)).resolves.toBe(
      join(projectRoot, DEFAULT_HISTORY_LOG_PATH)
    );
  });

  it('falls back to the default when fireforge.json is not an object', async () => {
    await writeFile(join(projectRoot, 'fireforge.json'), 'null', 'utf-8');
    await expect(resolveHistoryLogPath(projectRoot)).resolves.toBe(
      join(projectRoot, DEFAULT_HISTORY_LOG_PATH)
    );
  });
});

describe('historyRecordIdentity', () => {
  it('carries one invocation id per process, plus pid and ppid', () => {
    const first = historyRecordIdentity();
    const second = historyRecordIdentity();
    expect(first.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.invocationId).toBe(first.invocationId);
    expect(first.pid).toBe(process.pid);
    expect(first.ppid).toBe(process.ppid);
  });

  it('adds the session id from FIREFORGE_SESSION_ID only when set', () => {
    vi.stubEnv(HISTORY_SESSION_ENV, '');
    expect(historyRecordIdentity()).not.toHaveProperty('sessionId');
    vi.stubEnv(HISTORY_SESSION_ENV, '  lane-7  ');
    expect(historyRecordIdentity().sessionId).toBe('lane-7');
  });
});

describe('appendHistory', () => {
  it('stamps the session and invocation on every record', async () => {
    vi.stubEnv(HISTORY_SESSION_ENV, 'lane-42');
    await appendHistory(patchesDir, { operation: 'patch-tier', args: {}, result: 'ok' });

    const [record] = await readLines(join(projectRoot, DEFAULT_HISTORY_LOG_PATH));
    expect(record).toMatchObject({
      sessionId: 'lane-42',
      pid: process.pid,
      operation: 'patch-tier',
      result: 'ok',
    });
    expect(record?.['invocationId']).toEqual(expect.any(String));
    // Nothing is written into the tracked queue any more.
    expect(await readdir(patchesDir)).toEqual([]);
  });

  it('writes to the configured history.path', async () => {
    await writeConfig({ path: 'audit/history.jsonl' });
    await appendHistoryLine(patchesDir, '{"op":"x"}');
    await expect(readLines(join(projectRoot, 'audit', 'history.jsonl'))).resolves.toEqual([
      { op: 'x' },
    ]);
  });
});

describe('migrateLegacyHistoryLog', () => {
  const legacyRecords = '{"op":"old-1"}\n{"op":"old-2"}\n';

  it('moves a legacy log on first run, keeping every record', async () => {
    await writeFile(join(patchesDir, LEGACY_HISTORY_LOG_FILENAME), legacyRecords, 'utf-8');

    await appendHistoryLine(patchesDir, '{"op":"new"}');

    await expect(readLines(join(projectRoot, DEFAULT_HISTORY_LOG_PATH))).resolves.toEqual([
      { op: 'old-1' },
      { op: 'old-2' },
      { op: 'new' },
    ]);
    // Nothing left behind in patches/, not even the claimed copy.
    expect(await readdir(patchesDir)).toEqual([]);
    expect(vi.mocked(info)).toHaveBeenCalledWith(expect.stringContaining('Nothing reads it back'));
  });

  it('merges instead of overwriting when both logs exist', async () => {
    await mkdir(join(projectRoot, '.fireforge'));
    await writeFile(join(projectRoot, DEFAULT_HISTORY_LOG_PATH), '{"op":"current"}\n', 'utf-8');
    await writeFile(join(patchesDir, LEGACY_HISTORY_LOG_FILENAME), legacyRecords, 'utf-8');

    await appendHistoryLine(patchesDir, '{"op":"new"}');

    const ops = (await readLines(join(projectRoot, DEFAULT_HISTORY_LOG_PATH))).map((r) => r['op']);
    expect(ops).toEqual(['current', 'old-1', 'old-2', 'new']);
    expect(await readdir(patchesDir)).toEqual([]);
  });

  it('falls back to copying when the filesystem refuses a hard link', async () => {
    vi.mocked(link).mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })
    );
    await writeFile(join(patchesDir, LEGACY_HISTORY_LOG_FILENAME), legacyRecords, 'utf-8');

    await appendHistoryLine(patchesDir, '{"op":"new"}');

    const ops = (await readLines(join(projectRoot, DEFAULT_HISTORY_LOG_PATH))).map((r) => r['op']);
    expect(ops).toEqual(['old-1', 'old-2', 'new']);
  });

  it('stands down when a concurrent claimant ends up holding the claimed file', async () => {
    // Windows can report both racing renames as successful; the file then
    // sits under the other claimant's name and this link finds nothing.
    const stolen = join(patchesDir, 'other-claimant');
    vi.mocked(link).mockImplementationOnce(async (claimed) => {
      await rename(claimed, stolen);
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
    await writeFile(join(patchesDir, LEGACY_HISTORY_LOG_FILENAME), legacyRecords, 'utf-8');
    const target = join(projectRoot, DEFAULT_HISTORY_LOG_PATH);

    await expect(migrateLegacyHistoryLog(patchesDir, target)).resolves.toBeUndefined();

    expect(await readFile(stolen, 'utf-8')).toBe(legacyRecords);
    await expect(readFile(target, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.mocked(info)).not.toHaveBeenCalled();
  });

  it('is a no-op when history.path still names the legacy file', async () => {
    await writeConfig({ path: `patches/${LEGACY_HISTORY_LOG_FILENAME}` });
    await writeFile(join(patchesDir, LEGACY_HISTORY_LOG_FILENAME), legacyRecords, 'utf-8');

    await appendHistoryLine(patchesDir, '{"op":"new"}');

    const ops = (await readLines(join(patchesDir, LEGACY_HISTORY_LOG_FILENAME))).map(
      (r) => r['op']
    );
    expect(ops).toEqual(['old-1', 'old-2', 'new']);
    expect(vi.mocked(info)).not.toHaveBeenCalled();
  });

  it('does nothing when there is no legacy log', async () => {
    const target = join(projectRoot, DEFAULT_HISTORY_LOG_PATH);
    await migrateLegacyHistoryLog(patchesDir, target);
    expect(await readdir(projectRoot)).toEqual(['patches']);
  });

  it('migrates exactly once when two commands race for the same legacy log', async () => {
    await writeFile(join(patchesDir, LEGACY_HISTORY_LOG_FILENAME), legacyRecords, 'utf-8');
    const target = join(projectRoot, DEFAULT_HISTORY_LOG_PATH);

    await Promise.all([
      migrateLegacyHistoryLog(patchesDir, target),
      migrateLegacyHistoryLog(patchesDir, target),
    ]);

    // No duplicated records: the loser of the claim found nothing to move.
    const ops = (await readLines(target)).map((r) => r['op']);
    expect(ops).toEqual(['old-1', 'old-2']);
  });
});
