// SPDX-License-Identifier: EUPL-1.2
/**
 * `mode` and `source`: where the project keeps its owned changes. Patch mode
 * keeps them as a patch queue; source mode keeps them as tracked files under
 * `source.root`, with the upstream identity of every touched upstream file
 * recorded under `source.metadataRoot`.
 */
import { posix } from 'node:path';

import { type Infer, s } from '../../kernel/schema.js';

/** The storage modes a project can be in. */
export const PROJECT_MODES = ['patches', 'source'] as const;

/** One of {@link PROJECT_MODES}. */
export type ProjectMode = (typeof PROJECT_MODES)[number];

/** Top-level directories the tool or the workspace own, which a source root may not claim. */
const RESERVED_ROOTS = [
  'engine',
  '.git',
  '.fireforge',
  'node_modules',
  'patches',
  'secrets',
  'components',
  'configs',
];

/**
 * Why a path cannot be a source directory, or undefined: it must be one
 * canonical spelling of a relative directory (no `.`, `..`, backslash,
 * control character, trailing slash or surrounding whitespace) outside the
 * reserved top-level directories, compared case-insensitively as a
 * case-insensitive file system would.
 */
function directoryProblem(path: string): string | undefined {
  const canonical =
    path !== '' &&
    path.trim() === path &&
    !posix.isAbsolute(path) &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\\\p{Cc}]/u.test(path) &&
    posix.normalize(path) === path &&
    !path.endsWith('/') &&
    !path.split('/').some((part) => part === '.' || part === '..' || foldCase(part) === '.git');
  if (!canonical) return 'must be a canonical relative directory inside the project';
  const top = foldCase(path).split('/')[0] ?? '';
  return RESERVED_ROOTS.includes(top)
    ? `must not be inside the reserved "${top}" directory`
    : undefined;
}

function foldCase(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

const directory = s
  .string({ pattern: /\S/, format: 'a relative directory' })
  .refine(directoryProblem);

/** The `source` section, present exactly when `mode` is `source`. */
export const sourceSection = s
  .object({
    root: directory.describe('Directory whose files supply the engine files of the same path'),
    metadataRoot: directory.describe(
      'Directory holding the upstream identity of every overridden upstream file'
    ),
    pristineCommit: s
      .string({
        pattern: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/,
        format: 'a complete lowercase Git object ID',
      })
      .describe('Commit of the pristine repository the pin resolves to'),
  })
  .refine(({ root, metadataRoot }) => {
    const [a, b] = [foldCase(root), foldCase(metadataRoot)];
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
      ? 'must keep root and metadataRoot apart: neither may contain the other'
      : undefined;
  })
  .describe('Source mode: where the owned files and their upstream records live');

/** The validated `source` section. */
export type SourceConfig = Infer<typeof sourceSection>;

/** The `mode` key. */
export const modeKey = s
  .enum(PROJECT_MODES)
  .describe('Where owned changes live: a patch queue (patches) or tracked files (source)')
  .default('patches');

/**
 * The root-level rule tying `mode` to `source`, for the root schema's
 * `refine`: source mode needs the block, and patch mode refuses a stale one.
 *
 * @param config - The root document, already valid key by key
 */
export function modeProblem(config: {
  mode: ProjectMode;
  source?: SourceConfig;
}): string | undefined {
  if (config.mode === 'source' && config.source === undefined) {
    return 'needs a "source" block when "mode" is "source"';
  }
  if (config.mode === 'patches' && config.source !== undefined) {
    return 'has a "source" block, which applies only when "mode" is "source"';
  }
  return undefined;
}
