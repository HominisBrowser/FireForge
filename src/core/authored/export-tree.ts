// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { toError } from '../../utils/errors.js';
import { sourceBlobId, sourceGit, spawnSourceGit } from './git.js';
import type { SourceObjectFormat } from './types.js';

/** One entry of a tree being exported; mode 120000 is a link whose blob holds its target. */
export interface ExportEntry {
  path: string;
  mode: string;
  blob: string;
}

/**
 * Attributes a tree carries must not change exported bytes, so the view pins them all off: this
 * file outranks every in-tree `.gitattributes`.
 */
const NEUTRAL_ATTRIBUTES =
  '* -text -eol -ident -filter -working-tree-encoding -export-ignore -export-subst\n';
const VERIFY_CONCURRENCY = 32;

/** The object format of a repository, as hashes computed for it must use. */
async function objectFormatOf(repository: string): Promise<SourceObjectFormat> {
  const format = (await sourceGit(repository, ['rev-parse', '--show-object-format']))
    .toString('utf8')
    .trim();
  if (format !== 'sha1' && format !== 'sha256')
    throw new GeneralError('authored-invalid-object-format');
  return format;
}

/** A disposable bare repository borrowing the donor's objects; nothing is written to the donor. */
async function createExportView(
  repository: string,
  format: SourceObjectFormat,
  directory: string
): Promise<void> {
  const objectPath = (await sourceGit(repository, ['rev-parse', '--git-path', 'objects']))
    .toString('utf8')
    .trim();
  const objects = isAbsolute(objectPath) ? objectPath : resolve(repository, objectPath);
  if (/[\r\n\0]/.test(objects)) throw new GeneralError('authored-invalid-object-location');
  await sourceGit(directory, ['init', '--bare', '--quiet', `--object-format=${format}`]);
  await mkdir(join(directory, 'objects/info'), { recursive: true });
  await writeFile(join(directory, 'objects/info/alternates'), `${objects}\n`);
  await mkdir(join(directory, 'info'), { recursive: true });
  await writeFile(join(directory, 'info/attributes'), NEUTRAL_ATTRIBUTES);
}

/** `git archive | tar -x`: one stream, no per-file process work and no per-file sync. */
async function extractArchive(view: string, tree: string, destination: string): Promise<void> {
  const archive = await spawnSourceGit(view, [
    '-c',
    'tar.umask=022',
    'archive',
    '--format=tar',
    tree,
  ]);
  const tar = spawn('tar', ['-xpf', '-', '-C', destination], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const exited = (
    child: { on: (event: 'close', listener: (code: number | null) => void) => unknown },
    label: string,
    errors: Buffer[]
  ): Promise<void> =>
    new Promise((accept, reject) => {
      child.on('close', (code) => {
        if (code === 0) accept();
        else
          reject(
            new GeneralError(
              `authored-export-failed: ${label}: ${Buffer.concat(errors).toString('utf8').trim()}`
            )
          );
      });
    });
  const archiveErrors: Buffer[] = [];
  const tarErrors: Buffer[] = [];
  archive.stderr.on('data', (chunk: Buffer) => archiveErrors.push(chunk));
  tar.stderr.on('data', (chunk: Buffer) => tarErrors.push(chunk));
  archive.stdin.end();
  tar.stdin.on('error', () => {
    /* Exit handling carries tar's diagnostic. */
  });
  archive.stdout.pipe(tar.stdin);
  const spawnFailure = new Promise<never>((_, reject) => {
    tar.on('error', (error) => {
      reject(toError(error));
    });
  });
  await Promise.race([
    Promise.all([exited(archive, 'git archive', archiveErrors), exited(tar, 'tar', tarErrors)]),
    spawnFailure,
  ]);
}

/**
 * Prove a destination holds exactly a tree's entries: same paths, kinds, executable bits and bytes
 * (blob ids recomputed from disk). `gitDirectory` is any repository of the same object format.
 */
export async function verifyExportedTree(
  gitDirectory: string,
  entries: readonly ExportEntry[],
  destination: string,
  format: SourceObjectFormat
): Promise<void> {
  const expected = new Map(entries.map((entry) => [entry.path, entry]));
  const root = resolve(destination);
  const found: string[] = [];
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (item.isDirectory()) continue;
    const path = relative(root, join(item.parentPath, item.name)).split(sep).join('/');
    if (!expected.has(path)) throw new GeneralError(`authored-export-mismatch: unexpected ${path}`);
    found.push(path);
  }
  if (found.length !== expected.size) {
    const present = new Set(found);
    const missing = entries.find((entry) => !present.has(entry.path));
    throw new GeneralError(`authored-export-mismatch: missing ${missing?.path ?? ''}`);
  }
  const regular: ExportEntry[] = [];
  await mapWithConcurrency([...entries], VERIFY_CONCURRENCY, async (entry) => {
    const target = join(root, entry.path);
    const stat = await lstat(target);
    if (entry.mode === '120000') {
      const link = Buffer.from(await readlink(target));
      if (!stat.isSymbolicLink() || sourceBlobId(link, format) !== entry.blob)
        throw new GeneralError(`authored-export-mismatch: link ${entry.path}`);
      return;
    }
    if (!stat.isFile() || ((stat.mode & 0o111) !== 0) !== (entry.mode === '100755'))
      throw new GeneralError(`authored-export-mismatch: kind or mode ${entry.path}`);
    regular.push(entry);
  });
  if (regular.length === 0) return;
  const hashes = (
    await sourceGit(
      gitDirectory,
      ['hash-object', '--no-filters', '--stdin-paths'],
      regular.map((entry) => JSON.stringify(join(root, entry.path))).join('\n') + '\n'
    )
  )
    .toString('utf8')
    .trim()
    .split('\n');
  regular.forEach((entry, index) => {
    if (hashes[index] !== entry.blob)
      throw new GeneralError(`authored-export-mismatch: bytes ${entry.path}`);
  });
}

/** Export a tree into an empty directory exactly as stored, then verify it byte for byte. */
export async function exportGitTree(
  repository: string,
  tree: string,
  entries: readonly ExportEntry[],
  destination: string
): Promise<void> {
  const format = await objectFormatOf(repository);
  const view = await mkdtemp(join(tmpdir(), 'fireforge-export-'));
  try {
    await createExportView(repository, format, view);
    await extractArchive(view, tree, destination);
    await verifyExportedTree(view, entries, destination, format);
  } finally {
    await rm(view, { recursive: true, force: true });
  }
}
