// SPDX-License-Identifier: EUPL-1.2
/**
 * The one producer of patch bodies: byte-exact diffs between two trees, and
 * of a working tree against a commit.
 *
 * Output is pinned so the same change gives the same bytes on every host:
 * `a/`/`b/` prefixes, three lines of context, myers with the indent
 * heuristic, full blob ids on every `index` line, no rename detection (a
 * rename is a deletion and an addition), binary files as replayable
 * `GIT binary patch` sections, no external diff or text conversion.
 *
 * A file whose bytes are not valid UTF-8 (a Latin-1 `.properties` file) is
 * diffed as binary too. Git's own binary test only looks for NUL bytes, so
 * it would emit such a file as text, and a text section cannot carry those
 * bytes through anything that decodes it. The result is that every diff
 * from here is valid UTF-8 unless the repository's own attributes force a
 * file to be text.
 */
import { isUtf8 } from 'node:buffer';
import { join } from 'node:path';

import { makeTempDir, remove, writeFile } from '../kernel/fs.js';
import { captureWorktree, emptyTree, readBlobs } from './objects.js';
import { resolveRevision } from './repo.js';
import { chunkPaths, git, GIT_NULL, gitBytes, listPaths } from './run.js';

const DIFF_FORMAT = [
  '-p',
  '--binary',
  '--full-index',
  '--no-renames',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=3',
  '--inter-hunk-context=0',
  '--diff-algorithm=myers',
  '--indent-heuristic',
  `-O${GIT_NULL}`,
];

/**
 * A gitattributes pattern matching exactly one path: anchored, C-quoted, with
 * glob characters escaped. One pass keyed on the source character, so a
 * backslash in the name is escaped for both the glob and the quoting layer.
 */
function literalAttributePattern(path: string): string {
  const escaped = path.replace(/["\\*?[\]]/g, (char) => {
    if (char === '"') return '\\"';
    if (char === '\\') return '\\\\\\\\';
    return `\\\\${char}`;
  });
  return `"/${escaped}"`;
}

async function runDiffTree(
  cwd: string,
  from: string,
  to: string,
  paths: readonly string[] | undefined,
  config: Record<string, string> = {}
): Promise<Buffer> {
  const args = ['diff-tree', '-r', ...DIFF_FORMAT, from, to];
  if (paths === undefined) return gitBytes(args, { cwd, config });
  const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const chunks: Buffer[] = [];
  for (const chunk of chunkPaths(sorted))
    chunks.push(await gitBytes([...args, '--', ...chunk], { cwd, config }));
  return Buffer.concat(chunks);
}

/** Changed paths between two trees one of whose versions is not valid UTF-8. */
async function nonUtf8Paths(
  cwd: string,
  from: string,
  to: string,
  paths: readonly string[] | undefined
): Promise<string[]> {
  const changed = await listPaths(
    ['diff-tree', '-r', '--no-renames', '--name-only', '-z', from, to],
    paths,
    { cwd }
  );
  const blobs = await readBlobs(
    cwd,
    changed.flatMap((path) => [`${from}:${path}`, `${to}:${path}`])
  );
  return changed.filter((path) =>
    [`${from}:${path}`, `${to}:${path}`].some((spec) => {
      const bytes = blobs.get(spec);
      return bytes !== undefined && !isUtf8(bytes);
    })
  );
}

/**
 * The diff from one tree to another, in the pinned format.
 *
 * @param cwd - The repository holding both trees
 * @param from - The old tree-ish
 * @param to - The new tree-ish
 * @param options - `paths` limits the diff
 * @returns The patch bytes; empty when the trees agree
 */
export async function diffTrees(
  cwd: string,
  from: string,
  to: string,
  options: { paths?: readonly string[] } = {}
): Promise<Buffer> {
  const output = await runDiffTree(cwd, from, to, options.paths);
  if (isUtf8(output)) return output;
  const binary = await nonUtf8Paths(cwd, from, to, options.paths);
  if (binary.length === 0) return output;
  const directory = await makeTempDir('fireforge-attributes-');
  try {
    const attributes = join(directory, 'attributes');
    await writeFile(
      attributes,
      binary.map((path) => `${literalAttributePattern(path)} -diff\n`).join(''),
      { durable: false }
    );
    return await runDiffTree(cwd, from, to, options.paths, { 'core.attributesFile': attributes });
  } finally {
    await remove(directory);
  }
}

/**
 * The diff of a working tree against a commit: tracked changes, deletions
 * and untracked files (ignored ones only when named outright), directories
 * expanded. Computed through a private index, so the repository's index
 * does not move.
 *
 * @param cwd - The repository
 * @param options - `paths` limits the diff; `base` (default `HEAD`; an
 *   unborn HEAD is the empty tree)
 * @returns The patch bytes; empty when nothing changed
 */
export async function diffWorktree(
  cwd: string,
  options: { paths?: readonly string[]; base?: string } = {}
): Promise<Buffer> {
  const base =
    options.base === undefined
      ? ((await resolveRevision(cwd, 'HEAD', 'tree')) ?? (await emptyTree(cwd)))
      : (
          await git(['rev-parse', '--verify', '--end-of-options', `${options.base}^{tree}`], {
            cwd,
          })
        ).trim();
  const tree = await captureWorktree(cwd, {
    base,
    ...(options.paths !== undefined && { paths: options.paths }),
  });
  return diffTrees(cwd, base, tree);
}

/**
 * The paths that differ between two tree-ishes, or between a tree-ish and
 * the working tree (untracked files aside) when `to` is omitted.
 *
 * @param cwd - The repository
 * @param from - The old tree-ish
 * @param to - The new tree-ish
 */
export async function changedPaths(cwd: string, from: string, to?: string): Promise<string[]> {
  const args = [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    from,
    ...(to === undefined ? [] : [to]),
  ];
  return (await listPaths(args, undefined, { cwd })).sort();
}
