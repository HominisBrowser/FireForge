// SPDX-License-Identifier: EUPL-1.2
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { getNodeErrorCode } from '../utils/errors.js';
import { getFileContentAtRef } from './git-file-ops.js';
import { parseDiffSections } from './patch-parse.js';
import { applyPatchTextToContent } from './patch-transform.js';

/** Lint a private text candidate while all unchanged dependencies retain their engine locations. */
export async function withPatchLintCandidate<T>(
  engine: string,
  diff: string,
  run: (candidate: string) => Promise<T>
): Promise<T> {
  const bodies = new Map<string, string | null>();
  for (const section of parseDiffSections(diff)) {
    if (section.isBinary) continue;
    const path = section.targetPath;
    const target = resolve(engine, path);
    if (
      path === '' ||
      path.split('/').includes('.git') ||
      !target.startsWith(resolve(engine) + sep)
    )
      throw new GeneralError('Invalid candidate source path');
    const head = section.isNewFile ? null : await getFileContentAtRef(engine, section.sourcePath);
    bodies.set(path, section.isDeletedFile ? null : applyPatchTextToContent(head, diff, path));
  }
  const scratch = await mkdtemp(join(tmpdir(), 'fireforge-lint-candidate-'));
  try {
    await materializeCandidateDirectory(engine, scratch, '', bodies);
    return await run(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Copy only candidate path spines; unchanged siblings are read-only inputs to lint tools. */
async function materializeCandidateDirectory(
  original: string,
  destination: string,
  relative: string,
  bodies: ReadonlyMap<string, string | null>
): Promise<void> {
  await mkdir(destination, { recursive: true });
  let names: string[] = [];
  try {
    names = await readdir(original);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  const children = new Set(names.filter((name) => name !== '.git'));
  for (const path of bodies.keys()) {
    if (relative !== '' && !path.startsWith(`${relative}/`)) continue;
    const rest = relative === '' ? path : path.slice(relative.length + 1);
    const first = rest.split('/')[0];
    if (first) children.add(first);
  }
  for (const name of children) {
    const path = relative === '' ? name : `${relative}/${name}`;
    const target = join(destination, name);
    if (bodies.has(path)) {
      const body = bodies.get(path);
      if (body !== null && body !== undefined) await writeFile(target, body);
    } else if ([...bodies.keys()].some((file) => file.startsWith(`${path}/`))) {
      try {
        const stat = await lstat(join(original, name));
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new GeneralError('Candidate source ancestor is not a real directory');
      } catch (error: unknown) {
        if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      }
      await materializeCandidateDirectory(join(original, name), target, path, bodies);
    } else {
      await symlink(join(original, name), target);
    }
  }
}
