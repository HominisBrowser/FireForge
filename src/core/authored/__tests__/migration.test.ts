// SPDX-License-Identifier: EUPL-1.2
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { evaluateAuthoredSourcePolicy } from '../../authored-policy.js';
import { captureAuthoredSnapshot } from '../capture.js';
import { generateAuthoredDelta } from '../generate.js';
import { sourceGit } from '../git.js';
import * as materialize from '../materialize.js';
import { migrateLegacyQueue } from '../migrate.js';
import { declareAuthoredOverride, removeAuthoredOverride } from '../writer.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it('migrates exact queue postimages with binary, CRLF, modes and original waiver provenance, excluding live engine drift', async () => {
  const { root, pristine, declaration, config } = await sourceFixture();
  directories.push(dirname(root));
  await writeAt(root, 'src/browser/manifest.txt', 'first\nlocal\nthird\nfourth\nfifth\n');
  await writeAt(
    root,
    '.fireforge-sources/overrides/browser/manifest.txt.json',
    JSON.stringify(declaration)
  );
  await writeAt(root, 'src/browser/crlf.txt', Buffer.from('first\r\nsecond\r\n'));
  await writeAt(root, 'src/browser/binary.dat', Buffer.from([0, 0xff, 10]));
  await writeAt(root, 'src/browser/run.sh', '#!/bin/sh\nexit 0\n', true);
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: root,
    intendedPaths: ['src'],
    pristineRepository: pristine,
  });
  const delta = await generateAuthoredDelta(snapshot, { pristineRepository: pristine });
  const legacy = { ...config };
  delete legacy.sources;
  await writeAt(root, 'fireforge.json', JSON.stringify(legacy));
  await writeAt(root, 'patches/001-infra-fixture.patch', delta);
  const waiver = {
    rule: 'file-too-large',
    max: 1200,
    reason: 'Fixture preserves the original ceiling',
  };
  await writeAt(
    root,
    'patches/patches.json',
    JSON.stringify({
      version: 1,
      patches: [
        {
          filename: '001-infra-fixture.patch',
          order: 1,
          category: 'infra',
          name: 'fixture',
          description: 'Fixture queue',
          createdAt: '2026-11-05T00:00:00.000Z',
          sourceEsrVersion: config.firefox.version,
          filesAffected: snapshot.files.map((file) => file.path),
          lintIgnore: [waiver],
          tier: 'branding',
        },
      ],
    })
  );
  await writeAt(root, 'engine/browser/manifest.txt', 'foreign live edit must never migrate\n');
  const destination = join(dirname(root), 'migration');
  const result = await migrateLegacyQueue({
    projectRoot: root,
    destination,
    pristineRepository: pristine,
  });
  expect(result.overrides).toBe(1);
  expect(await readFile(join(destination, 'src/browser/manifest.txt'), 'utf8')).toContain('local');
  expect(await readFile(join(root, 'engine/browser/manifest.txt'), 'utf8')).toContain(
    'foreign live edit'
  );
  const waivers = JSON.parse(
    await readFile(join(destination, '.fireforge-sources/waivers.json'), 'utf8')
  ) as {
    exceptions: { checks: unknown[]; tier: string; provenance: string }[];
  };
  expect(waivers.exceptions[0]?.checks).toEqual([waiver]);
  expect(waivers.exceptions[0]?.tier).toBe('branding');
  expect(waivers.exceptions[0]?.provenance).toMatch(/^[a-f0-9]{64}$/);
  const migrated = join(dirname(root), 'migrated-project');
  await mkdir(migrated);
  await cp(join(destination, 'src'), join(migrated, 'src'), { recursive: true });
  await cp(join(destination, '.fireforge-sources'), join(migrated, '.fireforge-sources'), {
    recursive: true,
  });
  await writeAt(migrated, 'fireforge.json', JSON.stringify({ ...config, sources: result.sources }));
  await sourceGit(migrated, ['init', '-q']);
  await commitFixture(migrated);
  const captured = await captureAuthoredSnapshot({
    projectRoot: migrated,
    intendedPaths: ['src'],
    pristineRepository: pristine,
  });
  expect(await generateAuthoredDelta(captured, { pristineRepository: pristine })).toBe(delta);
  await expect(evaluateAuthoredSourcePolicy(captured)).rejects.toThrow('policy-migration-invalid');
});

/** A legacy project whose queue touches upstream text and binary paths and creates files. */
async function legacyQueue(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const { root, pristine, declaration, config } = value;
  await writeAt(root, 'src/browser/manifest.txt', 'first\nlocal\nthird\nfourth\nfifth\n');
  await writeAt(
    root,
    '.fireforge-sources/overrides/browser/manifest.txt.json',
    JSON.stringify(declaration)
  );
  await writeAt(root, 'src/browser/binary.dat', Buffer.from([0, 0xff, 10]));
  await writeAt(root, 'src/browser/run.sh', '#!/bin/sh\nexit 0\n', true);
  await writeAt(root, 'src/browser/crlf.txt', Buffer.from('a\r\nb\r\n'));
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: root,
    pristineRepository: pristine,
  });
  const delta = await generateAuthoredDelta(snapshot, { pristineRepository: pristine });
  const legacy = { ...config };
  delete legacy.sources;
  await writeAt(root, 'fireforge.json', JSON.stringify(legacy));
  await writeAt(root, 'patches/001-infra-fixture.patch', delta);
  await writeAt(
    root,
    'patches/patches.json',
    JSON.stringify({
      version: 1,
      patches: [
        {
          filename: '001-infra-fixture.patch',
          order: 1,
          category: 'infra',
          name: 'fixture',
          description: 'Fixture queue',
          createdAt: '2026-11-05T00:00:00.000Z',
          sourceEsrVersion: config.firefox.version,
          filesAffected: snapshot.files.map((file) => file.path),
        },
      ],
    })
  );
  return value;
}

it('emits a ready configuration fragment and source attributes, and verifies reconstruction', async () => {
  const value = await legacyQueue();
  const destination = join(dirname(value.root), 'nested/migration');
  const result = await migrateLegacyQueue({
    projectRoot: value.root,
    destination,
    pristineRepository: value.pristine,
    verify: true,
  });
  expect(result.verified?.paths).toBeGreaterThanOrEqual(4);
  expect(await readFile(join(destination, 'src/.gitattributes'), 'utf8')).toContain('* -text\n');
  const fragment = JSON.parse(
    await readFile(join(destination, 'fireforge.fragment.json'), 'utf8')
  ) as Record<string, unknown>;
  expect(fragment).toEqual({
    sources: result.sources,
    test: { reapOrphans: 'owned' },
  });
  await expect(readFile(join(destination, 'sources-config.json'))).rejects.toThrow();
  expect(
    (await readdir(dirname(destination))).filter((name) => name.includes('.migrate-'))
  ).toEqual([]);
});

it('fails verification on a queue the overlay cannot reproduce, leaving nothing behind', async () => {
  const value = await legacyQueue();
  // An ignored overlay path would vanish from the commit an adopted project makes.
  await writeAt(value.root, '.gitignore', 'engine/\n.fireforge/\nbinary.dat\n');
  const destination = join(dirname(value.root), 'migration');
  await expect(
    migrateLegacyQueue({
      projectRoot: value.root,
      destination,
      pristineRepository: value.pristine,
      verify: true,
    })
  ).rejects.toThrow('authored-');
  await expect(readdir(destination)).rejects.toThrow();
  expect(
    (await readdir(dirname(destination))).filter((name) => name.includes('.migrate-'))
  ).toEqual([]);
});

it('names the paths where the materialized overlay differs from the replayed queue', async () => {
  const value = await legacyQueue();
  const original = materialize.materializeAuthoredSnapshot;
  vi.spyOn(materialize, 'materializeAuthoredSnapshot').mockImplementation(async (options) => {
    const result = await original(options);
    await writeFile(join(options.engineDir, 'browser/manifest.txt'), 'altered after materializing');
    return result;
  });
  const destination = join(dirname(value.root), 'mismatch');
  await expect(
    migrateLegacyQueue({
      projectRoot: value.root,
      destination,
      pristineRepository: value.pristine,
      verify: true,
    })
  ).rejects.toThrow(
    'authored-migration-verify-mismatch: 1 path(s) differ from the replayed queue: browser/manifest.txt'
  );
  await expect(readdir(destination)).rejects.toThrow();
});

it('leaves a failed migration retryable: no destination, and the retry succeeds', async () => {
  const value = await legacyQueue();
  const patches = join(value.root, 'patches');
  const body = await readFile(join(patches, '001-infra-fixture.patch'));
  await writeFile(
    join(patches, '001-infra-fixture.patch'),
    body.toString('utf8').replace('+local', '+corrupted-context\n+local')
  );
  const destination = join(dirname(value.root), 'retry');
  const attempt = (): ReturnType<typeof migrateLegacyQueue> =>
    migrateLegacyQueue({
      projectRoot: value.root,
      destination,
      pristineRepository: value.pristine,
    });
  await expect(attempt()).rejects.toThrow();
  await expect(readdir(destination)).rejects.toThrow();
  await writeFile(join(patches, '001-infra-fixture.patch'), body);
  await expect(attempt()).resolves.toMatchObject({ overrides: 1 });
  await expect(attempt()).rejects.toThrow('authored-migration-destination-not-empty');
});

it('pins the recorded base rather than a donor HEAD that has moved, and refuses one it lacks', async () => {
  const value = await legacyQueue();
  const recorded = value.commit;
  await writeAt(value.pristine, 'unrelated/moved.txt', 'HEAD moved past the base\n');
  await commitFixture(value.pristine);
  await writeAt(value.root, '.fireforge/state.json', JSON.stringify({ baseCommit: recorded }));
  const result = await migrateLegacyQueue({
    projectRoot: value.root,
    destination: join(dirname(value.root), 'pinned'),
    pristineRepository: value.pristine,
  });
  expect(result).toMatchObject({
    pinSource: 'recorded-base',
    sources: { pristineCommit: recorded },
  });
  await writeAt(
    value.root,
    '.fireforge/state.json',
    JSON.stringify({ baseCommit: 'a'.repeat(40) })
  );
  await expect(
    migrateLegacyQueue({
      projectRoot: value.root,
      destination: join(dirname(value.root), 'mismatch'),
      pristineRepository: value.pristine,
    })
  ).rejects.toThrow('authored-migration-pin-mismatch');
  await expect(
    migrateLegacyQueue({
      projectRoot: value.root,
      destination: join(dirname(value.root), 'explicit'),
      pristineRepository: value.pristine,
      pristineCommit: recorded,
    })
  ).resolves.toMatchObject({ pinSource: 'explicit' });
});

it('refuses restore-upstream over uncommitted edits, but not over seeded or committed bytes', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const { root, pristine, declaration } = value;
  const sidecar = '.fireforge-sources/overrides/browser/manifest.txt.json';
  const seed = async (bytes: string): Promise<void> => {
    await writeAt(root, sidecar, JSON.stringify(declaration));
    await writeAt(root, 'src/browser/manifest.txt', bytes);
  };
  await seed('first\nsecond\nthird\nfourth\nfifth\n');
  await removeAuthoredOverride(root, 'browser/manifest.txt');
  await seed('committed edit\n');
  await commitFixture(root);
  await removeAuthoredOverride(root, 'browser/manifest.txt');
  await seed('uncommitted edit\n');
  await expect(removeAuthoredOverride(root, 'browser/manifest.txt')).rejects.toThrow(
    'authored-postimage-uncommitted'
  );
  expect(await readFile(join(root, 'src/browser/manifest.txt'), 'utf8')).toBe('uncommitted edit\n');
  await removeAuthoredOverride(root, 'browser/manifest.txt', { discard: true });
  await expect(readFile(join(root, 'src/browser/manifest.txt'))).rejects.toThrow();
  await declareAuthoredOverride(root, 'browser/manifest.txt', {
    component: 'fixture',
    classification: 'exception',
    adr: 'fireforge.json',
    delete: true,
    pristineRepository: pristine,
  });
  await writeAt(root, 'src/browser/manifest.txt', 'created under the tombstone\n');
  const redeclare = {
    component: 'fixture',
    classification: 'exception' as const,
    adr: 'fireforge.json',
    delete: true,
    pristineRepository: pristine,
  };
  await expect(declareAuthoredOverride(root, 'browser/manifest.txt', redeclare)).rejects.toThrow(
    'authored-delete-has-postimage'
  );
  expect(await readFile(join(root, 'src/browser/manifest.txt'), 'utf8')).toContain('created');
  await declareAuthoredOverride(root, 'browser/manifest.txt', { ...redeclare, discard: true });
  await expect(readFile(join(root, 'src/browser/manifest.txt'))).rejects.toThrow();
});
