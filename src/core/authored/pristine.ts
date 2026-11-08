// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import type { FirefoxConfig } from '../../types/config.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { getProjectPaths, loadConfig } from '../config.js';
import { downloadFirefoxSource } from '../firefox.js';
import { getHead, initRepository } from '../git.js';
import { isObjectId, sourceGit } from './git.js';
import { requireAuthoredConfig } from './provider.js';

/** Written into every donor, in the form `authored refresh --new-pin` reads. */
export const PRISTINE_PIN_FILE = 'fireforge-pin.json';
/** One archive always yields one commit, so hosts importing it agree on the pin. */
const ARCHIVE_COMMIT_DATE = '2000-01-01T00:00:00Z';

export interface PristineDonor {
  repository: string;
  commit: string;
  firefox: FirefoxConfig;
  origin: 'repository' | 'archive';
}

/** Copy one commit's object closure; the source repository is only read. */
async function fetchFromRepository(from: string, commit: string, output: string): Promise<void> {
  const remote = existsSync(from) ? resolve(from) : from;
  await sourceGit(output, [
    'init',
    '--bare',
    '--quiet',
    `--object-format=${commit.length === 40 ? 'sha1' : 'sha256'}`,
  ]);
  await sourceGit(output, ['fetch', '--quiet', '--no-tags', '--depth=1', remote, commit]);
  await sourceGit(output, ['update-ref', `refs/fireforge/pristine/${commit}`, commit]);
}

/** Every file and link under `root`, relative to it. */
async function listFilesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

/**
 * The commit is the source of record for every slot, so it must hold what the
 * archive holds, whatever upstream's own `.gitignore` hides from a plain add.
 */
async function assertTreeHoldsArchive(
  tree: string,
  commit: string,
  archived: readonly string[]
): Promise<void> {
  const listed = (await sourceGit(tree, ['ls-tree', '-r', '-z', '--name-only', commit]))
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const committed = new Set(listed);
  const missing = archived.filter((path) => !committed.has(path));
  if (missing.length > 0)
    throw new GeneralError(
      `authored-pristine-archive-mismatch: ${missing.length} archive file(s) are not in the imported tree, first ${missing[0] ?? ''}`
    );
  // The one file the import adds: mach lint needs an ignore file by that name.
  const known = new Set(archived);
  const added = listed.filter((path) => !known.has(path) && path !== '.hgignore');
  if (added.length > 0)
    throw new GeneralError(
      `authored-pristine-archive-mismatch: the imported tree holds ${added.length} file(s) the archive does not, first ${added[0] ?? ''}`
    );
}

/** Import a verified archive as a bare repository whose one commit is a function of its tree. */
async function importArchive(
  projectRoot: string,
  firefox: FirefoxConfig,
  output: string
): Promise<string> {
  const tree = `${output}-tree`;
  try {
    await downloadFirefoxSource({
      version: firefox.version,
      product: firefox.product,
      candidate: firefox.candidate,
      expectedSha256: firefox.sha256,
      destDir: tree,
      cacheDir: join(getProjectPaths(projectRoot).fireforgeDir, 'cache'),
    });
    const archived = await listFilesUnder(tree);
    const dated = {
      GIT_AUTHOR_DATE: process.env['GIT_AUTHOR_DATE'],
      GIT_COMMITTER_DATE: process.env['GIT_COMMITTER_DATE'],
    };
    process.env['GIT_AUTHOR_DATE'] = ARCHIVE_COMMIT_DATE;
    process.env['GIT_COMMITTER_DATE'] = ARCHIVE_COMMIT_DATE;
    try {
      await initRepository(tree, 'main', { includeIgnored: true });
    } finally {
      for (const [key, value] of Object.entries(dated))
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
    }
    const commit = await getHead(tree);
    await assertTreeHoldsArchive(tree, commit, archived);
    await rm(output, { recursive: true, force: true });
    await rename(join(tree, '.git'), output);
    await sourceGit(output, ['config', 'core.bare', 'true']);
    return commit;
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
}

/**
 * Create a standalone pristine donor outside the checkout, for a new host or a new pin: from a
 * repository holding the commit (`from`), or from the Firefox archive the pin names.
 */
export async function fetchPristineDonor(options: {
  projectRoot: string;
  destination: string;
  from?: string;
  /** Another pin than the project's own: what a refresh proposal targets. */
  pin?: { firefox: FirefoxConfig; commit?: string };
}): Promise<PristineDonor> {
  const root = resolve(options.projectRoot);
  const destination = resolve(options.destination);
  if (destination === root || destination.startsWith(root + sep))
    throw new GeneralError('authored-pristine-destination: use a directory outside this project');
  const config = await loadConfig(root);
  const firefox = options.pin?.firefox ?? config.firefox;
  // A project still on a queue has no pin yet: this is how it gets one to migrate to.
  const expected = options.pin
    ? options.pin.commit
    : config.sources && requireAuthoredConfig(config).pristineCommit;
  if (expected !== undefined && !isObjectId(expected))
    throw new GeneralError('authored-invalid-pristine-commit');
  if ((await readdir(destination).catch(() => [])).length)
    throw new GeneralError(`authored-pristine-destination-not-empty: ${destination}`);
  await mkdir(dirname(destination), { recursive: true });
  const output = `${destination}.fetch-${randomUUID()}`;
  await mkdir(output);
  try {
    let commit: string;
    if (options.from !== undefined) {
      if (expected === undefined)
        throw new GeneralError('authored-pristine-commit-required: --from needs a pin with commit');
      await fetchFromRepository(options.from, expected, output);
      commit = expected;
    } else {
      commit = await importArchive(root, firefox, output);
      if (expected !== undefined && commit !== expected)
        throw new GeneralError(
          `authored-pristine-pin-unreproducible: the archive imports as ${commit}, not the pinned ${expected}. Pass --from <repository> holding the pinned commit.`
        );
    }
    await writeFile(
      join(output, PRISTINE_PIN_FILE),
      JSON.stringify({ firefox, commit }, null, 2) + '\n'
    );
    await rmdir(destination).catch((error: unknown) => {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    });
    await rename(output, destination);
    return {
      repository: destination,
      commit,
      firefox,
      origin: options.from !== undefined ? 'repository' : 'archive',
    };
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
