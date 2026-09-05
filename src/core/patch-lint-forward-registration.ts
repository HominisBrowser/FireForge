// SPDX-License-Identifier: EUPL-1.2
/**
 * Cross-patch lint rule: a test manifest that registers a file a
 * LATER-ordered patch creates, without declaring the staged dependency.
 *
 * The import kind has had this arm since forward-import shipped; the
 * registration kind never did. `--kind registration` metadata was only ever
 * checked for STALENESS once declared, so a patch whose `xpcshell.toml`
 * carried `support-files = ["fixtures/*.sqlite"]` for a fixture the next
 * patch creates passed lint in both arms — declaring the dependency and
 * removing the declaration produced identical silence, which is what made
 * the gap invisible rather than merely absent.
 *
 * Scope is deliberately narrow: test-manifest `support-files` only. A
 * jar.mn packaging line or an actor/customElements registration names its
 * target through indirection the linter cannot resolve without the build
 * system, and a rule that guesses there would refuse correct queues on a
 * Firefox-sized tree. The staged-registration declaration remains the
 * documented escape hatch for a deliberate stage.
 */
import { basename, dirname, posix } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { escapeRegex } from '../utils/regex.js';
import type {
  PatchQueueForwardRegistrationEntry,
  PatchQueueView,
} from './patch-lint-queue-types.js';
import { isLaterOwner, quoteRegistrationLine } from './patch-lint-staged-registration.js';

/**
 * Manifest basenames whose `support-files` key registers auxiliary files
 * for a test suite. Closed and documented on purpose — a pattern like
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
 * ADDS, and a synthesised `support-files = ["<entry>"]` only ever matches a
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
 * whitespace-separated `.ini` spelling. Anything else — a computed value, a
 * shape this does not recognise — yields nothing, because a rule that
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
 * Only a `*` inside a single path segment is expanded — the shape the
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
 * Flags every `support-files` registration a patch introduces that names a
 * file only a later-ordered patch creates, unless the staged dependency is
 * declared.
 *
 * @param ctx - Projected queue in application order
 * @returns One issue per undeclared forward registration
 */
export function lintPatchQueueForwardRegistrations(
  ctx: PatchQueueView<PatchQueueForwardRegistrationEntry>
): PatchLintIssue[] {
  const issues: PatchLintIssue[] = [];

  for (const entry of ctx.entries) {
    // Both arms: a manifest this patch CREATES and one it MODIFIES can each
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
        // `--line` is the line as the patch adds it, which is what the
        // declared arm compares and what `--remove` matches on. Synthesising
        // `support-files = ["<entry>"]` instead only ever matched a
        // single-line single-entry array, so the pasted command left the
        // declaring patch red with staged-dependency-unused.
        const declaredLine = quoteRegistrationLine(addedLine);
        const ambiguity =
          occurrences > 1
            ? ` (the entry is spelled out on ${occurrences} added lines here; ` +
              'the first is quoted, and one declaration covers the file either way ' +
              'because the declared check keys on --file and --creates.)'
            : '';
        for (const later of ctx.entries) {
          // Same predicate the declared-registration arm validates against,
          // tiebreak included: two spellings of "later" would let one rule
          // flag a pair the other considers already satisfied.
          if (!isLaterOwner(later, entry)) continue;
          for (const created of later.createdFiles) {
            if (!matches(created)) continue;
            if (isDeclared(entry, manifestPath, created)) continue;
            issues.push({
              file: manifestPath,
              check: 'forward-registration',
              patches: [entry.filename],
              fingerprint: `forward-registration|${entry.filename}|${manifestPath}|${raw}|${created}|${later.filename}`,
              message:
                `${manifestPath} in ${entry.filename} registers "${raw}" as a support file, ` +
                `but ${created} is created by the later patch ${later.filename}. ` +
                'Applying the queue up to this patch leaves the registration dangling. ' +
                'Reorder the patches so the file is created first, move the registration into ' +
                'the later patch, or declare the intentional staged dependency with: ' +
                `fireforge patch staged-dependency ${entry.filename} --add --kind registration ` +
                `--file ${manifestPath} --line "${declaredLine}" ` +
                `--creates ${created} --owner ${later.filename}` +
                ambiguity,
              severity: 'error',
            });
          }
        }
      }
    }
  }

  return issues;
}
