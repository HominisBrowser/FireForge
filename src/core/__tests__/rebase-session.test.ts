// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RebaseSession } from '../rebase-session.js';
import {
  getRebaseSessionPath,
  readRebaseSession,
  saveRebaseSession,
  tryReadRebaseSession,
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
    toVersion: '140.9.0esr',
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
    expect(await tryReadRebaseSession(tmpRoot)).toBeNull();
  });

  it('round-trips a session through save and load', async () => {
    const session = makeSession();
    await saveRebaseSession(tmpRoot, session);
    const loaded = await tryReadRebaseSession(tmpRoot);
    expect(loaded).toEqual(session);
  });
});

describe('readRebaseSession — absent vs corrupt', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'forge-rebase-bad-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmpRoot, '.fireforge'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function plant(contents: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(getRebaseSessionPath(tmpRoot), contents, 'utf-8');
  }

  it('reports an absent file as not present', async () => {
    await expect(readRebaseSession(tmpRoot)).resolves.toEqual({ present: false });
  });

  it('reports a valid file as present and valid', async () => {
    await saveRebaseSession(tmpRoot, makeSession());
    const read = await readRebaseSession(tmpRoot);
    expect(read).toMatchObject({ present: true, valid: true });
  });

  it('rejects sessions whose fields are the right TYPE but not a usable value', async () => {
    // The previous predicate checked six `typeof`s and nothing else. Each of
    // these passed it and reached the resume path, which acts on the values.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['empty toVersion (stamped verbatim onto every override baseVersion)', { toVersion: '' }],
      ['non-version toVersion', { toVersion: 'latest' }],
      ['non-version fromVersion', { fromVersion: 'whatever' }],
      [
        'NaN currentIndex (resume loop runs zero iterations, reports success)',
        { currentIndex: NaN },
      ],
      ['negative currentIndex (indexes out of range on --continue)', { currentIndex: -1 }],
      ['currentIndex past the end of patches', { currentIndex: 999 }],
      ['fractional currentIndex', { currentIndex: 1.5 }],
      ['null patch entry (patch-loop reads .filename off it)', { patches: [null] }],
      ['patch entry without a filename', { patches: [{ status: 'pending' }] }],
      [
        'patch entry with an unknown status',
        { patches: [{ filename: 'a.patch', status: 'weird' }] },
      ],
      ['unknown fromProduct', { fromProduct: 'chrome' }],
      ['unknown toProduct', { toProduct: 'safari' }],
      ['unparseable startedAt', { startedAt: 'not a date' }],
      ['preRebaseCommit that is not a hex sha', { preRebaseCommit: 'HEAD~1' }],
    ];

    for (const [label, overrides] of cases) {
      await plant(JSON.stringify({ ...makeSession(), ...overrides }));
      expect(await readRebaseSession(tmpRoot), label).toMatchObject({
        present: true,
        valid: false,
      });
    }
  });

  it('accepts the legal edge cases the tightened predicate must not reject', async () => {
    // currentIndex may sit one past the last entry once every patch is done,
    // and both products are optional.
    await plant(JSON.stringify({ ...makeSession(), currentIndex: 2 }));
    expect(await readRebaseSession(tmpRoot)).toMatchObject({ present: true, valid: true });

    await plant(
      JSON.stringify({
        ...makeSession(),
        fromProduct: 'firefox-esr',
        toProduct: 'firefox',
        patches: [
          {
            filename: '001-branding.patch',
            status: 'applied-fuzz',
            fuzzFactor: 2,
            conflictingFiles: ['a.cpp'],
          },
          { filename: '002-ui.patch', status: 'failed', error: 'hunk #1 failed' },
        ],
      })
    );
    expect(await readRebaseSession(tmpRoot)).toMatchObject({ present: true, valid: true });
  });

  it('does not throw a raw SyntaxError for unparseable JSON', async () => {
    // `readJson` calls JSON.parse with no guard, so a half-written file used
    // to surface a SyntaxError out of --continue/--abort.
    await plant('{ "startedAt": "x", ');

    const read = await readRebaseSession(tmpRoot);
    expect(read).toMatchObject({ present: true, valid: false });
    if (read.present && !read.valid) {
      expect(read.reason).toBeTruthy();
    }
  });

  it('keeps tryReadRebaseSession null for both unusable shapes', async () => {
    await plant('not json at all');
    expect(await tryReadRebaseSession(tmpRoot)).toBeNull();
    await plant(JSON.stringify({ nope: true }));
    expect(await tryReadRebaseSession(tmpRoot)).toBeNull();
  });

  it('names the session file so an operator can always find it', () => {
    expect(getRebaseSessionPath(tmpRoot)).toBe(join(tmpRoot, '.fireforge', 'rebase-session.json'));
  });

  it('reports a missing .fireforge directory as absent from the single read (no pre-probe)', async () => {
    // ENOTDIR/ENOENT from the read itself must mean absent: the old
    // pathExists-then-read pair misreported a file deleted between the two
    // calls as corrupt, and liveness must come from one read only.
    await rm(join(tmpRoot, '.fireforge'), { recursive: true, force: true });
    await expect(readRebaseSession(tmpRoot)).resolves.toEqual({ present: false });

    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tmpRoot, '.fireforge'), 'a file, not a directory\n');
    await expect(readRebaseSession(tmpRoot)).resolves.toEqual({ present: false });
  });

  it('reports an unreadable session directory as corrupt, not absent', async () => {
    // EACCES is "we cannot tell", which must never read as "no session":
    // the same fail-closed rule readTreeMarker applies to tree markers.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    await saveRebaseSession(tmpRoot, makeSession());
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tmpRoot, '.fireforge'), 0o000);
    try {
      const read = await readRebaseSession(tmpRoot);
      expect(read).toMatchObject({ present: true, valid: false });
    } finally {
      await chmod(join(tmpRoot, '.fireforge'), 0o755);
    }
  });

  describe('on-disk compatibility', () => {
    it('loads a 0.43.x session whose resolved entry still carries failure payload', async () => {
      // `rebase --continue` can flip `status` to 'resolved' without clearing
      // the failure's `error`/`conflictingFiles`, and persist that. The
      // session file carries no schema version, so a validator tightened to
      // match the new union would REFUSE such a file mid-rebase, where the
      // only remedies discard the operator's conflict resolution. It is
      // normalized on read instead.
      const legacy = {
        startedAt: new Date().toISOString(),
        fromVersion: '140.9.0esr',
        toVersion: '141.0',
        preRebaseCommit: 'a'.repeat(40),
        currentIndex: 1,
        patches: [
          {
            filename: '001-a.patch',
            status: 'resolved',
            error: 'stale failure text',
            conflictingFiles: ['browser/a.js'],
          },
          { filename: '002-b.patch', status: 'pending' },
        ],
      };
      await plant(JSON.stringify(legacy));

      const session = await tryReadRebaseSession(tmpRoot);
      expect(session).not.toBeNull();
      const resolved = session?.patches[0];
      expect(resolved?.status).toBe('resolved');
      // The stale payload is gone, not carried forward.
      expect(resolved).not.toHaveProperty('error');
      expect(resolved).not.toHaveProperty('conflictingFiles');
    });

    it('keeps failure payload on an entry that is still failed', async () => {
      const onDisk = {
        startedAt: new Date().toISOString(),
        fromVersion: '140.9.0esr',
        toVersion: '141.0',
        preRebaseCommit: 'a'.repeat(40),
        currentIndex: 0,
        patches: [
          {
            filename: '001-a.patch',
            status: 'failed',
            error: 'hunk 2 failed',
            conflictingFiles: ['browser/a.js'],
          },
        ],
      };
      await plant(JSON.stringify(onDisk));

      const session = await tryReadRebaseSession(tmpRoot);
      const failed = session?.patches[0];
      expect(failed?.status).toBe('failed');
      expect(failed).toMatchObject({
        error: 'hunk 2 failed',
        conflictingFiles: ['browser/a.js'],
      });
    });
  });
});
