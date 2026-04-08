// SPDX-License-Identifier: EUPL-1.2
/**
 * Fuzzy patch application with escalating fuzz factors.
 *
 * Tries an exact `git apply` first, then retries with increasing `--fuzz=N`
 * values.  If all fuzz levels fail, falls through to `git apply --reject`
 * so the user gets `.rej` files for manual resolution.
 */

import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { ensureGit } from './git-base.js';

// ── Types ──

export interface FuzzyApplyResult {
  /** Whether the patch was applied successfully. */
  success: boolean;
  /** Fuzz factor that succeeded (0 = exact match). */
  fuzzFactor: number;
  /** Error description when `success` is false. */
  error?: string;
  /** List of `.rej` files created (when falling through to --reject). */
  rejectFiles?: string[];
}

// ── Implementation ──

/**
 * Attempts to apply a patch with escalating fuzz factors.
 *
 * 1. `git apply --check` at fuzz 0 … maxFuzz
 * 2. `git apply --fuzz=N` at the first passing level
 * 3. Fall through to `git apply --reject` if nothing succeeds
 *
 * @param patchPath - Absolute path to the `.patch` file
 * @param engineDir - Working directory (engine/)
 * @param maxFuzz   - Maximum fuzz factor to try (default 3)
 */
export async function applyPatchWithFuzz(
  patchPath: string,
  engineDir: string,
  maxFuzz: number = 3
): Promise<FuzzyApplyResult> {
  await ensureGit();

  // Try exact match first, then escalate
  for (let fuzz = 0; fuzz <= maxFuzz; fuzz++) {
    const fuzzArgs = fuzz > 0 ? [`--fuzz=${fuzz}`] : [];

    const check = await exec('git', ['apply', '--check', ...fuzzArgs, '--', patchPath], {
      cwd: engineDir,
    });

    if (check.exitCode === 0) {
      // --check passed: apply for real
      const apply = await exec('git', ['apply', ...fuzzArgs, '--', patchPath], {
        cwd: engineDir,
      });

      if (apply.exitCode === 0) {
        if (fuzz > 0) {
          verbose(`Patch applied with fuzz=${fuzz}: ${patchPath}`);
        }
        return { success: true, fuzzFactor: fuzz };
      }

      // Unlikely: --check passed but apply failed; fall through to next fuzz
      verbose(`git apply fuzz=${fuzz} --check passed but apply failed: ${apply.stderr.trim()}`);
    }
  }

  // All fuzz levels failed → generate .rej files for manual resolution
  const rejectResult = await exec('git', ['apply', '--reject', '--', patchPath], {
    cwd: engineDir,
  });

  const errorMessage = rejectResult.stderr.trim() || 'All fuzz levels failed';

  // Extract .rej file paths from stderr
  const rejectFiles: string[] = [];
  for (const line of rejectResult.stderr.split('\n')) {
    const match = line.match(/Applying patch .* with (\d+) reject/);
    if (match) continue;
    const rejMatch = line.match(/Rejected hunk.*to (.+\.rej)/);
    if (rejMatch?.[1]) {
      rejectFiles.push(rejMatch[1]);
    }
  }

  return {
    success: false,
    fuzzFactor: maxFuzz,
    error: errorMessage,
    rejectFiles,
  };
}
