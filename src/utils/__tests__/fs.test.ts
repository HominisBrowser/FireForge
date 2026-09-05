// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdtemp, readFile, rm as fsRm, stat } from 'node:fs/promises';
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

import { pathExistsStrict, removeDir, writeFileAtomic, writeTextIfChanged } from '../fs.js';

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

describe('pathExistsStrict', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'fireforge-fs-test-'));
  });

  afterEach(async () => {
    await fsRm(tempDir, { recursive: true, force: true });
  });

  it('returns false only for a missing path', async () => {
    await expect(pathExistsStrict(join(tempDir, 'missing.txt'))).resolves.toBe(false);
  });

  it('returns true for an existing path', async () => {
    const filePath = join(tempDir, 'target.txt');
    await writeFileAtomic(filePath, 'hello');

    await expect(pathExistsStrict(filePath)).resolves.toBe(true);
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

    // All writes should succeed: no ENOENT or other spurious failures
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

  // Windows has no POSIX execute bit, and chmod(0o755) is a no-op there (stat
  // reports 0o666), so the mode-preservation contract is POSIX-only.
  it.skipIf(process.platform === 'win32')(
    'preserves an existing file mode when replacing content',
    async () => {
      const filePath = join(tempDir, 'executable-target.sh');
      await writeFileAtomic(filePath, '#!/bin/sh\necho old\n');
      await chmod(filePath, 0o755);

      await writeFileAtomic(filePath, '#!/bin/sh\necho new\n');

      await expect(readFile(filePath, 'utf-8')).resolves.toBe('#!/bin/sh\necho new\n');
      expect((await stat(filePath)).mode & 0o777).toBe(0o755);
    }
  );
});

describe('writeTextIfChanged', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'fireforge-fs-test-'));
  });

  afterEach(async () => {
    await fsRm(tempDir, { recursive: true, force: true });
  });

  it('writes and returns true when file does not exist', async () => {
    const filePath = join(tempDir, 'new-file.txt');
    const result = await writeTextIfChanged(filePath, 'hello');

    expect(result).toBe(true);
    expect(await readFile(filePath, 'utf-8')).toBe('hello');
  });

  it('writes and returns true when content differs', async () => {
    const filePath = join(tempDir, 'existing.txt');
    await writeFileAtomic(filePath, 'old content');

    const result = await writeTextIfChanged(filePath, 'new content');

    expect(result).toBe(true);
    expect(await readFile(filePath, 'utf-8')).toBe('new content');
  });

  it('skips write and returns false when content matches', async () => {
    const filePath = join(tempDir, 'unchanged.txt');
    await writeFileAtomic(filePath, 'same content');
    const { mtimeMs: before } = await import('node:fs/promises').then((fs) => fs.stat(filePath));

    const result = await writeTextIfChanged(filePath, 'same content');

    expect(result).toBe(false);
    const { mtimeMs: after } = await import('node:fs/promises').then((fs) => fs.stat(filePath));
    expect(after).toBe(before);
  });
});
