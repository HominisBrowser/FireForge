// SPDX-License-Identifier: EUPL-1.2
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { withDryRunPurityGuard } from '../re-export-bulk-scan.js';
import { describeForeignWriters, fingerprintScopedDryRunState } from '../re-export-purity-scope.js';

vi.mock('../../utils/logger.js', () => ({
  isVerbose: vi.fn(() => false),
  verbose: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

function row(filename: string, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order: Number.parseInt(filename.slice(0, 3), 10),
    category: 'ui',
    name: filename.slice(7, -6),
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

const SELECTED = row('001-ui-mine.patch', ['mine.txt']);
const PEER = row('002-ui-peer.patch', ['peer.txt']);

describe('scoped re-export --dry-run purity guard', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject();
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(engineDir, { 'mine.txt': 'a\n', 'peer.txt': 'b\n' });
    await writeFiles(projectRoot, {
      'patches/patches.json': JSON.stringify({ version: 1, patches: [SELECTED, PEER] }),
      'patches/001-ui-mine.patch': 'mine\n',
      'patches/002-ui-peer.patch': 'peer\n',
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  const guard = (operation: () => Promise<unknown>): Promise<unknown> =>
    withDryRunPurityGuard(engineDir, patchesDir, true, operation, { patches: [SELECTED] });

  it("ignores a peer's write to another patch, its row and its engine file", async () => {
    await expect(
      guard(() =>
        writeFiles(projectRoot, {
          'patches/002-ui-peer.patch': 'peer, rewritten\n',
          'patches/patches.json': JSON.stringify({
            version: 1,
            patches: [SELECTED, { ...PEER, description: 'renamed by a peer' }],
          }),
          'engine/peer.txt': 'b\nedited by a peer\n',
        })
      )
    ).resolves.toBeUndefined();
  });

  it('names a foreign writer the history log recorded in the window', async () => {
    await mkdir(join(projectRoot, '.fireforge'), { recursive: true });
    await expect(
      guard(async () => {
        await writeFiles(projectRoot, { 'engine/mine.txt': 'a\nchanged\n' });
        await appendFile(
          join(projectRoot, '.fireforge', 'history.jsonl'),
          `${JSON.stringify({
            ts: new Date().toISOString(),
            invocationId: 'someone-else',
            pid: 4242,
            sessionId: 'peer-lane',
            operation: 're-export',
          })}\n`
        );
      })
    ).rejects.toThrow(
      /engine\/mine\.txt changed during this dry run, written by another writer: re-export \(PID 4242, session peer-lane\)/
    );
  });

  it('still reports an unattributed change to a selected row as a possible FireForge bug', async () => {
    await expect(
      guard(() =>
        writeFiles(projectRoot, {
          'patches/patches.json': JSON.stringify({
            version: 1,
            patches: [{ ...SELECTED, description: 'touched' }, PEER],
          }),
        })
      )
    ).rejects.toThrow(
      /invariant violated: patches\.json rows of 001-ui-mine\.patch changed during this dry run.*FireForge bug/
    );
  });

  it('fingerprints absent, unparsable and record-free state without false alarms', async () => {
    const { rm, writeFile: write } = await import('node:fs/promises');
    const scope = { patches: [SELECTED] };
    const key = 'patches.json rows of 001-ui-mine.patch';
    await rm(join(patchesDir, 'patches.json'));
    await rm(join(engineDir, 'mine.txt'));
    const absent = await fingerprintScopedDryRunState(engineDir, patchesDir, scope);
    expect(absent.get(key)).toBe('absent');
    expect(absent.get('engine/mine.txt')).toBe('absent');
    await write(join(patchesDir, 'patches.json'), '{ not json');
    const first = await fingerprintScopedDryRunState(engineDir, patchesDir, scope);
    await write(join(patchesDir, 'patches.json'), '{ still not json');
    const second = await fingerprintScopedDryRunState(engineDir, patchesDir, scope);
    expect(first.get(key)).not.toBe(second.get(key));
    await write(join(patchesDir, 'patches.json'), JSON.stringify({ version: 1 }));
    await expect(
      fingerprintScopedDryRunState(engineDir, patchesDir, scope)
    ).resolves.toBeInstanceOf(Map);
  });

  it('fails closed on a non-git engine and on an unreadable owned file', async () => {
    const scope = { patches: [SELECTED] };
    await expect(
      fingerprintScopedDryRunState(join(projectRoot, 'nowhere'), patchesDir, scope)
    ).rejects.toThrow(/cannot fingerprint the engine/);
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const { chmod } = await import('node:fs/promises');
    await chmod(join(engineDir, 'mine.txt'), 0o000);
    try {
      await expect(fingerprintScopedDryRunState(engineDir, patchesDir, scope)).rejects.toThrow(
        /cannot fingerprint engine\/mine\.txt/
      );
    } finally {
      await chmod(join(engineDir, 'mine.txt'), 0o644);
    }
  });

  it('skips its own, older and malformed history lines when naming writers', async () => {
    await mkdir(join(projectRoot, '.fireforge'), { recursive: true });
    await appendFile(
      join(projectRoot, '.fireforge', 'history.jsonl'),
      [
        'not json',
        JSON.stringify({ ts: '2000-01-01T00:00:00.000Z', invocationId: 'old', operation: 'x' }),
        JSON.stringify({
          ts: new Date(Date.now() + 1000).toISOString(),
          invocationId: 'p',
          pid: 7,
          operation: 'export',
        }),
        '',
      ].join('\n')
    );
    await expect(describeForeignWriters(patchesDir, Date.now())).resolves.toEqual([
      'export (PID 7)',
    ]);
    await expect(
      describeForeignWriters(join(projectRoot, 'elsewhere', 'patches'), 0)
    ).resolves.toEqual([]);
  });
});
