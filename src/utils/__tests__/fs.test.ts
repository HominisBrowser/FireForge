// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm as fsRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(),
  };
});

import { rm } from 'node:fs/promises';

import { removeDir, writeFileAtomic } from '../fs.js';

describe('removeDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries transient ENOTEMPTY failures before succeeding', async () => {
    vi.mocked(rm)
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'ENOTEMPTY' }))
      .mockResolvedValue(undefined);

    await expect(removeDir('/tmp/project')).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(2);
  });

  it('does not swallow non-retriable failures', async () => {
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));

    await expect(removeDir('/tmp/project')).rejects.toThrow('denied');
  });
});

describe('writeFileAtomic concurrency', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'fireforge-fs-test-'));
  });

  afterEach(async () => {
    await fsRm(tempDir, { recursive: true, force: true });
  });

  it('handles many simultaneous writes to the same file without ENOENT', async () => {
    const filePath = join(tempDir, 'concurrent-target.txt');
    const writerCount = 20;

    const writers = Array.from({ length: writerCount }, (_, i) =>
      writeFileAtomic(filePath, `writer-${i}\n`)
    );

    // All writes should succeed — no ENOENT or other spurious failures
    await expect(Promise.all(writers)).resolves.toBeDefined();

    // File should exist with content from one of the writers (last-writer-wins)
    const content = await readFile(filePath, 'utf-8');
    expect(content).toMatch(/^writer-\d+\n$/);
  });

  it('preserves atomic semantics for a single writer', async () => {
    const filePath = join(tempDir, 'single-target.txt');
    await writeFileAtomic(filePath, 'hello world');

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });
});
