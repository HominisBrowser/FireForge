// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { parseDiffGitHeader, parseDiffSections } from '../patch-parse.js';
import {
  isSourceText,
  pristineRepositoryFor,
  readSourceBlobs,
  sourceGit,
  storeSourceBlobs,
} from './git.js';
import { authenticateAuthoredSnapshot } from './provider.js';
import type { AuthoredSnapshot, SourceFileMode, UpstreamDelta } from './types.js';

interface DiffFile {
  path: string;
  mode: SourceFileMode;
  bytes: Buffer;
}

function literalAttribute(path: string): string {
  return `"/${path.replace(/["\\*?[\]]/g, (char) => {
    if (char === '"') return '\\"';
    if (char === '\\') return '\\\\\\\\';
    return `\\\\${char}`;
  })}"`;
}

async function writeTree(repository: string, files: readonly DiffFile[]): Promise<string> {
  await sourceGit(repository, ['read-tree', '--empty']);
  const blobs = await storeSourceBlobs(
    repository,
    files.map((file) => file.bytes)
  );
  const records = files
    .map((file, index) => `${file.mode} ${blobs[index] ?? ''}\t${file.path}\0`)
    .join('');
  if (records) await sourceGit(repository, ['update-index', '-z', '--index-info'], records);
  return (await sourceGit(repository, ['write-tree'])).toString('utf8').trim();
}

/** Export exact deltas with pinned diff settings, without consulting a live engine. */
export async function generateAuthoredDelta(
  snapshot: AuthoredSnapshot,
  options: { pristineRepository?: string; paths?: readonly string[]; upstreamOnly?: boolean } = {}
): Promise<string> {
  const pristineRepository = pristineRepositoryFor(snapshot.repository, options.pristineRepository);
  const actual = await authenticateAuthoredSnapshot(snapshot, pristineRepository);
  const entries = actual.files.filter(
    (file) =>
      (!options.upstreamOnly || file.declaration) &&
      (!options.paths || options.paths.includes(file.path))
  );
  const source = await readSourceBlobs(
    snapshot.repository,
    entries.flatMap((file) => (file.blob ? [file.blob] : []))
  );
  const pristine = await readSourceBlobs(
    pristineRepository,
    entries.flatMap((file) => (file.declaration ? [file.declaration.base.blob] : []))
  );
  const before: DiffFile[] = [];
  const after: DiffFile[] = [];
  for (const file of entries) {
    if (file.declaration) {
      const bytes = pristine.get(file.declaration.base.blob);
      if (!bytes) throw new GeneralError(`authored-object-unavailable: ${file.path}`);
      before.push({ path: file.path, mode: file.declaration.base.mode, bytes });
    }
    if (file.blob) {
      const bytes = source.get(file.blob);
      if (!bytes) throw new GeneralError(`authored-object-unavailable: ${file.path}`);
      after.push({ path: file.path, mode: file.mode, bytes });
    }
  }
  const temporary = await mkdtemp(join(tmpdir(), 'fireforge-delta-'));
  try {
    const diffFormat = (await sourceGit(pristineRepository, ['rev-parse', '--show-object-format']))
      .toString('utf8')
      .trim();
    if (diffFormat !== 'sha1' && diffFormat !== 'sha256')
      throw new GeneralError('authored-invalid-object-format');
    await sourceGit(temporary, ['init', '--quiet', `--object-format=${diffFormat}`]);
    await mkdir(join(temporary, '.git', 'info'), { recursive: true });
    const attributes = [
      ...new Set(
        [...before, ...after].filter((file) => !isSourceText(file.bytes)).map((file) => file.path)
      ),
    ]
      .sort()
      .map((path) => `${literalAttribute(path)} -diff`)
      .join('\n');
    await writeFile(join(temporary, '.git', 'info', 'attributes'), `${attributes}\n`);
    const base = await writeTree(temporary, before);
    const head = await writeTree(temporary, after);
    return (
      await sourceGit(temporary, [
        '-c',
        'diff.noprefix=false',
        '-c',
        'diff.mnemonicPrefix=false',
        'diff-tree',
        '-p',
        '--no-commit-id',
        '--binary',
        '--full-index',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--diff-algorithm=myers',
        '--no-indent-heuristic',
        '--unified=3',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        base,
        head,
      ])
    ).toString('utf8');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Slice per-path sections at their exact headers: a binary hunk's terminating blank line is content. */
export function sliceDiffByPath(diff: string): Map<string, string> {
  const offsets: { path: string; start: number }[] = [];
  const header = /^diff --git .*$/gm;
  for (let match = header.exec(diff); match; match = header.exec(diff)) {
    const parsed = parseDiffGitHeader(match[0]);
    if (parsed) offsets.push({ path: parsed.targetPath, start: match.index });
  }
  return new Map(
    offsets.map(({ path, start }, index) => [path, diff.slice(start, offsets[index + 1]?.start)])
  );
}

/** The snapshot's declared paths among a diff's sections, as parsed upstream deltas. */
export function upstreamDeltasFromDiff(snapshot: AuthoredSnapshot, diff: string): UpstreamDelta[] {
  const sections = sliceDiffByPath(diff);
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  return parseDiffSections(diff).flatMap((section) => {
    const file = files.get(section.targetPath);
    return file?.declaration
      ? [{ path: file.path, declaration: file.declaration, diff: sections.get(file.path) ?? '' }]
      : [];
  });
}
