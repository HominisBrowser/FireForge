// SPDX-License-Identifier: EUPL-1.2
/**
 * Optional Prettier pass over patch-owned `.sys.mjs` modules.
 *
 * Until 0.45.0 no tier of the chain ran Prettier on `.sys.mjs` at all, so
 * module formatting drift was caught by nothing and survived to a human
 * reviewer. Worse, the obvious manual check was misleading in the same
 * direction: a fork's ROOT `.prettierignore` typically excludes `engine/`,
 * so `prettier --check --config engine/.prettierrc.js <engine files>` run
 * from the repo root reports "all files use Prettier code style" for files
 * that fail the identical check run from inside `engine/`. A root-level
 * spot-check falsely refuted a correct reviewer finding on exactly this.
 *
 * This pass therefore runs prettier with `cwd` set to the ENGINE directory,
 * so the engine's own `.prettierrc*` and `.prettierignore` resolve the way
 * they do for anyone working in that tree, and the FireForge result agrees
 * with the operator's own command.
 *
 * Opt-in (`patchLint.prettier`, default `'off'`): it spawns a process per
 * lint and is a new failure surface on queues that never had one. When it
 * is off, formatting is explicitly out of scope for the per-patch tier —
 * that is the contract, not an accident.
 */

import { join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { PatchLintSeverityGate } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';

/** How long prettier gets before the pass gives up (ms). */
const PRETTIER_TIMEOUT_MS = 120_000;

/** Prettier's per-file `--check` failure line. */
const PRETTIER_WARN_LINE = /^\[warn]\s+(.+)$/;

/** Summary lines prettier prints alongside the per-file ones. */
const PRETTIER_SUMMARY_LINE = /^\[warn]\s+(?:Code style issues|Forgot to run)/;

/** Resolved prettier invocation: a binary, or `npx` with a leading arg. */
interface PrettierInvocation {
  command: string;
  prefixArgs: string[];
}

/**
 * Finds prettier, preferring a binary installed in the tree being checked.
 *
 * Order matters: the engine's own `node_modules` is the install whose
 * version matches the engine's config, the project's is the next best
 * guess, and `npx` is the last resort (it can download, so it is never
 * preferred over something already present).
 */
async function resolvePrettier(
  engineDir: string,
  projectRoot: string
): Promise<PrettierInvocation> {
  for (const root of [engineDir, projectRoot]) {
    const candidate = join(root, 'node_modules', '.bin', 'prettier');
    if (await pathExists(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }
  return { command: 'npx', prefixArgs: ['--no-install', 'prettier'] };
}

/**
 * Runs `prettier --check` over `files` from inside the engine directory.
 *
 * @param engineDir - Absolute engine directory; also the `cwd`, which is
 *   what makes the engine's own config and ignore file authoritative
 * @param projectRoot - FireForge project root, for the fallback binary
 * @param files - Engine-relative patch-owned `.sys.mjs` paths
 * @param gate - Severity for reported issues; `'off'` skips the pass
 * @returns One issue per unformatted file, or a single run-level issue when
 *   prettier could not be run at all
 */
export async function invokePatchLintPrettier(
  engineDir: string,
  projectRoot: string,
  files: readonly string[],
  gate: PatchLintSeverityGate
): Promise<PatchLintIssue[]> {
  if (gate === 'off' || files.length === 0) return [];
  const severity = gate === 'error' ? ('error' as const) : ('warning' as const);

  const invocation = await resolvePrettier(engineDir, projectRoot);
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(invocation.command, [...invocation.prefixArgs, '--check', ...files], {
      cwd: engineDir,
      timeout: PRETTIER_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    return [
      {
        file: '(prettier)',
        check: 'prettier-format',
        message:
          `patchLint.prettier is enabled but prettier could not be run (${toError(error).message}). ` +
          'Install prettier in engine/ or the project root, or set "patchLint.prettier": "off".',
        severity,
      },
    ];
  }

  // Exit 0: everything formatted. Exit 1: at least one file differs. Any
  // other code is prettier failing (bad config, unparseable file), which is
  // a different finding and must not be reported as formatting drift.
  if (result.exitCode === 0) return [];
  const output = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode !== 1) {
    return [
      {
        file: '(prettier)',
        check: 'prettier-format',
        message:
          `prettier exited ${String(result.exitCode)} without completing the check: ` +
          output.trim().split('\n').slice(-5).join(' ').slice(0, 400),
        severity,
      },
    ];
  }

  const unformatted = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (PRETTIER_SUMMARY_LINE.test(trimmed)) continue;
    const match = PRETTIER_WARN_LINE.exec(trimmed);
    const file = match?.[1]?.trim();
    if (file !== undefined && file.length > 0) unformatted.add(file);
  }
  if (unformatted.size === 0) {
    verbose('patchLint.prettier: prettier exited 1 but named no file; reporting nothing.');
    return [];
  }

  return [...unformatted].sort().map((file) => ({
    file,
    check: 'prettier-format' as const,
    message:
      `Not formatted per the project's Prettier configuration. Checked from inside engine/, ` +
      `so engine/.prettierrc* and engine/.prettierignore apply — the same command run from the ` +
      `repo root can report a false pass when the root .prettierignore excludes engine/. ` +
      `Fix with "prettier --write ${file}" run from engine/.`,
    severity,
  }));
}
