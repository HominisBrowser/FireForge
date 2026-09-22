// SPDX-License-Identifier: EUPL-1.2
/**
 * `rebase --dry-run`: replays the patch queue against the engine's base
 * commit without touching `engine/`.
 *
 * The replay runs on a private index seeded from HEAD (`GIT_INDEX_FILE`
 * plus `git read-tree HEAD`) and applies each patch there with
 * `git apply --cached`, in queue order, so a later patch sees what the
 * earlier ones did, exactly as the real loop's worktree does. Each patch
 * walks the same context-reduction ladder as {@link applyPatchWithFuzz}.
 * The worktree and the real index are never written. The private index is
 * deleted when the replay ends.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitError } from '../errors/git.js';
import { exec } from '../utils/process.js';
import { ensureGit } from './git-base.js';
import { assertValidMaxFuzz, contextReductionSteps } from './patch-apply-fuzz.js';

/** A patch to replay, in queue order. */
export interface DryRunPatch {
  filename: string;
  path: string;
}

/** What the real rebase loop would do with one patch. */
export type DryRunVerdict =
  | { filename: string; outcome: 'clean' }
  | { filename: string; outcome: 'reduced-context'; step: number; contextArg: string }
  | {
      filename: string;
      outcome: 'reject';
      /** Files git named as not applying. Empty when stderr named none. */
      files: string[];
      /** git's own explanation, from the exact-context `--check`. */
      detail: string;
    };

/** Result of a full queue replay. */
export interface DryRunReplay {
  verdicts: DryRunVerdict[];
  /**
   * Index of the first reject, or `undefined`. Verdicts after it were
   * computed without that patch applied, so a reject there may cascade from
   * the earlier one rather than be a conflict of its own.
   */
  firstRejectIndex: number | undefined;
}

/**
 * Parses the file names out of `git apply --check` failure output. Git
 * reports a context mismatch as `error: patch failed: <file>:<line>` and
 * `error: <file>: patch does not apply`, and a missing or pre-existing
 * target as `error: <file>: does not exist in index` /
 * `error: <file>: already exists in index`.
 */
export function parseApplyCheckFailures(stderr: string): string[] {
  const files = new Set<string>();
  for (const line of stderr.split('\n')) {
    const failed = /^error: patch failed: (.+):\d+$/.exec(line);
    if (failed?.[1]) {
      files.add(failed[1]);
      continue;
    }
    const named =
      /^error: (.+?): (?:patch does not apply|does not exist in index|already exists in index)$/.exec(
        line
      );
    if (named?.[1]) files.add(named[1]);
  }
  return [...files];
}

/**
 * Replays `patches` onto the engine's HEAD tree in a private index.
 * @param engineDir - Engine repository root
 * @param patches - Patches in queue order
 * @param maxFuzz - Maximum context-reduction steps, as for the real rebase
 * @returns One verdict per patch
 */
export async function replayQueueIndexOnly(
  engineDir: string,
  patches: readonly DryRunPatch[],
  maxFuzz: number
): Promise<DryRunReplay> {
  assertValidMaxFuzz(maxFuzz);
  await ensureGit();

  const scratch = await mkdtemp(join(tmpdir(), 'fireforge-rebase-dry-run-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const seeded = await exec('git', ['read-tree', 'HEAD'], { cwd: engineDir, env });
    if (seeded.exitCode !== 0) {
      throw new GitError(
        seeded.stderr.trim() || 'Could not seed a private index from HEAD',
        'read-tree HEAD'
      );
    }

    const ladder = contextReductionSteps(maxFuzz);
    const verdicts: DryRunVerdict[] = [];
    let firstRejectIndex: number | undefined;

    for (const patch of patches) {
      let verdict: DryRunVerdict | undefined;
      let exactFailure = '';
      for (const [step, contextArgs] of ladder.entries()) {
        const check = await exec(
          'git',
          ['apply', '--cached', '--check', ...contextArgs, '--', patch.path],
          { cwd: engineDir, env }
        );
        if (check.exitCode !== 0) {
          if (step === 0) exactFailure = check.stderr;
          continue;
        }
        const apply = await exec('git', ['apply', '--cached', ...contextArgs, '--', patch.path], {
          cwd: engineDir,
          env,
        });
        if (apply.exitCode !== 0) continue;
        verdict =
          step === 0
            ? { filename: patch.filename, outcome: 'clean' }
            : {
                filename: patch.filename,
                outcome: 'reduced-context',
                step,
                contextArg: contextArgs[0] ?? '',
              };
        break;
      }

      if (verdict === undefined) {
        verdict = {
          filename: patch.filename,
          outcome: 'reject',
          files: parseApplyCheckFailures(exactFailure),
          detail: exactFailure.trim(),
        };
        firstRejectIndex ??= verdicts.length;
      }
      verdicts.push(verdict);
    }

    return { verdicts, firstRejectIndex };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
