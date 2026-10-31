// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch body <patch> <file>` prints one file as the patch leaves
 * it: engine HEAD's content (none for a file HEAD lacks) with the patch's
 * section applied. Read-only, with no lock and no engine write.
 *
 * It is the base `re-export --hunks-from` and `--exclude-hunks` place hunks
 * against, so `diff -u <(fireforge patch body <patch> <file>) engine/<file>`
 * writes exactly the hunks a session changed since the last export. For a
 * file the patch creates, `git diff` has no such base: the file is untracked
 * in the engine repository.
 */

import { join } from 'node:path';

import type { Command } from 'commander';

import { getFileContentAtRef } from '../../core/git-file-ops.js';
import { parseDiffSections } from '../../core/patch-parse.js';
import { applyPatchTextToContent } from '../../core/patch-transform.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import { readText } from '../../utils/fs.js';
import { normalizeEngineRelativeInput } from '../re-export-scan.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';

/**
 * Computes the content `file` has once `patch` is applied to engine HEAD.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename, ordinal, or manifest `name`
 * @param rawFile - Engine-relative file path (an `engine/` prefix is accepted)
 * @returns The file's content as the patch leaves it
 */
export async function readPatchBodyFile(
  projectRoot: string,
  identifier: string,
  rawFile: string
): Promise<string> {
  const { paths, manifest } = await requirePatchQueue(projectRoot);
  const target = requirePatchTarget(identifier, manifest.patches);
  const file = normalizeEngineRelativeInput(rawFile, 'file');
  const patchText = await readText(join(paths.patches, target.filename));
  const section = parseDiffSections(patchText).find((entry) => entry.targetPath === file);
  if (section === undefined) {
    throw new InvalidArgumentError(
      `${target.filename} does not touch ${file}. Its files: ` +
        `${target.filesAffected.join(', ') || '(none)'}.`,
      'file'
    );
  }
  if (section.isBinary) {
    throw new InvalidArgumentError(
      `${target.filename} carries ${file} as a binary section; patch body prints text files only.`,
      'file'
    );
  }
  const head = await getFileContentAtRef(paths.engine, file);
  return applyPatchTextToContent(head, patchText, file);
}

/**
 * Registers the `patch body` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchBody(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  parent
    .command('body <patch> <file>')
    .description(
      'Print a file as the patch leaves it (engine HEAD plus the patch section; read-only). ' +
        'Base for --hunks-from: diff -u <(fireforge patch body <patch> <file>) engine/<file>'
    )
    .action(
      withErrorHandling(async (identifier: string, file: string) => {
        process.stdout.write(await readPatchBodyFile(getProjectRoot(), identifier, file));
      })
    );
}
