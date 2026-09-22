// SPDX-License-Identifier: EUPL-1.2
/**
 * Cross-patch lint rule: a test manifest that registers a file a
 * later-ordered patch creates, without declaring the staged dependency.
 *
 * The import kind has had this arm since forward-import shipped. The
 * registration kind never did. `--kind registration` metadata was only ever
 * checked for staleness once declared, so a patch whose `xpcshell.toml`
 * carried `support-files = ["fixtures/*.sqlite"]` for a fixture the next
 * patch creates passed lint in both arms. Declaring the dependency and
 * removing the declaration produced identical silence, so the gap was
 * invisible rather than merely absent.
 *
 * Scope is narrow by default: test-manifest `support-files` only. The
 * carriers whose target resolves without the build system (jar.mn pair
 * lines, moz.build path tokens, test-manifest sections, customElements.js
 * chrome URLs) are opt-in through `patchLint.forwardRegistration:
 * "extended"` (see `patch-lint-forward-registration-extended.ts`), since a
 * queue that predates them can carry such edges on a ratchet and a new
 * error on install would red its gate. The staged-registration declaration
 * remains the documented escape hatch for a deliberate stage.
 */
import { basename, dirname, posix } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { escapeRegex } from '../utils/regex.js';
import {
  findExtendedForwardRegistrations,
  formatRegistrationDeclaration,
  type ForwardRegistration,
  type ForwardRegistrationKind,
  type ForwardRegistrationScope,
} from './patch-lint-forward-registration-extended.js';
import type {
  PatchQueueForwardRegistrationEntry,
  PatchQueueView,
} from './patch-lint-queue-types.js';
import { isLaterOwner } from './patch-lint-staged-registration.js';

/**
 * Manifest basenames whose `support-files` key registers auxiliary files
 * for a test suite. Closed and documented on purpose: a pattern like
 * "anything .toml" would sweep in Cargo and taskcluster manifests, whose
 * `support-files`-shaped keys mean something else entirely.
 */
const TEST_MANIFEST_BASENAMES = new Set([
  'xpcshell.toml',
  'xpcshell.ini',
  'mochitest.toml',
  'mochitest.ini',
  'browser.toml',
  'browser.ini',
  'chrome.toml',
  'chrome.ini',
  'a11y.toml',
  'a11y.ini',
]);

/** True for a path whose basename is a recognised test manifest. */
function isTestManifestPath(path: string): boolean {
  return TEST_MANIFEST_BASENAMES.has(basename(normalizePathSlashes(path)));
}

/** Matches the start of a `support-files` assignment. */
const SUPPORT_FILES_PATTERN = /^\s*support-files\s*=\s*(.*)$/;

/**
 * One `support-files` entry, with the line the patch actually adds it on.
 *
 * The entry alone is not enough for the discharge command the rule prints:
 * `--line` is compared, whitespace-trimmed, against the lines the patch
 * adds, and a synthesised `support-files = ["<entry>"]` only ever matches a
 * manifest whose array is single-line and single-entry. Carrying the source
 * line keeps the remedy and the validation talking about the same text.
 */
export interface SupportFileEntry {
  /** The entry as written inside the manifest (e.g. `fixtures/*.sqlite`). */
  entry: string;
  /** The first added line, whitespace-trimmed, that spells the entry out. */
  line: string;
  /**
   * How many distinct added lines spell it out. Above one, the printed
   * command quotes the first and says so: one declaration covers the file
   * either way, because the declared check keys on file + creates.
   */
  occurrences: number;
}

/**
 * Extracts the `support-files` entries declared in `content`, each paired
 * with the manifest line it is written on.
 *
 * Handles the TOML array on one line and spread over several, and the
 * whitespace-separated `.ini` spelling. Anything else (a computed value, a
 * shape this does not recognise) yields nothing, because a rule that
 * guesses at a manifest it cannot parse refuses correct queues.
 *
 * Quoted tokens are matched per physical line rather than over the whole
 * accumulated array body, so a multi-line array attributes each element to
 * its own line. Entries are deduplicated: a manifest that lists the same
 * file under two per-test sections needs one declaration, not two.
 */
export function extractSupportFileEntries(content: string): SupportFileEntry[] {
  const lines = content.split('\n');
  const order: string[] = [];
  const sourceLines = new Map<string, string[]>();
  const record = (entry: string, source: string): void => {
    let seen = sourceLines.get(entry);
    if (seen === undefined) {
      seen = [];
      sourceLines.set(entry, seen);
      order.push(entry);
    }
    const trimmed = source.trim();
    if (!seen.includes(trimmed)) seen.push(trimmed);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const match = SUPPORT_FILES_PATTERN.exec(raw);
    if (!match) continue;
    const head = match[1] ?? '';
    if (!head.trimStart().startsWith('[')) {
      // `.ini` spelling: whitespace-separated bare paths on one line.
      for (const token of head.split(/\s+/).filter((t) => t.length > 0)) record(token, raw);
      continue;
    }
    // TOML array: walk the physical lines until the closing bracket,
    // bounded so an unterminated array in a malformed manifest cannot walk
    // the file.
    let body = head;
    let scanned = 0;
    let current = raw;
    for (;;) {
      for (const quoted of current.matchAll(/["']([^"']+)["']/g)) {
        if (quoted[1] !== undefined) record(quoted[1], current);
      }
      if (body.includes(']') || i + 1 >= lines.length || scanned >= 200) break;
      i += 1;
      scanned += 1;
      current = lines[i] ?? '';
      body += `\n${current}`;
    }
  }

  return order.map((entry) => {
    const seen = sourceLines.get(entry) ?? [];
    return { entry, line: seen[0] ?? '', occurrences: seen.length };
  });
}

/**
 * Resolves one `support-files` entry, relative to its manifest's directory,
 * into a matcher over engine-relative paths.
 *
 * Only a `*` inside a single path segment is expanded, the shape the
 * downstream report uses (`fixtures/*.sqlite`). `**`, `!` exclusions and
 * absolute `/`-rooted entries return undefined: they either cross directory
 * boundaries or subtract, and a matcher that guessed at them would attribute
 * a creation to the wrong manifest.
 */
export function buildSupportFileMatcher(
  manifestPath: string,
  entry: string
): ((candidate: string) => boolean) | undefined {
  if (entry.startsWith('!') || entry.includes('**') || entry.startsWith('/')) return undefined;
  const resolved = posix.normalize(
    posix.join(normalizePathSlashes(dirname(manifestPath)), normalizePathSlashes(entry))
  );
  if (resolved.startsWith('..')) return undefined;
  if (!resolved.includes('*')) {
    return (candidate): boolean => normalizePathSlashes(candidate) === resolved;
  }
  const pattern = new RegExp(
    `^${resolved
      .split('*')
      .map((part) => escapeRegex(part))
      .join('[^/]*')}$`
  );
  return (candidate): boolean => pattern.test(normalizePathSlashes(candidate));
}

/** True when this patch already declares the staged registration. */
function isDeclared(
  entry: PatchQueueForwardRegistrationEntry,
  manifestPath: string,
  createdPath: string
): boolean {
  return (entry.metadata?.stagedDependencies?.registrations ?? []).some(
    (registration) =>
      normalizePathSlashes(registration.file) === normalizePathSlashes(manifestPath) &&
      normalizePathSlashes(registration.creates) === normalizePathSlashes(createdPath)
  );
}

/**
 * Finds every `support-files` registration a patch introduces that names a
 * file only a later-ordered patch creates, unless the staged dependency is
 * declared.
 *
 * @param ctx - Projected queue in application order
 * @returns One record per (patch, manifest, entry, created file)
 */
function findSupportFileForwardRegistrations(
  ctx: PatchQueueView<PatchQueueForwardRegistrationEntry>
): ForwardRegistration[] {
  const found: ForwardRegistration[] = [];

  for (const entry of ctx.entries) {
    // Both arms: a manifest this patch creates and one it modifies can each
    // introduce a registration line.
    const manifests: Array<[string, string]> = [
      ...entry.newFiles,
      ...entry.modifiedFileAdditions,
    ].filter(([path]) => isTestManifestPath(path));

    for (const [manifestPath, content] of manifests) {
      for (const { entry: raw, line: addedLine, occurrences } of extractSupportFileEntries(
        content
      )) {
        const matches = buildSupportFileMatcher(manifestPath, raw);
        if (matches === undefined) continue;
        for (const later of ctx.entries) {
          // Same predicate the declared-registration arm validates against,
          // tiebreak included: two spellings of "later" would let one rule
          // flag a pair the other considers already satisfied.
          if (!isLaterOwner(later, entry)) continue;
          for (const created of later.createdFiles) {
            if (!matches(created)) continue;
            if (isDeclared(entry, manifestPath, created)) continue;
            found.push({
              patch: entry.filename,
              kind: 'support-files',
              file: manifestPath,
              // `--line` is the line as the patch adds it, which is what the
              // declared arm compares and what `--remove` matches on.
              // Synthesising `support-files = ["<entry>"]` instead only ever
              // matched a single-line single-entry array, so the pasted
              // command left the declaring patch red with
              // staged-dependency-unused.
              line: addedLine,
              token: raw,
              creates: created,
              owner: later.filename,
              occurrences,
              command: formatRegistrationDeclaration(
                entry.filename,
                manifestPath,
                addedLine,
                created,
                later.filename
              ),
            });
          }
        }
      }
    }
  }

  return found;
}

/**
 * Every undeclared forward registration in the queue, over the carriers
 * `scope` selects: `support-files` (the default) or `extended` (adds
 * jar.mn, moz.build, test-manifest sections and customElements.js; see
 * `patch-lint-forward-registration-extended.ts`).
 *
 * @param ctx - Queue in application order
 * @param scope - Which carriers to check
 */
export function collectForwardRegistrations(
  ctx: PatchQueueView<PatchQueueForwardRegistrationEntry>,
  scope: ForwardRegistrationScope = 'support-files'
): ForwardRegistration[] {
  const found = findSupportFileForwardRegistrations(ctx);
  if (scope === 'extended') found.push(...findExtendedForwardRegistrations(ctx));
  return found;
}

const KIND_PHRASES: Record<ForwardRegistrationKind, string> = {
  'support-files': 'as a support file',
  'jar-mn': 'for packaging',
  'moz-build': 'in the build',
  'test-manifest': 'as a test',
  'custom-elements': 'as a custom element',
};

/**
 * Flags every forward registration the queue's scope selects, unless the
 * staged dependency is declared.
 *
 * @param ctx - Projected queue in application order, with its
 *   `forwardRegistration` scope (default `support-files`)
 * @returns One issue per undeclared forward registration
 */
export function lintPatchQueueForwardRegistrations(
  ctx: PatchQueueView<PatchQueueForwardRegistrationEntry> & {
    forwardRegistration?: ForwardRegistrationScope;
  }
): PatchLintIssue[] {
  return collectForwardRegistrations(ctx, ctx.forwardRegistration).map((found) => {
    const ambiguity =
      found.occurrences > 1
        ? ` (the entry is spelled out on ${found.occurrences} added lines here; ` +
          'the first is quoted, and one declaration covers the file either way ' +
          'because the declared check keys on --file and --creates.)'
        : '';
    return {
      file: found.file,
      check: 'forward-registration',
      patches: [found.patch],
      fingerprint: `forward-registration|${found.patch}|${found.file}|${found.token}|${found.creates}|${found.owner}`,
      message:
        `${found.file} in ${found.patch} registers "${found.token}" ${KIND_PHRASES[found.kind]}, ` +
        `but ${found.creates} is created by the later patch ${found.owner}. ` +
        'Applying the queue up to this patch leaves the registration dangling. ' +
        'Reorder the patches so the file is created first, move the registration into ' +
        'the later patch, or declare the intentional staged dependency with: ' +
        found.command +
        ambiguity,
      severity: 'error',
    };
  });
}
