// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { composeComponentSource, mapDeployedComponentSources } from '../furnace-composed-source.js';
import { validateFurnaceConfig } from '../furnace-config.js';
import {
  canonicalJson,
  listSourceTree,
  readSourceBlobs,
  sourceBlobId,
  sourceGit,
  storeSourceBlobs,
} from './git.js';
import { assertSourcePath } from './paths.js';
import type { CapturedInput, SourceObjectFormat } from './types.js';

export interface GeneratedSource {
  bytes: Buffer;
  blob: string;
  mode: '100644';
  sourcePath: string;
}

/** Compose exclusively from captured component and shared-fragment objects. */
export async function composeCapturedFurnace(
  repository: string,
  inputs: readonly CapturedInput[],
  format: SourceObjectFormat
): Promise<Map<string, GeneratedSource>> {
  const configuration = inputs.find((entry) => entry.path === 'furnace.json');
  if (!configuration) return new Map();
  const selected = inputs.filter(
    (entry) => entry.path === 'furnace.json' || entry.path.startsWith('components/')
  );
  const blobs = await readSourceBlobs(
    repository,
    selected.map((entry) => entry.blob)
  );
  const temporary = await mkdtemp(join(tmpdir(), 'fireforge-compose-'));
  try {
    for (const input of selected) {
      assertSourcePath(input.path);
      const bytes = blobs.get(input.blob);
      if (!bytes) throw new GeneralError('authored-generated-input-missing');
      await mkdir(dirname(join(temporary, input.path)), { recursive: true });
      await writeFile(join(temporary, input.path), bytes);
    }
    const raw = blobs.get(configuration.blob);
    if (!raw) throw new GeneralError('authored-generated-input-missing');
    const config = validateFurnaceConfig(JSON.parse(raw.toString('utf8')) as unknown);
    const generated = new Map<string, GeneratedSource>();
    for (const [path, source] of await mapDeployedComponentSources(temporary, config, {
      refuseCollisions: true,
    })) {
      assertSourcePath(path);
      const rawBytes = await readFile(source.sourcePath);
      let bytes = rawBytes;
      if (source.fileName.endsWith('.css')) {
        const text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(rawBytes);
        bytes = Buffer.from(
          await composeComponentSource(
            text,
            source.fileName,
            join(temporary, 'components', 'shared')
          )
        );
      }
      generated.set(path, {
        bytes,
        blob: sourceBlobId(bytes, format),
        mode: '100644',
        sourcePath: `components/${source.type === 'custom' ? 'custom' : 'overrides'}/${source.component}/${source.fileName}`,
      });
    }
    return generated;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Keep derived blob objects reachable without adding generated files to root history. */
export async function storeGeneratedTree(
  repository: string,
  generated: ReadonlyMap<string, GeneratedSource>
): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'fireforge-generated-'));
  try {
    const files = [...generated].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const hashes = await storeSourceBlobs(
      repository,
      files.map(([, file]) => file.bytes)
    );
    const env = { GIT_INDEX_FILE: join(temporary, 'index') };
    await sourceGit(repository, ['read-tree', '--empty'], undefined, env);
    const records = files
      .map(([path, file], index) => {
        if (hashes[index] !== file.blob)
          throw new GeneralError('authored-generated-object-mismatch');
        return `${file.mode} ${file.blob}\t${path}\0`;
      })
      .join('');
    if (records) await sourceGit(repository, ['update-index', '-z', '--index-info'], records, env);
    return (await sourceGit(repository, ['write-tree'], undefined, env)).toString('utf8').trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Authenticate every derived output against its captured composition. */
export async function authenticateGeneratedTree(
  repository: string,
  tree: string,
  generated: ReadonlyMap<string, GeneratedSource>
): Promise<void> {
  const expected = [...generated]
    .map(([path, entry]) => ({ path, mode: entry.mode, blob: entry.blob }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const actual = (await listSourceTree(repository, tree)).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  if (canonicalJson(expected) !== canonicalJson(actual))
    throw new GeneralError('authored-generated-tree-mismatch');
  await readSourceBlobs(
    repository,
    actual.map((entry) => entry.blob)
  );
}
