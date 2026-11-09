// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sourceGit } from '../../core/authored/git.js';
import { findExecutable } from '../../utils/process.js';
import { capturedChanges, defaultInputWatcher, type InputWatch } from '../job-watch-inputs.js';

vi.mock('../../utils/process.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/process.js')>();
  return { ...original, findExecutable: vi.fn(original.findExecutable) };
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fireforge-watch-inputs-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function project(): Promise<void> {
  await sourceGit(root, ['init', '-q']);
  await writeFile(join(root, '.gitignore'), '*.log\nsrc/gen/\n');
  await mkdir(join(root, 'src', 'gen'), { recursive: true });
  await writeFile(join(root, 'fireforge.json'), '{}\n');
}

describe('capturedChanges', () => {
  it('keeps what a capture reads and drops temporaries, ignored files and paths outside it', async () => {
    await project();
    const changes = await capturedChanges(
      root,
      ['src', 'fireforge.json', 'configs'],
      ['src/gen/kept.txt'],
      [
        'src/a.js',
        'src/a.js',
        'src/trace.log',
        'src/gen/kept.txt',
        'src/gen/other.txt',
        'src/.a.js.swp',
        'src/a.js~',
        'src/.#a.js',
        'src/4913',
        'src/a.js___jb_tmp___',
        'src/.git/index',
        'README.md',
        'srcs/b.js',
        'fireforge.json',
      ]
    );
    expect(changes).toEqual(['src/a.js', 'src/gen/kept.txt', 'fireforge.json']);
  });

  it('returns nothing without asking Git when no path is in the selection', async () => {
    expect(await capturedChanges(join(root, 'missing'), ['src'], [], ['README.md'])).toEqual([]);
  });

  it('keeps every candidate when Git cannot say what it ignores', async () => {
    expect(await capturedChanges(root, ['src'], [], ['src/a.js', 'src/b.log'])).toEqual([
      'src/a.js',
      'src/b.log',
    ]);
  });
});

/** Collects what a watch reports, so a test can wait for a path. */
function collector(): {
  seen: Set<string>;
  errors: Error[];
  onChange: (paths: readonly string[]) => void;
  onError: (error: Error) => void;
  until: (path: string) => Promise<void>;
} {
  const seen = new Set<string>();
  const errors: Error[] = [];
  return {
    seen,
    errors,
    onChange: (paths) => {
      for (const path of paths) seen.add(path);
    },
    onError: (error) => errors.push(error),
    until: async (path) => {
      for (let waited = 0; !seen.has(path); waited += 25) {
        if (waited > 15_000) throw new Error(`Never saw ${path}: ${[...seen].join(', ')}`);
        await new Promise((settle) => setTimeout(settle, 25));
      }
    },
  };
}

const pause = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

/** Edits a selection's directory, a top-level file and a directory that appears later. */
async function exercise(watch: InputWatch, seen: ReturnType<typeof collector>): Promise<void> {
  try {
    await pause(200);
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    await writeFile(join(root, 'src', 'deep', 'a.js'), 'a');
    await seen.until('src/deep/a.js');
    await writeFile(join(root, 'fireforge.json'), '{"edited":true}\n');
    await seen.until('fireforge.json');
    await mkdir(join(root, 'components'));
    await seen.until('components');
    // The new directory's watch is armed asynchronously: write until it reports.
    for (let attempt = 0; !seen.seen.has('components/b.css'); attempt += 1) {
      if (attempt > 60) throw new Error(`Never saw components/b.css: ${[...seen.seen].join(', ')}`);
      await writeFile(join(root, 'components', 'b.css'), String(attempt));
      await pause(250);
    }
    expect([...seen.seen].some((path) => path.startsWith('engine'))).toBe(false);
  } finally {
    watch.close();
  }
}

describe('defaultInputWatcher', () => {
  it('falls back to fs.watch and reports the selection, nothing else', async () => {
    vi.mocked(findExecutable).mockResolvedValueOnce(undefined);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'engine'), { recursive: true });
    await writeFile(join(root, 'fireforge.json'), '{}\n');
    const seen = collector();
    const watch = await defaultInputWatcher({
      projectRoot: root,
      selection: ['src', 'fireforge.json', 'components', 'missing/deeper'],
      onChange: seen.onChange,
      onError: seen.onError,
    });
    expect(watch.backend).toBe('fs.watch (no watchman on PATH)');
    await writeFile(join(root, 'engine', 'ignored.txt'), 'x');
    await exercise(watch, seen);
    expect(seen.errors).toEqual([]);
  });

  it('falls back to fs.watch when watchman does not answer', async () => {
    const broken = join(root, 'watchman');
    await writeFile(broken, '#!/bin/sh\necho broken >&2\nexit 3\n', { mode: 0o755 });
    vi.mocked(findExecutable).mockResolvedValueOnce(broken);
    await mkdir(join(root, 'src'), { recursive: true });
    const watch = await defaultInputWatcher({
      projectRoot: root,
      selection: ['src'],
      onChange: () => undefined,
      onError: () => undefined,
    });
    watch.close();
    expect(watch.backend).toBe('fs.watch (watchman did not answer: broken)');
  });

  it.skipIf(process.platform === 'win32')(
    'uses watchman when it answers',
    async () => {
      const binary = await findExecutable('watchman');
      if (binary === undefined) return;
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'fireforge.json'), '{}\n');
      const seen = collector();
      const watch = await defaultInputWatcher({
        projectRoot: root,
        selection: ['src', 'fireforge.json', 'components'],
        onChange: seen.onChange,
        onError: seen.onError,
      });
      try {
        expect(watch.backend).toBe(`watchman (${binary})`);
        await exercise(watch, seen);
        expect(seen.errors).toEqual([]);
      } finally {
        for (const directory of ['src', 'components'])
          try {
            execFileSync(binary, ['watch-del', join(root, directory)], { stdio: 'ignore' });
          } catch {
            // Not watched, or already gone.
          }
      }
    },
    30_000
  );
});
