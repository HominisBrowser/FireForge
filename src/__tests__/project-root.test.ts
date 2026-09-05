// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProjectRoot } from '../cli.js';
import { ConfigNotFoundError } from '../errors/config.js';

describe('getProjectRoot', () => {
  const cwdSpy = vi.spyOn(process, 'cwd');
  const tempDirs: string[] = [];

  afterEach(async () => {
    cwdSpy.mockReset();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns the nearest ancestor containing fireforge.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fireforge-root-'));
    tempDirs.push(root);
    const nested = join(root, 'engine', 'browser', 'modules');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'fireforge.json'), '{}\n', 'utf8');
    cwdSpy.mockReturnValue(nested);

    expect(getProjectRoot()).toBe(root);
  });

  it('throws a ConfigNotFoundError when no fireforge.json exists in any ancestor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fireforge-nonroot-'));
    tempDirs.push(cwd);
    cwdSpy.mockReturnValue(cwd);

    // The throw is a user-facing `ConfigNotFoundError` (exit code CONFIG_ERROR)
    // rather than a plain `Error`, so `withErrorHandling` prints the nicely
    // formatted `userMessage` without the stack dump that a bare Error would
    // trigger. Verifying the type (not just the message) pins the contract
    // so a future refactor can't silently regress back to a stack-dump exit.
    expect(() => getProjectRoot()).toThrow(ConfigNotFoundError);
    expect(() => getProjectRoot()).toThrow(/Configuration file not found: fireforge\.json/);
  });
});
