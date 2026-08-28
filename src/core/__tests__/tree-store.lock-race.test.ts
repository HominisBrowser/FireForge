// SPDX-License-Identifier: EUPL-1.2
/**
 * Pins the lock-inspection race in `removeTree`: a lock cleanly released
 * between the existence probe and the owner-record read is a RELEASE, not an
 * unreadable owner. Classifying it `unknown` made `tree remove` refuse and
 * demand `--force` for a lock that no longer exists — a spurious refusal the
 * real-filesystem integration suite cannot reproduce deterministically, hence
 * the mocked interleaving here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';
import { removeTree } from '../tree-store.js';

const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: readFileMock,
  rm: rmMock,
}));

vi.mock('../../utils/fs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/fs.js')>()),
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

describe('removeTree lock-release race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    );
  });

  it('treats a lock directory that vanished before the owner read as released, not unknown', async () => {
    // Build lock: present at the probe, gone by the time the pid file is read.
    // Engine-session lock: already gone at the probe.
    existsSyncMock
      .mockReturnValueOnce(true) // build lock: initial probe
      .mockReturnValueOnce(false) // build lock: re-check inside the read catch
      .mockReturnValueOnce(false); // engine-session lock: initial probe

    await expect(removeTree('/primary', 'shard-a')).resolves.toBeUndefined();

    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith(
      expect.stringContaining('shard-a'),
      expect.objectContaining({ recursive: true })
    );
  });

  it('still refuses without --force when the lock directory persists with an unreadable owner', async () => {
    existsSyncMock.mockReturnValue(true);

    await expect(removeTree('/primary', 'shard-a')).rejects.toThrow(/--force/);
    expect(rmMock).not.toHaveBeenCalled();
  });

  // The containment guard compares a prefix built with `join` against a root
  // built with `resolve`. Any input where the two forms differ — a relative
  // primary root here, a drive-less path on Windows — made the guard reject
  // every tree as an escape. Both sides are resolved now.
  it('does not mistake a resolvable primary root for a containment escape', async () => {
    existsSyncMock.mockReturnValue(false);

    await expect(removeTree('relative-primary', 'shard-a')).resolves.toBeUndefined();
    expect(rmMock).toHaveBeenCalledWith(
      expect.stringContaining('shard-a'),
      expect.objectContaining({ recursive: true })
    );
  });
});
