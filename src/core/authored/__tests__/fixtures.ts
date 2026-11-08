// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FireForgeConfig } from '../../../types/config.js';
import { generateAuthoredDelta, upstreamDeltasFromDiff } from '../generate.js';
import { digest, readSourceBlob, sourceGit } from '../git.js';
import { assertSourcePath } from '../paths.js';
import type { AuthoredSnapshot, UpstreamDeclaration, UpstreamDelta } from '../types.js';

export async function writeAt(
  root: string,
  path: string,
  bytes: string | Buffer,
  executable = false
): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
  await chmod(join(root, path), executable ? 0o755 : 0o644);
}

export async function commitFixture(root: string): Promise<void> {
  await sourceGit(root, ['add', '-A']);
  await sourceGit(root, [
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'user.name=Fixture',
    'commit',
    '-qm',
    'fixture',
  ]);
}

export async function sourceFixture(): Promise<{
  root: string;
  pristine: string;
  commit: string;
  declaration: UpstreamDeclaration;
  config: FireForgeConfig;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'fireforge-authored-test-'));
  const root = join(directory, 'project');
  const pristine = join(directory, 'pristine');
  await mkdir(root);
  await mkdir(pristine);
  await sourceGit(pristine, ['init', '-q']);
  await writeAt(pristine, 'browser/manifest.txt', 'first\nsecond\nthird\nfourth\nfifth\n');
  await commitFixture(pristine);
  const commit = (await sourceGit(pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  const blob = (await sourceGit(pristine, ['rev-parse', 'HEAD:browser/manifest.txt']))
    .toString('utf8')
    .trim();
  const config: FireForgeConfig = {
    name: 'Fixture',
    vendor: 'Example',
    binaryName: 'fixture',
    appId: 'invalid.example.fixture',
    firefox: { version: '153.6.0esr', product: 'firefox-esr', sha256: 'a'.repeat(64) },
    test: { reapOrphans: 'owned' },
    sources: {
      schemaVersion: 1,
      mode: 'authored',
      root: 'src',
      metadataRoot: '.fireforge-sources',
      pristineCommit: commit,
    },
  };
  const declaration: UpstreamDeclaration = {
    schemaVersion: 1,
    kind: 'override',
    path: 'browser/manifest.txt',
    base: { pin: digest({ firefox: config.firefox, commit }), commit, blob, mode: '100644' },
    component: 'infra-registration',
    classification: 'registration',
  };
  await sourceGit(root, ['init', '-q']);
  await writeAt(root, '.gitignore', 'engine/\n.fireforge/\n');
  await writeAt(root, 'fireforge.json', JSON.stringify(config));
  await writeAt(root, 'package.json', '{"name":"fixture","private":true}\n');
  await writeAt(root, 'src/browser/new.js', 'export const value = 1;\n');
  await commitFixture(root);
  return { root, pristine, commit, declaration, config };
}

/** Captured bytes of one source file, read from the snapshot's Git objects. */
export async function readCaptured(
  snapshot: AuthoredSnapshot,
  path: string
): Promise<Buffer | undefined> {
  assertSourcePath(path);
  const entry = snapshot.files.find((file) => file.path === path);
  return entry?.blob ? readSourceBlob(snapshot.repository, entry.blob) : undefined;
}

/** Parsed upstream deltas of a snapshot against a pristine donor. */
export async function upstreamDeltas(
  snapshot: AuthoredSnapshot,
  pristineRepository: string
): Promise<UpstreamDelta[]> {
  return upstreamDeltasFromDiff(
    snapshot,
    await generateAuthoredDelta(snapshot, { pristineRepository, upstreamOnly: true })
  );
}
