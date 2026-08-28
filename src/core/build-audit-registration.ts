// SPDX-License-Identifier: EUPL-1.2
/*
 * Registration-aware artifact resolution for the post-build dist-tree audit.
 *
 * The basename-plus-similarity heuristic in `build-audit-resolve.ts` cannot
 * distinguish two unrelated files that share a source basename: one fork
 * registers `content/mybrowser.js` in `browser/base/jar.mn` (packaged under
 * `chrome/browser/content/browser/mybrowser.js`) while an unrelated patch
 * registers a `mybrowser.js` pref file under `browser/defaults/preferences/`.
 * The basename walker surfaces both, `scoreCandidate` awards them an equal
 * trailing-overlap score, and whichever the directory walk hits first wins.
 *
 * This module anchors resolution to the `(source)` reference inside `jar.mn`.
 * For a source under audit it walks the ancestor directories for an owning
 * `jar.mn`, finds the entry whose `(source)` resolves to that path, and
 * exposes both the registered target and the manifest that owns it. Callers
 * prefer candidates whose dist-tree path ends with the registered target and
 * report an unambiguous "registered but not packaged" miss when none exists.
 *
 * When no jar.mn registration is found, the caller falls back to the
 * similarity heuristic — which covers sources registered through moz.build
 * (`FINAL_TARGET_FILES`, `JS_PREFERENCE_FILES`) or `package-manifest.in`.
 * Parsing every Firefox registration surface would bloat the audit, and the
 * heuristic's weak case is surfaced to the operator in the warning copy.
 */

import { basename, dirname, join, relative, sep } from 'node:path';

import { pathExists, readText } from '../utils/fs.js';
import { findAllByBasename } from './build-audit-resolve.js';

/** Ceiling on ancestor-directory hops when searching for an owning jar.mn. */
const MAX_JAR_MN_SCAN_DEPTH = 8;

/** Parsed jar.mn registration anchored to a specific engine source path. */
export interface RegistrationHit {
  /** Target path extracted from the entry (POSIX). */
  target: string;
  /** Source path from the entry (POSIX, relative to the jar.mn directory). */
  source: string;
  /** Absolute path of the jar.mn that owns the registration. */
  jarManifest: string;
}

/** Result of a registration-aware dist probe. */
export interface RegistrationProbeResult {
  /** Absolute path of the packaged artifact matching the registration target. */
  artifact: string;
  /** The registration entry that anchored the match. */
  hit: RegistrationHit;
}

/**
 * Parses a single jar.mn line into `{ target, source }` when the line is a
 * content entry with an explicit `(source)` reference. Returns undefined
 * for comments, headers (`browser.jar:`), `%` manifest directives, blank
 * lines, and entries without a source reference.
 *
 * Accepted entry shapes:
 *   `        content/browser/foo.js     (content/foo.js)`   bare
 *   `*       content/browser/foo.js     (content/foo.js)`   `*` = preprocessed
 *   `en-US.jar:        content/foo.js  (content/foo.js)`    locale-prefixed
 */
export function parseJarMnEntry(line: string): { target: string; source: string } | undefined {
  if (!line) return undefined;
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('%')) return undefined;
  // Leading `*` (preprocessed) and optional `locale.jar:` prefix are dropped
  // before matching the target/(source) pair. Both are whitespace-separated
  // from the target entry.
  const stripped = trimmed.replace(/^\*\s+/, '').replace(/^[A-Za-z0-9.\-_]+\.jar:\s+/, '');
  const match = /^(\S+)\s+\(([^)]+)\)\s*$/.exec(stripped);
  if (!match) return undefined;
  const target = (match[1] ?? '').trim();
  const source = (match[2] ?? '').trim();
  if (!target || !source) return undefined;
  return { target, source };
}

/**
 * Scans a jar.mn file's contents for an entry whose source reference
 * matches `relativeSource` (POSIX, relative to the jar.mn directory).
 * Returns the first match; jar.mn enforces uniqueness of `(source)` in
 * practice, so a first-match wins behaviour is adequate.
 */
export function findJarMnEntryForSource(
  content: string,
  relativeSource: string
): { target: string; source: string } | undefined {
  const normalized = relativeSource.replace(/\\/g, '/');
  for (const line of content.split('\n')) {
    const parsed = parseJarMnEntry(line);
    if (!parsed) continue;
    if (parsed.source === normalized) return parsed;
  }
  return undefined;
}

/**
 * Walks from the source's directory upward to the engine root, returning
 * the first jar.mn entry that registers the given source. Returns undefined
 * when no ancestor jar.mn claims the source.
 *
 * @param engineDir Absolute engine root; walk halts here.
 * @param source Engine-relative POSIX source path.
 */
export async function findRegisteredTarget(
  engineDir: string,
  source: string
): Promise<RegistrationHit | undefined> {
  const sourceAbs = join(engineDir, source);
  const root = engineDir.replace(/[/\\]+$/, '');
  let current = dirname(sourceAbs);
  let depth = 0;
  while (
    depth <= MAX_JAR_MN_SCAN_DEPTH &&
    (current === root || current.startsWith(`${root}/`) || current.startsWith(`${root}\\`))
  ) {
    const jarMn = join(current, 'jar.mn');
    if (await pathExists(jarMn)) {
      let content: string;
      try {
        content = await readText(jarMn);
      } catch {
        // An unreadable jar.mn contributes no registration hints; the resolver falls
        // through to its other strategies.
        content = '';
      }
      const rel = relative(current, sourceAbs).split(sep).join('/');
      const entry = findJarMnEntryForSource(content, rel);
      if (entry) {
        return { target: entry.target, source: entry.source, jarManifest: jarMn };
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    depth += 1;
  }
  return undefined;
}

/**
 * Normalises an absolute filesystem path to POSIX separators so the
 * suffix comparison against a jar.mn target (always POSIX) is platform-
 * independent.
 */
function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Probes the dist tree for the artifact registered against the given
 * source. Returns the matched candidate and the registration hit that
 * anchored it; undefined when the source has no owning jar.mn or when
 * no same-basename candidate under the search roots ends with the
 * registered target path.
 *
 * Suffix-matching against the target path is intentional: jar.mn targets
 * are relative to the jar root (`browser.jar:`, `toolkit.jar:`), but the
 * dist tree prefixes every entry with a jar-specific directory
 * (`.../chrome/browser/content/browser/…`). The source basename plus the
 * target suffix are unambiguous across every packaging convention we
 * care about.
 *
 * @param engineDir Absolute engine root.
 * @param source Engine-relative POSIX source path.
 * @param searchRoots Absolute roots to probe (dist/, _tests/).
 */
export async function resolveArtifactByRegistration(
  engineDir: string,
  source: string,
  searchRoots: readonly string[]
): Promise<RegistrationProbeResult | undefined> {
  const hit = await findRegisteredTarget(engineDir, source);
  if (!hit) return undefined;
  const name = basename(source);
  const targetSuffix = `/${hit.target.replace(/^\/+/, '')}`;
  const candidates: string[] = [];
  for (const root of searchRoots) {
    const found = await findAllByBasename(root, name);
    candidates.push(...found);
  }
  for (const candidate of candidates) {
    if (toPosix(candidate).endsWith(targetSuffix)) {
      return { artifact: candidate, hit };
    }
  }
  return undefined;
}

/**
 * Returns the absolute paths of every same-basename candidate under the
 * given search roots. Used by the audit to enumerate ALL false-match
 * candidates when the heuristic fallback downgrades to "missing" — the
 * operator needs to see the full set, not just the scorer's pick, to
 * distinguish a registration bug from a genuine packaging drop.
 *
 * @param source Engine-relative POSIX source path.
 * @param searchRoots Absolute roots to scan.
 */
export async function collectSameBasenameCandidates(
  source: string,
  searchRoots: readonly string[]
): Promise<string[]> {
  const name = basename(source);
  const out: string[] = [];
  for (const root of searchRoots) {
    const found = await findAllByBasename(root, name);
    out.push(...found);
  }
  return out;
}
