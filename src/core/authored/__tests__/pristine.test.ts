// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
});
