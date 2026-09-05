// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeActiveRunLog,
  getActiveRunLogPath,
  getRunLogDir,
  openRunLog,
  setActiveRunLog,
  teeToRunLog,
  writeToActiveRunLog,
} from '../run-log.js';

describe('run-log', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-run-log-'));
  });

  afterEach(async () => {
    await closeActiveRunLog();
    await rm(root, { recursive: true, force: true });
  });

  it('writes the run output to .fireforge/logs and reports its path', async () => {
    const log = await openRunLog(root, 'test');
    expect(log).toBeDefined();
    expect(log?.path.startsWith(getRunLogDir(root))).toBe(true);

    log?.write('TEST-UNEXPECTED-FAIL | a.js | boom\n');
    await log?.close();

    expect(await readFile(log?.path ?? '', 'utf-8')).toContain('TEST-UNEXPECTED-FAIL');
  });

  it('names the file for the command so retention cannot cross kinds', async () => {
    const test = await openRunLog(root, 'test');
    const build = await openRunLog(root, 'build');
    await test?.close();
    await build?.close();

    const names = await readdir(getRunLogDir(root));
    expect(names.some((n) => n.startsWith('test-'))).toBe(true);
    expect(names.some((n) => n.startsWith('build-'))).toBe(true);
  });

  it('uses a filename with no colons, so the path is portable', async () => {
    const log = await openRunLog(root, 'test', new Date('2026-08-28T14:32:05.123Z'));
    await log?.close();
    const names = await readdir(getRunLogDir(root));
    expect(names[0]).toBe('test-2026-08-28T14-32-05-123Z.log');
    expect(names[0]).not.toContain(':');
  });

  it('prunes older logs of the same kind but never the other kind', async () => {
    const dir = getRunLogDir(root);
    const log = await openRunLog(root, 'test');
    await log?.close();
    // 25 stale `test` logs plus one `build` log that must survive.
    for (let i = 0; i < 25; i++) {
      await writeFile(
        join(dir, `test-2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z.log`),
        ''
      );
    }
    await writeFile(join(dir, 'build-2020-01-01T00-00-00-000Z.log'), '');

    const second = await openRunLog(root, 'test');
    await second?.close();

    const names = await readdir(dir);
    expect(names.filter((n) => n.startsWith('test-'))).toHaveLength(20);
    expect(names.filter((n) => n.startsWith('build-'))).toHaveLength(1);
    // The newest is always kept.
    expect(names).toContain(second?.path.split(/[/\\]/).pop());
  });

  it('degrades to no log rather than failing the run when the path is unusable', async () => {
    // A file where the logs directory should be: mkdir fails, and the run
    // must proceed with no log rather than dying over a diagnostic.
    await writeFile(join(root, '.fireforge'), 'not a directory');
    expect(await openRunLog(root, 'test')).toBeUndefined();
  });

  it('routes the ambient sink and clears it on close', async () => {
    const log = await openRunLog(root, 'test');
    setActiveRunLog(log);
    expect(getActiveRunLogPath()).toBe(log?.path);

    writeToActiveRunLog('through the ambient sink\n');
    const path = log?.path ?? '';
    await closeActiveRunLog();

    expect(getActiveRunLogPath()).toBeUndefined();
    expect(await readFile(path, 'utf-8')).toContain('through the ambient sink');
  });

  it('writing with no active log is a no-op, not a throw', () => {
    setActiveRunLog(undefined);
    expect(() => {
      writeToActiveRunLog('dropped');
    }).not.toThrow();
  });

  it('redacts secret-shaped values in the file but never in the mirrored terminal stream', async () => {
    const log = await openRunLog(root, 'build');
    setActiveRunLog(log);
    const seen: string[] = [];
    const base = {
      write: (chunk: string): boolean => {
        seen.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const tee = teeToRunLog(base);
    tee.write('env GITHUB_TOKEN=ghp_live MOZ_OBJDIR=obj-x\n');
    tee.write('> Authorization: Bearer abc.def\n');
    const path = log?.path ?? '';
    await closeActiveRunLog();

    // Terminal: untouched.
    expect(seen.join('')).toContain('GITHUB_TOKEN=ghp_live');
    expect(seen.join('')).toContain('Bearer abc.def');
    // File: masked, everything else preserved.
    const written = await readFile(path, 'utf-8');
    expect(written).toContain('GITHUB_TOKEN=<redacted> MOZ_OBJDIR=obj-x');
    expect(written).toContain('Authorization: Bearer <redacted>');
    expect(written).not.toContain('ghp_live');
    expect(written).not.toContain('abc.def');
  });

  it('redacts an assignment split across chunk boundaries and flushes the tail on close', async () => {
    const log = await openRunLog(root, 'test');
    log?.write('API_K');
    log?.write('EY=split-secret rest\nunterminated TOKEN=tail');
    const path = log?.path ?? '';
    await log?.close();

    const written = await readFile(path, 'utf-8');
    expect(written).toBe('API_KEY=<redacted> rest\nunterminated TOKEN=<redacted>');
  });

  it('treats a lone carriage return as a line end and holds a trailing one for \\r\\n', async () => {
    const log = await openRunLog(root, 'build');
    // Progress-bar repaints: TOKEN=a is complete at the first \r and must be
    // masked even though no newline ever arrives for it.
    log?.write('TOKEN=a\rTOKEN=b\r');
    log?.write('\nTOKEN=c');
    const path = log?.path ?? '';
    await log?.close();

    expect(await readFile(path, 'utf-8')).toBe(
      'TOKEN=<redacted>\rTOKEN=<redacted>\r\nTOKEN=<redacted>'
    );
  });

  it('flushes an oversized unterminated line instead of buffering it indefinitely', async () => {
    const log = await openRunLog(root, 'build');
    const half = 'x'.repeat(600 * 1024);
    log?.write(half);
    log?.write(half);
    const path = log?.path ?? '';
    // Not closed yet: the tail has crossed the cap and must already be on
    // its way to disk.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await readFile(path, 'utf-8')).length).toBe(2 * half.length);
    await log?.close();
  });

  it('tees mirrored output to both the base stream and the log', async () => {
    const log = await openRunLog(root, 'build');
    setActiveRunLog(log);
    const seen: string[] = [];
    const base = {
      write: (chunk: string): boolean => {
        seen.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const tee = teeToRunLog(base);
    tee.write('mach build output\n');
    const path = log?.path ?? '';
    await closeActiveRunLog();

    expect(seen.join('')).toContain('mach build output');
    expect(await readFile(path, 'utf-8')).toContain('mach build output');
  });
});
