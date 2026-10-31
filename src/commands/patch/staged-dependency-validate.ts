// SPDX-License-Identifier: EUPL-1.2
/**
 * Shape validation for `patch staged-dependency --add`.
 *
 * `--creates`/`--file` take engine-relative file paths, while `--owner`
 * takes a patch filename. Accepting all three as arbitrary strings lets a
 * `--creates <patch-name>` mixup produce a declaration nothing can ever
 * discharge, surfacing only later as a `staged-dependency-unused` warning.
 * Refusals here fire only on a clear patch-name shape (slash-free values
 * that end in `.patch` or match a queue patch filename/stem): legitimate
 * engine paths always contain a `/`, so deep paths can never
 * false-positive.
 */
import { join } from 'node:path';

import { extractAddedLinesPerFile } from '../../core/patch-lint-diff.js';
import { patchAddsRegistrationLine } from '../../core/patch-lint-staged-registration.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type { PatchMetadata, PatchStagedRegistration } from '../../types/commands/index.js';
import { pathExists, readText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';

/** The declaration fields common to both staged-dependency kinds. */
interface StagedDependencyShape {
  file: string;
  creates: string;
  owner?: string;
}

function matchQueuePatch(
  value: string,
  queuePatches: readonly PatchMetadata[]
): string | undefined {
  return queuePatches.find(
    (patch) => patch.filename === value || patch.filename === `${value}.patch`
  )?.filename;
}

function refusePatchShapedPath(
  flag: '--creates' | '--file',
  value: string,
  role: string,
  queuePatches: readonly PatchMetadata[]
): void {
  if (value.includes('/')) return;
  const matched = matchQueuePatch(value, queuePatches);
  if (matched === undefined && !value.endsWith('.patch')) return;
  const evidence =
    matched !== undefined ? `matches patch ${matched} in the queue` : 'looks like a patch filename';
  throw new InvalidArgumentError(
    `${flag} takes ${role} (e.g. browser/components/foo/Foo.sys.mjs), not a patch name — ` +
      `"${value}" ${evidence}. If you meant to name the owning patch, pass it with --owner.`,
    flag
  );
}

/**
 * Validates the `--add` declaration fields against the loaded queue.
 * Throws on a clear flag mixup. Warns (only) when `--owner` is
 * well-formed but absent from the queue, because the owner may
 * legitimately be exported moments later and renumbering rewrites owners.
 */
export function validateStagedDependencyAdd(
  dependency: StagedDependencyShape,
  queuePatches: readonly PatchMetadata[]
): void {
  refusePatchShapedPath(
    '--creates',
    dependency.creates,
    'the engine-relative path of the file a later patch creates',
    queuePatches
  );
  refusePatchShapedPath(
    '--file',
    dependency.file,
    'the engine-relative file containing the declaring site inside this patch',
    queuePatches
  );

  const owner = dependency.owner;
  if (owner === undefined) return;
  if (owner.includes('/') || !owner.endsWith('.patch')) {
    throw new InvalidArgumentError(
      `--owner names the owning patch artifact (e.g. 012-infra-foo.patch); ` +
        `"${owner}" does not look like a patch filename. The created file path goes in --creates.`,
      '--owner'
    );
  }
  if (!queuePatches.some((patch) => patch.filename === owner)) {
    warn(
      `--owner ${owner} matches no patch currently in the queue. The declaration only ` +
        'discharges once a patch with exactly this filename creates the --creates path.'
    );
  }
}

/**
 * Warns when a registration's `--line` matches no line the patch body adds
 * to `--file`, compared whitespace-insensitively as the lint compares it.
 * Advisory only: the patch may be re-exported with the line moments later,
 * but until then the lint reports the declaration as
 * `staged-dependency-unused`.
 *
 * @param registration - The declaration being added
 * @param patchesDir - Patches directory holding the target patch body
 * @param patchFilename - The declaring patch
 */
export async function warnRegistrationLineNotAdded(
  registration: PatchStagedRegistration,
  patchesDir: string,
  patchFilename: string
): Promise<void> {
  const patchPath = join(patchesDir, patchFilename);
  if (!(await pathExists(patchPath))) return;
  const added = extractAddedLinesPerFile(await readText(patchPath)).get(registration.file) ?? [];
  const additions = new Map([[registration.file, added.join('\n')]]);
  if (
    patchAddsRegistrationLine(
      { newFiles: new Map(), modifiedFileAdditions: additions },
      registration.file,
      registration.line
    )
  ) {
    return;
  }
  warn(
    `--line matches no line ${patchFilename} adds to ${registration.file} ` +
      '(compared whitespace-insensitively). The declaration is written, but lint reports it as ' +
      'staged-dependency-unused until the patch adds that line: copy the line from the patch ' +
      'hunk, or re-export the patch first.'
  );
}
