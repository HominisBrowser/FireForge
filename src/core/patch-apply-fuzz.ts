// SPDX-License-Identifier: EUPL-1.2
/**
 * Fuzz-like patch application with escalating context reduction.
 *
 * Tries an exact `git apply` first, then retries with git's real
 * drift-tolerance knob: `-C<n>` (reduced context matching). `git apply`
 * has NO `--fuzz` option — that flag belongs to GNU `patch(1)`. The
 * original implementation passed `--fuzz=N`, which git rejects with a
 * usage error (exit 129) that the escalation loop swallowed, so every
 * "fuzzy" attempt silently failed and patches that would have applied
 * with context drift were reported as hard conflicts (2026-07-05 review,
 * finding H1; verified against git 2.50). If all context-reduction levels
 * fail, falls through to `git apply --reject` so the user gets `.rej`
 * files for manual resolution.
 *
 * Semantics note: GNU fuzz *fuzzily matches* context; `-C<n>` *ignores*
 * outer context lines instead. Step k maps to `-C(3-k)` (git's default
 * context width is 3), so the final step `-C0` matches on line positions
 * and -/+ content alone — the rough analogue of GNU `--fuzz=3` on a
 * 3-context patch.
 */

import { InvalidArgumentError } from '../errors/base.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { ensureGit } from './git-base.js';

// ── Types ──

export interface FuzzyApplyResult {
  /** Whether the patch was applied successfully. */
  success: boolean;
  /** Context-reduction steps taken (0 = exact match, k = applied with `-C(3-k)`). */
  fuzzFactor: number;
  /** Error description when `success` is false. */
  error?: string;
  /** List of `.rej` files created (when falling through to --reject). */
  rejectFiles?: string[];
}

/** Git's default diff context width — the ceiling for reduction steps. */
const GIT_DEFAULT_CONTEXT = 3;

// ── Implementation ──

/**
 * Attempts to apply a patch with escalating context reduction.
 *
 * 1. `git apply --check` exact, then with `-C2`, `-C1`, `-C0`
 * 2. `git apply` (same flags) at the first passing level
 * 3. Fall through to `git apply --reject` if nothing succeeds
 *
 * @param patchPath - Absolute path to the `.patch` file
 * @param engineDir - Working directory (engine/)
 * @param maxFuzz   - Maximum context-reduction steps to try (default 3,
 *   0 = exact only). Values above 3 are capped: git cannot reduce below
 *   `-C0`.
 * @throws InvalidArgumentError when `maxFuzz` is not a non-negative integer —
 *   a NaN or negative value would silently skip every apply attempt
 *   (including the exact-match one) and fall straight through to `--reject`
 */
export async function applyPatchWithFuzz(
  patchPath: string,
  engineDir: string,
  maxFuzz: number = 3
): Promise<FuzzyApplyResult> {
  if (!Number.isInteger(maxFuzz) || maxFuzz < 0) {
    throw new InvalidArgumentError(
      `maxFuzz must be a non-negative integer, got ${String(maxFuzz)}.`,
      'maxFuzz'
    );
  }

  await ensureGit();

  // Try exact match first, then escalate context reduction.
  const maxSteps = Math.min(maxFuzz, GIT_DEFAULT_CONTEXT);
  for (let step = 0; step <= maxSteps; step++) {
    const contextArgs = step > 0 ? [`-C${String(GIT_DEFAULT_CONTEXT - step)}`] : [];

    const check = await exec('git', ['apply', '--check', ...contextArgs, '--', patchPath], {
      cwd: engineDir,
    });

    if (check.exitCode === 0) {
      // --check passed: apply for real
      const apply = await exec('git', ['apply', ...contextArgs, '--', patchPath], {
        cwd: engineDir,
      });

      if (apply.exitCode === 0) {
        if (step > 0) {
          verbose(
            `Patch applied with reduced context (-C${String(GIT_DEFAULT_CONTEXT - step)}): ${patchPath}`
          );
        }
        return { success: true, fuzzFactor: step };
      }

      // Unlikely: --check passed but apply failed; fall through to next step
      verbose(
        `git apply -C${String(GIT_DEFAULT_CONTEXT - step)} --check passed but apply failed: ${apply.stderr.trim()}`
      );
    }
  }

  // All context-reduction levels failed → generate .rej files for manual resolution
  const rejectResult = await exec('git', ['apply', '--reject', '--', patchPath], {
    cwd: engineDir,
  });

  const errorMessage = rejectResult.stderr.trim() || 'All context-reduction levels failed';

  return {
    success: false,
    fuzzFactor: maxSteps,
    error: errorMessage,
    rejectFiles: extractRejectFiles(rejectResult.stderr),
  };
}

/**
 * Extracts `.rej` file paths from `git apply --reject` stderr.
 *
 * Git's actual output shape (verified against git 2.50):
 *
 *   Applying patch f.txt with 1 reject...
 *   Rejected hunk #1.
 *
 * The reject file is `<file>.rej` next to the target. The previous regex
 * (`Rejected hunk.*to (.+\.rej)`) targeted GNU `patch(1)`'s "saving
 * rejects to file X.rej" phrasing, which git never prints — so
 * `rejectFiles` was always empty and the conflict-summary ".rej files
 * created" hint never fired.
 */
function extractRejectFiles(stderr: string): string[] {
  const rejectFiles: string[] = [];
  for (const line of stderr.split('\n')) {
    const match = /^Applying patch (.+) with \d+ rejects?\.\.\./.exec(line);
    if (match?.[1]) {
      rejectFiles.push(`${match[1]}.rej`);
    }
  }
  return rejectFiles;
}
