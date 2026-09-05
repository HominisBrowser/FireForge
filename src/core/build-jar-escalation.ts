// SPDX-License-Identifier: EUPL-1.2
/**
 * Decides whether a changed `jar.mn` really forces the pre-test build to
 * escalate from `mach build faster` to a full `mach build`.
 *
 * The 0.41.0 rule was `any changed jar.mn ⇒ full build`, which costs ~10
 * minutes against ~20 s for a chrome-only slice and is paid twice per
 * green/no-change pair on a Furnace-touching slice. A downstream experiment
 * (two clean runs, 2026-08-29, against 0.44.4) showed the rule is over-broad
 * for the common case: a jar-only registration of a new content file added
 * to an existing `dist/bin` manifest was installed by a plain
 * `fireforge build --ui` both times: `faster/install_dist_bin_browser` named
 * the destination, the file landed in `dist/bin/…/content/browser/` and in
 * the `.app` bundle, and a plain `fireforge test` fetched it over
 * `chrome://` at runtime. Neither run escalated, and neither needed to.
 *
 * What the experiment did not exercise, and what therefore still escalates:
 *
 *  - a new `jar.mn` file. The install manifest for a manifest the backend
 *    has never seen does not exist yet, and `mach build faster` consumes
 *    install manifests rather than regenerating the backend that writes
 *    them.
 *  - a manifest whose jar declaration carries a bracketed base-directory
 *    prefix (`[some/dir] name.jar:`), which redirects the install
 *    destination away from the default chrome root. That redirect is the
 *    "non-dist/bin target" half nobody has run.
 *
 * Everything else about the rule is unchanged, and every failure to read or
 * parse a manifest escalates: this narrows a conservative rule, so its
 * error direction stays the slow-but-correct one.
 */

import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { isJarManifestPath } from './build-audit.js';
import type { BuildBaseline } from './build-baseline-types.js';
import { getUntrackedFilesInDir } from './git-status.js';

/**
 * A jar declaration line: an optional bracketed base-directory prefix, then
 * the jar name. Matched at column zero because entry lines inside a section
 * are indented. An indented `foo.jar:` is content, not a declaration.
 */
const JAR_DECLARATION_PATTERN = /^(\[[^\]]*\]\s*)?[^\s[\]]+\.jar:\s*$/;

/** True when the jar declaration redirects the install base directory. */
function declaresNonDefaultBase(line: string): boolean {
  const match = JAR_DECLARATION_PATTERN.exec(line);
  if (!match) return false;
  return match[1] !== undefined;
}

/** Why one changed `jar.mn` still forces a full build. */
export interface JarEscalationCause {
  /** Engine-relative manifest path. */
  path: string;
  /** Operator-facing reason, printed with the escalation notice. */
  reason: string;
}

/** Outcome of {@link evaluateJarManifestEscalation}. */
export interface JarEscalationDecision {
  /** True when at least one changed manifest still needs a full build. */
  escalate: boolean;
  /** One entry per manifest that forces the escalation. */
  causes: JarEscalationCause[];
  /** Manifests the narrowing cleared. Kept for the verbose explanation. */
  cleared: string[];
}

/**
 * True when a changed `jar.mn` is new to the last successful build.
 *
 * Untracked in the engine repo is the reliable signal: a fork's engine tree
 * is a checkout of upstream with patches applied to the worktree, so a
 * manifest a patch created is untracked and one that shipped upstream is
 * tracked. The baseline's fingerprints cannot answer this on their own: they
 * record only the paths that were dirty at the last build, so a clean
 * pre-existing manifest has no entry either.
 */
async function isNewJarManifest(engineDir: string, path: string): Promise<boolean> {
  const untracked = await getUntrackedFilesInDir(engineDir, path);
  return untracked.includes(path);
}

/**
 * Evaluates every changed `jar.mn` against the narrowed rule.
 *
 * @param engineDir - Absolute engine directory
 * @param changedPaths - Engine-relative paths changed since the last
 *   successful build (non-`jar.mn` entries are ignored)
 * @param baseline - Last successful build's baseline (reserved: the
 *   fingerprint map already gated which paths reach here)
 * @returns The escalation decision with per-manifest causes
 */
export async function evaluateJarManifestEscalation(
  engineDir: string,
  changedPaths: readonly string[],
  baseline: BuildBaseline | undefined
): Promise<JarEscalationDecision> {
  void baseline;
  const causes: JarEscalationCause[] = [];
  const cleared: string[] = [];

  for (const path of changedPaths.filter(isJarManifestPath)) {
    let isNew: boolean;
    try {
      isNew = await isNewJarManifest(engineDir, path);
    } catch (error: unknown) {
      // Fail closed: an unanswerable "is this new?" keeps the old rule.
      verbose(
        `jar escalation: could not classify engine/${path} (${toError(error).message}); escalating.`
      );
      causes.push({ path, reason: 'could not determine whether the manifest is new' });
      continue;
    }
    if (isNew) {
      causes.push({ path, reason: 'new jar.mn (no install manifest exists for it yet)' });
      continue;
    }

    let body: string;
    try {
      body = await readText(join(engineDir, path));
    } catch (error: unknown) {
      verbose(
        `jar escalation: could not read engine/${path} (${toError(error).message}); escalating.`
      );
      causes.push({ path, reason: 'manifest could not be read' });
      continue;
    }

    const redirected = body
      .split(/\r?\n/)
      .filter((line) => declaresNonDefaultBase(line))
      .map((line) => line.trim());
    if (redirected.length > 0) {
      causes.push({
        path,
        reason: `jar declaration redirects the install base directory (${redirected[0] ?? ''})`,
      });
      continue;
    }

    cleared.push(path);
  }

  return { escalate: causes.length > 0, causes, cleared };
}

/**
 * Renders the operator-facing escalation notice. Names the manifest and the
 * reason: "a jar.mn changed" is the sentence that made the previous rule
 * impossible to argue with from outside.
 */
export function formatJarEscalationNotice(decision: JarEscalationDecision): string {
  const detail = decision.causes.map((c) => `engine/${c.path} (${c.reason})`).join('; ');
  return (
    `Escalating this pre-test build to a full mach build so new install-manifest destinations ` +
    `are created: ${detail}. A changed jar.mn that merely adds entries to an existing ` +
    `dist/bin manifest no longer escalates.`
  );
}
