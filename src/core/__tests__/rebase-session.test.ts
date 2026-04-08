// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RebaseSession } from '../rebase-session.js';
import {
  clearRebaseSession,
  hasActiveRebaseSession,
  loadRebaseSession,
  saveRebaseSession,
} from '../rebase-session.js';

// Override getProjectPaths to point at the tmp directory from each test
vi.mock('../config-paths.js', () => ({
  getProjectPaths: (root: string) => ({
    root,
    fireforgeDir: join(root, '.fireforge'),
    config: join(root, 'fireforge.json'),
    state: join(root, '.fireforge', 'state.json'),
    engine: join(root, 'engine'),
    patches: join(root, 'patches'),
    configs: join(root, 'configs'),
    src: join(root, 'src'),
    componentsDir: join(root, 'src', 'components'),
  }),
}));

function makeSession(overrides: Partial<RebaseSession> = {}): RebaseSession {
  return {
    startedAt: '2026-01-01T00:00:00Z',
    fromVersion: '128.0esr',
    toVersion: '140.0esr',
    preRebaseCommit: 'abc123',
    patches: [
      { filename: '001-branding.patch', status: 'pending' },
      { filename: '002-ui.patch', status: 'pending' },
    ],
    currentIndex: 0,
    ...overrides,
  };
}

describe('rebase-session', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'forge-rebase-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmpRoot, '.fireforge'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns null when no session exists', async () => {
    expect(await loadRebaseSession(tmpRoot)).toBeNull();
  });

  it('round-trips a session through save and load', async () => {
    const session = makeSession();
    await saveRebaseSession(tmpRoot, session);
    const loaded = await loadRebaseSession(tmpRoot);
    expect(loaded).toEqual(session);
  });

  it('detects active session', async () => {
    expect(await hasActiveRebaseSession(tmpRoot)).toBe(false);
    await saveRebaseSession(tmpRoot, makeSession());
    expect(await hasActiveRebaseSession(tmpRoot)).toBe(true);
  });

  it('clears session', async () => {
    await saveRebaseSession(tmpRoot, makeSession());
    await clearRebaseSession(tmpRoot);
    expect(await loadRebaseSession(tmpRoot)).toBeNull();
    expect(await hasActiveRebaseSession(tmpRoot)).toBe(false);
  });

  it('clearRebaseSession is a no-op when no session exists', async () => {
    // Should not throw
    await clearRebaseSession(tmpRoot);
    expect(await hasActiveRebaseSession(tmpRoot)).toBe(false);
  });
});
