// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readEngineSessionLockStatus,
  withEngineSessionLock,
} from '../../core/engine-session-lock.js';
import { withPrivateGitIndex } from '../../core/git-readonly-index.js';
import { reExportCommand } from '../re-export.js';
import { registerReExport } from '../re-export-register.js';

vi.mock('../re-export.js', () => ({ reExportCommand: vi.fn() }));
vi.mock('../re-export-preflight.js', () => ({
  preflightReExportArguments: vi.fn(),
  readPathListFile: vi.fn(),
}));
vi.mock('../../core/git-readonly-index.js', () => ({
  withPrivateGitIndex: vi.fn((_engine: string, operation: () => Promise<void>) => operation()),
}));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ff-coherent-preview-'));
  await mkdir(join(root, 'engine'));
  vi.stubEnv('FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST', '1');
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function run(...args: string[]): Promise<Command> {
  const program = new Command().exitOverride();
  registerReExport(program, {
    getProjectRoot: () => root,
    withErrorHandling: (handler) => handler,
  });
  return program.parseAsync(['node', 'fireforge', 're-export', '001', ...args]);
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('coherent legacy re-export previews', () => {
  it('holds shared engine ownership before private-index creation and through a control apply/restore attempt', async () => {
    const path = join(root, 'engine/widget.js');
    await writeFile(path, 'original');
    const entered = deferred(),
      finish = deferred();
    let controlStarted = false;
    vi.mocked(reExportCommand).mockImplementationOnce(async () => {
      expect((await readEngineSessionLockStatus(root)).sharedHolders).toBe(1);
      expect(await readFile(path, 'utf8')).toBe('original');
      entered.resolve();
      await finish.promise;
      expect(controlStarted).toBe(false);
      expect(await readFile(path, 'utf8')).toBe('original');
    });
    const preview = run('--dry-run', '--wait-lock', '5');
    await entered.promise;
    const control = withEngineSessionLock(
      root,
      'test --negative-control',
      async () => {
        controlStarted = true;
        await writeFile(path, 'mutated');
        await writeFile(path, 'original');
      },
      { waitLockSeconds: 5 }
    );
    try {
      await vi.waitFor(
        async () => {
          // An exclusive writer owns the turnstile while draining the
          // existing shared reader; its mutation body must still wait.
          expect(await readEngineSessionLockStatus(root)).toMatchObject({
            held: true,
            sharedHolders: 1,
          });
        },
        { timeout: 2000, interval: 10 }
      );
      expect(controlStarted).toBe(false);
      expect(withPrivateGitIndex).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await Promise.all([preview, control]);
    }
    expect(controlStarted).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('original');
    expect((await readEngineSessionLockStatus(root)).held).toBe(false);
  });

  it('waits for an existing control to restore before entering the private-index preview', async () => {
    const path = join(root, 'engine/widget.js');
    await writeFile(path, 'original');
    const entered = deferred(),
      restore = deferred();
    const control = withEngineSessionLock(root, 'test --negative-control', async () => {
      await writeFile(path, 'mutated');
      entered.resolve();
      await restore.promise;
      await writeFile(path, 'original');
    });
    await entered.promise;
    vi.mocked(reExportCommand).mockImplementationOnce(async () => {
      expect(await readFile(path, 'utf8')).toBe('original');
    });
    const preview = run('--dry-run', '--wait-lock', '5');
    try {
      await vi.waitFor(
        async () => {
          expect((await readEngineSessionLockStatus(root)).queueDepth).toBe(1);
        },
        { timeout: 2000, interval: 10 }
      );
      expect(withPrivateGitIndex).not.toHaveBeenCalled();
      expect(reExportCommand).not.toHaveBeenCalled();
    } finally {
      restore.resolve();
      await Promise.all([control, preview]);
    }
    expect(reExportCommand).toHaveBeenCalledOnce();
  });
});
