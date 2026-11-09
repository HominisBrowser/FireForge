// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadFirefoxSource } from '../../firefox.js';
import { captureAuthoredSnapshot } from '../capture.js';
import { pruneSnapshotRefs } from '../feedback.js';
import { sourceGit } from '../git.js';
import { fetchPristineDonor, PRISTINE_PIN_FILE } from '../pristine.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

vi.mock('../../firefox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../firefox.js')>()),
  downloadFirefoxSource: vi.fn(),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  return value;
}

describe('pristine donors', () => {
  it('fetches the pinned commit from an existing repository into a standalone donor', async () => {
    const value = await fixture();
    await writeAt(value.pristine, 'later/commit.txt', 'moved past the pin\n');
    await commitFixture(value.pristine);
    const before = await sourceGit(value.pristine, ['count-objects', '-v']);
    const destination = join(dirname(value.root), 'hosts/new/donor');
    const donor = await fetchPristineDonor({
      projectRoot: value.root,
      destination,
      from: value.pristine,
    });
    expect(donor).toMatchObject({ commit: value.commit, origin: 'repository' });
    expect(await sourceGit(value.pristine, ['count-objects', '-v'])).toEqual(before);
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: value.root,
      pristineRepository: destination,
    });
    expect(snapshot.pin.commit).toBe(value.commit);
    expect(JSON.parse(await readFile(join(destination, PRISTINE_PIN_FILE), 'utf8'))).toMatchObject({
      commit: value.commit,
      firefox: value.config.firefox,
    });
  });

  it('imports an archive deterministically, so two hosts agree on the commit', async () => {
    const value = await fixture();
    vi.mocked(downloadFirefoxSource).mockImplementation(async ({ destDir }) => {
      await writeAt(destDir, 'browser/config/version.txt', '153.7.0\n');
      await writeAt(destDir, 'mach', '#!/bin/sh\n', true);
    });
    const firefox = { ...value.config.firefox, version: '153.7.0esr' };
    const import_ = (name: string): ReturnType<typeof fetchPristineDonor> =>
      fetchPristineDonor({
        projectRoot: value.root,
        destination: join(dirname(value.root), name),
        pin: { firefox },
      });
    const first = await import_('host-a');
    const second = await import_('host-b');
    expect(second.commit).toBe(first.commit);
    expect(first.origin).toBe('archive');
    expect(vi.mocked(downloadFirefoxSource).mock.calls[0]?.[0]).toMatchObject({
      version: '153.7.0esr',
      expectedSha256: firefox.sha256,
    });
    expect(
      (
        await sourceGit(first.repository, ['show', `${first.commit}:browser/config/version.txt`])
      ).toString('utf8')
    ).toBe('153.7.0\n');
    expect(
      (await sourceGit(first.repository, ['rev-parse', '--is-bare-repository']))
        .toString('utf8')
        .trim()
    ).toBe('true');
    const pin = JSON.parse(
      await readFile(join(first.repository, PRISTINE_PIN_FILE), 'utf8')
    ) as Record<string, unknown>;
    expect(pin).toEqual({ firefox, commit: first.commit });
  });

  it('refuses an archive that does not reproduce the pin, leaving no donor', async () => {
    const value = await fixture();
    vi.mocked(downloadFirefoxSource).mockImplementation(async ({ destDir }) => {
      await writeAt(destDir, 'browser/other.txt', 'not the pinned tree\n');
    });
    const destination = join(dirname(value.root), 'donor');
    await expect(fetchPristineDonor({ projectRoot: value.root, destination })).rejects.toThrow(
      'authored-pristine-pin-unreproducible'
    );
    await expect(readFile(join(destination, 'HEAD'))).rejects.toThrow();
  });

  it('refuses destinations inside the project or already in use', async () => {
    const value = await fixture();
    await expect(
      fetchPristineDonor({
        projectRoot: value.root,
        destination: join(value.root, 'donor'),
        from: value.pristine,
      })
    ).rejects.toThrow('authored-pristine-destination');
    const occupied = join(dirname(value.root), 'occupied');
    await mkdir(occupied);
    await writeFile(join(occupied, 'file'), 'x');
    await expect(
      fetchPristineDonor({ projectRoot: value.root, destination: occupied, from: value.pristine })
    ).rejects.toThrow('authored-pristine-destination-not-empty');
  });
});

describe('snapshot retention', () => {
  it('releases old refs beyond the newest, keeping those in use, and objects survive until collected', async () => {
    const value = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      await writeAt(value.root, 'src/browser/new.js', `export const value = ${index};\n`);
      const snapshot = await captureAuthoredSnapshot({
        projectRoot: value.root,
        pristineRepository: value.pristine,
      });
      ids.push(snapshot.id);
      await new Promise((accept) => setTimeout(accept, 20));
    }
    const refs = async (): Promise<string[]> =>
      (
        await sourceGit(value.root, [
          'for-each-ref',
          '--format=%(refname:lstrip=3)',
          'refs/fireforge/snapshots',
        ])
      )
        .toString('utf8')
        .split('\n')
        .filter(Boolean);
    expect(await refs()).toHaveLength(4);
    const result = await pruneSnapshotRefs({
      projectRoot: value.root,
      keep: 1,
      inUse: new Set([ids[0] ?? '']),
    });
    expect(result.removed.sort()).toEqual([ids[1], ids[2]].sort());
    expect((await refs()).sort()).toEqual([ids[0], ids[3]].sort());
  });

  /** Three snapshot refs on the empty tree, written oldest to newest at distinct times. */
  async function datedRefs(
    root: string,
    ids: readonly string[],
    options: { reflog: boolean }
  ): Promise<void> {
    const tree = (await sourceGit(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], ''))
      .toString('utf8')
      .trim();
    for (const [index, id] of ids.entries()) {
      const seconds = 1_700_000_000 + index * 3600;
      await sourceGit(
        root,
        [
          'update-ref',
          ...(options.reflog ? ['--create-reflog'] : []),
          `refs/fireforge/snapshots/${id}`,
          tree,
        ],
        undefined,
        { GIT_COMMITTER_DATE: `${seconds} +0000` }
      );
      if (!options.reflog) {
        const common = (
          await sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        )
          .toString('utf8')
          .trim();
        await utimes(join(common, 'refs/fireforge/snapshots', id), seconds, seconds);
      }
    }
  }

  const snapshotIds = async (root: string): Promise<string[]> =>
    (
      await sourceGit(root, [
        'for-each-ref',
        '--format=%(refname:lstrip=3)',
        'refs/fireforge/snapshots',
      ])
    )
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .sort();

  // Written oldest first; the newest sorts last by name, so refs listed in name order with no
  // usable age would keep the oldest.
  const OLDEST = 'a'.repeat(64);
  const MIDDLE = 'b'.repeat(64);
  const NEWEST = 'c'.repeat(64);

  it('keeps the newest snapshot when pruned from a linked worktree', async () => {
    const value = await fixture();
    await datedRefs(value.root, [OLDEST, MIDDLE, NEWEST], { reflog: false });
    const linked = join(dirname(value.root), 'linked');
    await sourceGit(value.root, ['worktree', 'add', '-q', '--detach', linked]);
    const result = await pruneSnapshotRefs({ projectRoot: linked, keep: 1, inUse: new Set() });
    expect(result.removed.sort()).toEqual([MIDDLE, OLDEST].sort());
    expect(await snapshotIds(value.root)).toEqual([NEWEST]);
  });

  it('dates packed snapshot refs by their reflog', async () => {
    const value = await fixture();
    await datedRefs(value.root, [OLDEST, MIDDLE, NEWEST], { reflog: true });
    await sourceGit(value.root, ['pack-refs', '--all']);
    const result = await pruneSnapshotRefs({ projectRoot: value.root, keep: 1, inUse: new Set() });
    expect(result.removed.sort()).toEqual([MIDDLE, OLDEST].sort());
    expect(await snapshotIds(value.root)).toEqual([NEWEST]);
  });

  it('never releases a snapshot whose age is unknown', async () => {
    const value = await fixture();
    await datedRefs(value.root, [OLDEST, MIDDLE, NEWEST], { reflog: false });
    await sourceGit(value.root, ['pack-refs', '--all']);
    const result = await pruneSnapshotRefs({ projectRoot: value.root, keep: 1, inUse: new Set() });
    expect(result).toMatchObject({ removed: [], kept: 3 });
    expect(result.undated.sort()).toEqual([NEWEST, MIDDLE, OLDEST].sort());
    expect(await snapshotIds(value.root)).toHaveLength(3);
  });

  it('dates the refs capture retains, through packing', async () => {
    const value = await fixture();
    await writeAt(value.root, 'src/browser/new.js', 'export const value = 9;\n');
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: value.root,
      pristineRepository: value.pristine,
    });
    await sourceGit(value.root, ['pack-refs', '--all']);
    const result = await pruneSnapshotRefs({ projectRoot: value.root, keep: 1, inUse: new Set() });
    expect(result).toMatchObject({ removed: [], undated: [] });
    expect(await snapshotIds(value.root)).toContain(snapshot.id);
  });
});
