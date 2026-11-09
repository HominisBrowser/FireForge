// SPDX-License-Identifier: EUPL-1.2
import { cp, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import type { FireForgeConfig } from '../../types/config.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { captureAuthoredSnapshot } from './capture.js';
import { sourceGit } from './git.js';
import { materializeAuthoredSnapshot } from './materialize.js';
import type { AuthoredSourceConfig } from './types.js';

export interface PathImage {
  mode: string;
  bytes: Buffer;
}

async function pathImage(directory: string, path: string): Promise<PathImage | undefined> {
  try {
    const stat = await lstat(join(directory, path));
    return {
      mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
      bytes: await readFile(join(directory, path)),
    };
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Copy what an adopted project would capture beside the overlay, so capture behaves as there. */
async function seedVerifyProject(
  root: string,
  project: string,
  config: FireForgeConfig
): Promise<void> {
  const adrs = (config.patchPolicy?.reservedRanges ?? []).flatMap((range) =>
    range.allowed.flatMap((entry) => (entry.adr ? [entry.adr] : []))
  );
  const inputs = [
    'components',
    'configs',
    'furnace.json',
    'package.json',
    'package-lock.json',
    '.gitignore',
    '.gitattributes',
    ...adrs,
  ];
  for (const name of inputs)
    await cp(join(root, name), join(project, name), { recursive: true }).catch((error: unknown) => {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    });
}

/**
 * Prove the overlay reconstructs the queue: capture it as an adopted project would, materialize it
 * onto the pristine bytes of the queue's paths, and compare every path with the replayed queue.
 */
export async function verifyMigration(options: {
  root: string;
  overlay: string;
  staging: string;
  temporary: string;
  sources: AuthoredSourceConfig;
  config: FireForgeConfig;
  pristineRepository: string;
  pristineFiles: ReadonlyMap<string, PathImage>;
  affected: ReadonlySet<string>;
}): Promise<{ paths: number }> {
  const { root, overlay, sources, config, pristineRepository, temporary, affected } = options;
  const project = join(temporary, 'verify-project');
  const engine = join(temporary, 'verify-engine');
  await mkdir(project);
  await mkdir(engine);
  await cp(overlay, project, { recursive: true });
  await seedVerifyProject(root, project, config);
  await writeFile(
    join(project, 'fireforge.json'),
    JSON.stringify({ ...config, sources, test: { ...config.test, reapOrphans: 'owned' } }, null, 2)
  );
  await sourceGit(project, ['init', '-q']);
  await sourceGit(project, ['add', '-A']);
  await sourceGit(project, [
    '-c',
    'user.email=fireforge@localhost',
    '-c',
    'user.name=FireForge',
    'commit',
    '-q',
    '--no-gpg-sign',
    '-m',
    'migration overlay',
  ]);
  for (const [path, image] of options.pristineFiles) {
    await mkdir(dirname(join(engine, path)), { recursive: true });
    await writeFile(join(engine, path), image.bytes, {
      mode: image.mode === '100755' ? 0o755 : 0o644,
    });
  }
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: project,
    pristineRepository,
    retain: false,
  });
  await materializeAuthoredSnapshot({
    snapshot,
    engineDir: engine,
    ledgerPath: join(temporary, 'verify-ledger.json'),
    pristineRepository,
  });
  const produced = (await readdir(engine, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(engine, join(entry.parentPath, entry.name)).split(sep).join('/'));
  const differing: string[] = [];
  for (const path of [...new Set([...affected, ...produced])].sort()) {
    const expected = await pathImage(options.staging, path);
    const actual = await pathImage(engine, path);
    if (
      expected === undefined || actual === undefined
        ? expected !== actual
        : expected.mode !== actual.mode || !expected.bytes.equals(actual.bytes)
    )
      differing.push(path);
  }
  if (differing.length > 0)
    throw new GeneralError(
      `authored-migration-verify-mismatch: ${differing.length} path(s) differ from the replayed queue: ${differing.slice(0, 10).join(', ')}`
    );
  return { paths: affected.size };
}
