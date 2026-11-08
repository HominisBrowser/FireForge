// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { escapeRegex } from '../../utils/regex.js';
import { readSourceBlobs } from '../authored/git.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import type { CoordinatorConfig } from './schema.js';
import { cloneTree, pathPresent, removeTree } from './slot-template.js';

/** A release's private state in its slot: no audit reads it, and no clone of the slot takes it along. */
const releaseDirectory = (root: string): string => join(root, '.fireforge', 'release');

/** What keeps a release's object directory apart from the slot's development one. */
export const releaseObjdir = (root: string): string => join(releaseDirectory(root), 'obj');

/**
 * The mozconfig a release builds with: the generated one, the project's overlay
 * after it so its options win, and the object directory last.
 */
export const composeReleaseMozconfig = (
  generated: string,
  overlay: string,
  objdir: string
): string =>
  `${generated.trimEnd()}\n\n# Release overlay\n${overlay.trimEnd()}\n\nmk_add_options MOZ_OBJDIR="${objdir}"\n`;

/** The refusal a release's declared inputs earn, before anything runs. */
export async function assertReleaseRecipe(
  snapshot: AuthoredSnapshot,
  config: Pick<CoordinatorConfig, 'releaseSecrets'>
): Promise<void> {
  const release = snapshot.config.build?.release;
  if (release === undefined)
    throw new Error('package --recipe release needs build.release in fireforge.json');
  if (!snapshot.inputs.some((input) => input.path === release.overlay))
    throw new Error(`The release overlay ${release.overlay} was not captured`);
  if (release.secrets === undefined) return;
  if (config.releaseSecrets === undefined)
    throw new Error(
      'This release declares secrets and this host names no directory for them; run: fireforge host init --release-secrets <directory>'
    );
  for (const file of release.secrets.files)
    if (!(await pathPresent(join(config.releaseSecrets, file))))
      throw new Error(`Release secret ${file} is missing from ${config.releaseSecrets}`);
}

/** Every release builds from clean: nothing an earlier release left can reach this one. */
export const clearReleaseObjdir = (root: string): Promise<void> => removeTree(releaseObjdir(root));

/** The paths in a directory one declared output names: itself, or what its last segment's `*` matches. */
async function matchOutput(objdir: string, declared: string): Promise<string[]> {
  const name = posix.basename(declared);
  if (!name.includes('*')) return (await pathPresent(join(objdir, declared))) ? [declared] : [];
  const parent = posix.dirname(declared);
  const pattern = new RegExp(`^${name.split('*').map(escapeRegex).join('.*')}$`);
  const entries = await readdir(join(objdir, parent)).catch((error: unknown) => {
    if (getNodeErrorCode(error) === 'ENOENT') return [] as string[];
    throw error;
  });
  return entries
    .filter((entry) => pattern.test(entry))
    .sort()
    .map((entry) => (parent === '.' ? entry : `${parent}/${entry}`));
}

/**
 * Copies what a release declares as its outputs out of the slot, at the same
 * relative paths, cheaply where the volume clones.
 *
 * @returns The paths copied, relative to `destination`
 * @throws When a declared output matches nothing: a release missing one is not that release
 */
export async function collectReleaseOutputs(
  objdir: string,
  declared: readonly string[],
  destination: string
): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of declared) {
    const matches = await matchOutput(objdir, entry);
    if (matches.length === 0)
      throw new Error(`Release output ${entry} is not in the object directory ${objdir}`);
    for (const path of matches) {
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await cloneTree(join(objdir, path), join(destination, path));
      copied.push(path);
    }
  }
  return copied;
}

/** The identity of a release: everything that decided it, naming no secret's value. */
export interface ReleaseIdentity {
  recipe: 'release';
  sourceId: string;
  pin: string;
  toolchain: string;
  /** The overlay's digest. */
  overlay: string | null;
  objdir: string;
  buildDate: string;
  /** The declared secret files' names. */
  secrets: string[];
}

/** Records what a release was built from. */
export async function releaseIdentity(options: {
  snapshot: AuthoredSnapshot;
  root: string;
  toolchain: string;
  buildDate: string;
}): Promise<ReleaseIdentity> {
  const { snapshot, root, toolchain, buildDate } = options;
  const release = snapshot.config.build?.release;
  const input = snapshot.inputs.find((entry) => entry.path === release?.overlay);
  const overlay =
    input === undefined
      ? undefined
      : (await readSourceBlobs(snapshot.repository, [input.blob])).get(input.blob);
  return {
    recipe: 'release',
    sourceId: snapshot.id,
    pin: snapshot.pin.commit,
    toolchain,
    overlay: overlay === undefined ? null : createHash('sha256').update(overlay).digest('hex'),
    objdir: releaseObjdir(root),
    buildDate,
    secrets: release?.secrets?.files ?? [],
  };
}

/** The overlay as it stands in a slot, which the audit holds to its captured bytes. */
export const readReleaseOverlay = (root: string, overlay: string): Promise<string> =>
  readFile(join(root, overlay), 'utf8');
