// SPDX-License-Identifier: EUPL-1.2
/**
 * Shape validation for `patch staged-dependency --add` (FORGE K10).
 *
 * `--creates`/`--file` take engine-relative FILE paths and `--owner`
 * takes a patch FILENAME, but all three were accepted as arbitrary
 * strings — a `--creates <patch-name>` mixup produced a declaration
 * nothing could ever discharge, surfacing only later as a
 * `staged-dependency-unused` warning. Refusals here fire only on a clear
 * patch-name shape (slash-free values that end in `.patch` or match a
 * queue patch filename/stem): legitimate engine paths always contain a
 * `/`, so deep paths can never false-positive.
 */
import { InvalidArgumentError } from '../../errors/base.js';
import type { PatchMetadata } from '../../types/commands/index.js';
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
 * Throws on a clear flag mixup; warns (only) when `--owner` is
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
