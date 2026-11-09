// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { getPackageVersion } from '../../utils/package-root.js';
import { getPlatform, type Platform } from '../../utils/platform.js';
import { isBrandingSetup, setupBranding } from '../branding.js';
import { generateMozconfig } from '../mach-mozconfig.js';
import {
  digest,
  pristineRepositoryFor,
  readSourceBlobs,
  sourceGit,
  sourcePathText,
} from './git.js';
import { assertSourceMode, assertSourcePath } from './paths.js';
import { authenticateAuthoredSnapshot } from './provider.js';
import type { AuthoredSnapshot, SourceFileMode } from './types.js';

export interface GeneratedBuildFile {
  bytes: Buffer;
  mode: SourceFileMode;
  sha256: string;
}
export interface CapturedBuildOutputs {
  files: Map<string, GeneratedBuildFile>;
  provenance: {
    sourceId: string;
    pinCommit: string;
    platform: Platform;
    generator: string;
    toolVersion: string;
    inputs: string;
  };
}

function isSelected(path: string, binaryName: string): boolean {
  return (
    path === 'browser/moz.configure' ||
    path === 'toolkit/moz.configure' ||
    path === 'mozconfig' ||
    path.startsWith('browser/branding/unofficial/') ||
    path.startsWith(`browser/branding/${binaryName}/`)
  );
}

async function seedInputs(
  snapshot: AuthoredSnapshot,
  pristineRepository: string
): Promise<Map<string, { bytes: Buffer; mode: SourceFileMode }>> {
  const raw = await sourceGit(pristineRepository, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    snapshot.pin.commit,
    '--',
    'browser/branding/unofficial',
    `browser/branding/${snapshot.config.binaryName}`,
    'browser/moz.configure',
    'toolkit/moz.configure',
  ]);
  const entries = sourcePathText(raw)
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
      if (!match || match[2] !== 'blob') throw new GeneralError('authored-build-input-kind');
      const mode = match[1] ?? '';
      assertSourceMode(mode);
      const path = match[4] ?? '';
      assertSourcePath(path);
      return { path, mode, blob: match[3] ?? '' };
    });
  const base = await readSourceBlobs(
    pristineRepository,
    entries.map((entry) => entry.blob)
  );
  const inputs = new Map<string, { bytes: Buffer; mode: SourceFileMode }>();
  for (const entry of entries) {
    const bytes = base.get(entry.blob);
    if (!bytes) throw new GeneralError('authored-build-input-unavailable');
    inputs.set(entry.path, { bytes, mode: entry.mode });
  }
  const overlay = snapshot.files.filter((file) =>
    isSelected(file.path, snapshot.config.binaryName)
  );
  const blobs = await readSourceBlobs(
    snapshot.repository,
    overlay.flatMap((file) => (file.blob ? [file.blob] : []))
  );
  for (const entry of overlay) {
    if (entry.blob) {
      const bytes = blobs.get(entry.blob);
      if (!bytes) throw new GeneralError('authored-build-input-unavailable');
      inputs.set(entry.path, { bytes, mode: entry.mode });
    } else inputs.delete(entry.path);
  }
  return inputs;
}

async function readOutputFiles(
  root: string,
  relative = ''
): Promise<Map<string, GeneratedBuildFile>> {
  const files = new Map<string, GeneratedBuildFile>();
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [child, value] of await readOutputFiles(root, path)) files.set(child, value);
    } else if (entry.isFile()) {
      const bytes = await readFile(join(root, path));
      files.set(path, {
        bytes,
        mode: ((await lstat(join(root, path))).mode & 0o111) !== 0 ? '100755' : '100644',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } else throw new GeneralError(`authored-build-output-kind: ${path}`);
  }
  return files;
}

/** Compute the exact existing branding/mozconfig contract from frozen inputs in a bounded scratch tree. */
export async function composeCapturedBuildOutputs(
  snapshot: AuthoredSnapshot,
  options: { pristineRepository?: string } = {}
): Promise<CapturedBuildOutputs> {
  const pristineRepository = pristineRepositoryFor(snapshot.repository, options.pristineRepository);
  const captured = await authenticateAuthoredSnapshot(snapshot, pristineRepository);
  const inputs = await seedInputs(captured, pristineRepository);
  const configs = captured.inputs.filter((input) => input.path.startsWith('configs/'));
  const configBlobs = await readSourceBlobs(
    captured.repository,
    configs.map((input) => input.blob)
  );
  const temporary = await mkdtemp(join(tmpdir(), 'fireforge-build-compose-'));
  const engine = join(temporary, 'engine');
  await mkdir(engine);
  try {
    for (const [path, file] of inputs) {
      await mkdir(dirname(join(engine, path)), { recursive: true });
      await writeFile(join(engine, path), file.bytes);
      await chmod(join(engine, path), file.mode === '100755' ? 0o755 : 0o644);
    }
    for (const input of configs) {
      assertSourcePath(input.path);
      const bytes = configBlobs.get(input.blob);
      if (!bytes) throw new GeneralError('authored-build-config-unavailable');
      await mkdir(dirname(join(temporary, input.path)), { recursive: true });
      await writeFile(join(temporary, input.path), bytes);
    }
    const config = captured.config;
    if (!(await isBrandingSetup(engine, config))) await setupBranding(engine, config);
    await generateMozconfig(join(temporary, 'configs'), engine, config);
    const files = await readOutputFiles(engine);
    for (const [path, file] of files) {
      const previous = inputs.get(path);
      if (previous?.bytes.equals(file.bytes) && previous.mode === file.mode) files.delete(path);
    }
    return {
      files,
      provenance: {
        sourceId: captured.id,
        pinCommit: captured.pin.commit,
        platform: getPlatform(),
        generator: 'fireforge-build-preparation-v1',
        toolVersion: getPackageVersion(),
        inputs: digest({ source: captured.tree, generated: captured.generatedTree, configs }),
      },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
