// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../file-lock.js', () => ({
  createSiblingLockPath: vi.fn((statePath: string, suffix: string) => `${statePath}.dir/${suffix}`),
  withFileLock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  rename: vi.fn(),
}));

import { rename } from 'node:fs/promises';

import { pathExists } from '../../utils/fs.js';
import { createSiblingLockPath, withFileLock } from '../file-lock.js';
import { quarantineStateFile, withStateFileLock } from '../state-file.js';

const mockPathExists = vi.mocked(pathExists);
const mockWithFileLock = vi.mocked(withFileLock);
const mockRename = vi.mocked(rename);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('withStateFileLock', () => {
  it('delegates to withFileLock with correct lock path', async () => {
    mockWithFileLock.mockImplementation((_lockPath, operation) =>
      (operation as () => Promise<string>)()
    );

    const result = await withStateFileLock('/project/.fireforge/state.json', () =>
      Promise.resolve('done')
    );

    expect(createSiblingLockPath).toHaveBeenCalledWith(
      '/project/.fireforge/state.json',
      '.fireforge-state.lock'
    );
    expect(result).toBe('done');
  });

  it('passes onTimeoutMessage containing the state path', async () => {
    mockWithFileLock.mockImplementation((_lockPath, operation) =>
      (operation as () => Promise<string>)()
    );

    await withStateFileLock('/project/.fireforge/state.json', () => Promise.resolve('ok'));

    const options = mockWithFileLock.mock.calls[0]?.[2] as { onTimeoutMessage: string } | undefined;
    expect(options?.onTimeoutMessage).toContain('/project/.fireforge/state.json');
    expect(options?.onTimeoutMessage).toContain('stale lock directory');
  });

  it('onStaleLockMessage callback formats age correctly', async () => {
    mockWithFileLock.mockImplementation((_lockPath, operation) =>
      (operation as () => Promise<string>)()
    );

    await withStateFileLock('/project/.fireforge/state.json', () => Promise.resolve('ok'));

    const options = mockWithFileLock.mock.calls[0]?.[2] as
      | { onStaleLockMessage: (ageMs: number) => string }
      | undefined;
    const message = options?.onStaleLockMessage(60000);
    expect(message).toContain('Removing stale FireForge state lock');
    expect(message).toContain('state.json');
    expect(message).toContain('60s');
  });
});

describe('quarantineStateFile', () => {
  it('returns undefined when file does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    const result = await quarantineStateFile('/project/.fireforge/state.json');

    expect(result).toBeUndefined();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('renames file with corrupt-timestamp suffix and returns basename', async () => {
    mockPathExists.mockResolvedValue(true);
    mockRename.mockResolvedValue(undefined);

    const result = await quarantineStateFile('/project/.fireforge/state.json');

    expect(mockRename).toHaveBeenCalledTimes(1);
    const renamedPath = mockRename.mock.calls[0]?.[1] as string | undefined;
    expect(renamedPath).toMatch(/state\.json\.corrupt-\d{4}-\d{2}-\d{2}T/);
    expect(result).toBe(renamedPath?.split('/').pop());
  });

  it('uses custom reason in quarantined filename', async () => {
    mockPathExists.mockResolvedValue(true);
    mockRename.mockResolvedValue(undefined);

    await quarantineStateFile('/project/.fireforge/state.json', 'migration-failed');

    const renamedPath = mockRename.mock.calls[0]?.[1] as string | undefined;
    expect(renamedPath).toContain('migration-failed');
  });
});
