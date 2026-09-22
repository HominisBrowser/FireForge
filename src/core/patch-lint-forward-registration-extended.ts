// SPDX-License-Identifier: EUPL-1.2
/**
 * The opt-in arms of the `forward-registration` rule
 * (`patchLint.forwardRegistration: "extended"`).
 *
 * The default rule covers test-manifest `support-files` only. These arms
 * cover the carriers whose target resolves WITHOUT the build system:
 *
 * - a jar.mn pair line: the packaged source is on the line, in parentheses,
 *   relative to the jar.mn directory (or `/`-rooted at the source root);
 * - a moz.build path token (a quoted string with a `.` or `/`), relative to
 *   the moz.build directory (or `/`-rooted);
 * - a test manifest's section header (`["browser_foo.js"]`) and `head`,
 *   relative to the manifest directory;
 * - a `customElements.js` `chrome://<pkg>/content/<path>` URL, resolved
 *   through the jar.mn lines the same queue adds (`content/<pkg>/<path>`
 *   is the jar target that URL serves).
 *
 * Anything else stays silent: a preprocessor or locale substitution, a
 * `**` or `!` pattern, a path that climbs out of the tree, a chrome URL no
 * queue jar.mn line packages. A rule that guessed there would refuse
 * correct queues on a Firefox-sized tree.
 *
 * Opt-in because a queue that predates it can carry many such edges on a
 * ratchet, and a new error on install would red a `--max-warnings 0` gate.
 */
import { basename, dirname, posix } from 'node:path';

import { normalizePathSlashes } from '../utils/paths.js';
import { escapeRegex } from '../utils/regex.js';
import { parseJarMnEntry } from './build-audit-registration.js';
import type {
  PatchQueueForwardRegistrationEntry,
  PatchQueueView,
} from './patch-lint-queue-types.js';
import { isLaterOwner, quoteRegistrationLine } from './patch-lint-staged-registration.js';

/** Which carriers `forward-registration` checks. */
export type ForwardRegistrationScope = 'support-files' | 'extended';

/** The carrier kind a forward registration was found in. */
export type ForwardRegistrationKind =
  'support-files' | 'jar-mn' | 'moz-build' | 'test-manifest' | 'custom-elements';

/** One undeclared forward registration: a line naming a file a later patch creates. */
export interface ForwardRegistration {
  /** The patch that adds the registration line. */
  patch: string;
  /** Carrier kind. */
  kind: ForwardRegistrationKind;
  /** Engine-relative path of the carrier file (the manifest, jar.mn, …). */
  file: string;
  /** The added line, whitespace-trimmed, that names the target. */
  line: string;
  /** The token on that line that names the target, as written. */
  token: string;
  /** Engine-relative path of the file the later patch creates. */
  creates: string;
  /** The later patch that creates it. */
  owner: string;
  /** How many distinct added lines in the carrier name the same target. */
  occurrences: number;
  /** Paste-and-run declaration that records the stage as intentional. */
  command: string;
}

/** A registration line resolved to the engine paths it names. */
interface RegistrationReference {
  kind: Exclude<ForwardRegistrationKind, 'support-files'>;
  file: string;
  line: string;
  token: string;
  matches: (candidate: string) => boolean;
  /** The exact path named, when the token has no wildcard (index lookup). */
  exact?: string;
}

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

/**
 * Resolves a path token against a base directory into a matcher. A leading
 * `/` is rooted at the source tree. Only a `*` inside one segment is
 * expanded. Substitutions (`%`, `@`), `**`, `!` and paths that climb out of
 * the tree resolve to nothing.
 */
function resolvePathToken(
  baseDir: string,
  token: string
): Pick<RegistrationReference, 'matches' | 'exact'> | undefined {
  if (/[%@!\s]/.test(token) || token.includes('**')) return undefined;
  const joined = token.startsWith('/')
    ? posix.normalize(token.slice(1))
    : posix.normalize(posix.join(baseDir, normalizePathSlashes(token)));
  if (joined.startsWith('..') || joined === '.' || joined.length === 0) return undefined;
  if (!joined.includes('*')) {
    return { exact: joined, matches: (candidate) => candidate === joined };
  }
  const pattern = new RegExp(
    `^${joined
      .split('*')
      .map((part) => escapeRegex(part))
      .join('[^/]*')}$`
  );
  return { matches: (candidate) => pattern.test(candidate) };
}

function carrierDir(file: string): string {
  const dir = normalizePathSlashes(dirname(file));
  return dir === '.' ? '' : dir;
}

function jarMnReferences(file: string, content: string): RegistrationReference[] {
  const refs: RegistrationReference[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseJarMnEntry(raw);
    if (!parsed) continue;
    const resolved = resolvePathToken(carrierDir(file), parsed.source);
    if (resolved)
      refs.push({ kind: 'jar-mn', file, line: raw.trim(), token: parsed.source, ...resolved });
  }
  return refs;
}

function mozBuildReferences(file: string, content: string): RegistrationReference[] {
  const refs: RegistrationReference[] = [];
  for (const raw of content.split('\n')) {
    if (raw.trimStart().startsWith('#')) continue;
    for (const quoted of raw.matchAll(/["']([^"']+)["']/g)) {
      const token = quoted[1] ?? '';
      // A path names a file: it has an extension or a directory. Bare words
      // ("Firefox", a define's value) are not paths.
      if (!token.includes('.') && !token.includes('/')) continue;
      const resolved = resolvePathToken(carrierDir(file), token);
      if (resolved) refs.push({ kind: 'moz-build', file, line: raw.trim(), token, ...resolved });
    }
  }
  return refs;
}

function testManifestReferences(file: string, content: string): RegistrationReference[] {
  const refs: RegistrationReference[] = [];
  for (const raw of content.split('\n')) {
    const section = /^\s*\[\s*["']?([^"'\]]+?)["']?\s*\]\s*$/.exec(raw);
    const head = /^\s*head\s*=\s*["']?([^"'\s]+)["']?\s*$/.exec(raw);
    const token = section?.[1] ?? head?.[1];
    if (token === undefined || token === 'DEFAULT') continue;
    const resolved = resolvePathToken(carrierDir(file), token);
    if (resolved) refs.push({ kind: 'test-manifest', file, line: raw.trim(), token, ...resolved });
  }
  return refs;
}

/**
 * jar target → packaged source, over every jar.mn line the queue adds. Only
 * exact (wildcard-free) sources can back a chrome URL lookup.
 */
function buildJarTargetIndex(
  entries: readonly PatchQueueForwardRegistrationEntry[]
): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of entries) {
    for (const [file, content] of [...entry.newFiles, ...entry.modifiedFileAdditions]) {
      if (basename(normalizePathSlashes(file)) !== 'jar.mn') continue;
      for (const raw of content.split('\n')) {
        const parsed = parseJarMnEntry(raw);
        if (!parsed) continue;
        const resolved = resolvePathToken(carrierDir(file), parsed.source);
        if (resolved?.exact !== undefined) index.set(parsed.target, resolved.exact);
      }
    }
  }
  return index;
}

function customElementsReferences(
  file: string,
  content: string,
  jarTargets: ReadonlyMap<string, string>
): RegistrationReference[] {
  const refs: RegistrationReference[] = [];
  for (const raw of content.split('\n')) {
    for (const url of raw.matchAll(/chrome:\/\/([\w.-]+)\/content\/([^"'\s)]+)/g)) {
      const source = jarTargets.get(`content/${url[1] ?? ''}/${url[2] ?? ''}`);
      if (source === undefined) continue;
      refs.push({
        kind: 'custom-elements',
        file,
        line: raw.trim(),
        token: url[0],
        exact: source,
        matches: (candidate) => candidate === source,
      });
    }
  }
  return refs;
}

function referencesFor(
  entry: PatchQueueForwardRegistrationEntry,
  jarTargets: ReadonlyMap<string, string>
): RegistrationReference[] {
  const refs: RegistrationReference[] = [];
  for (const [rawPath, content] of [...entry.newFiles, ...entry.modifiedFileAdditions]) {
    const file = normalizePathSlashes(rawPath);
    const name = basename(file);
    if (name === 'jar.mn') refs.push(...jarMnReferences(file, content));
    else if (name === 'moz.build') refs.push(...mozBuildReferences(file, content));
    else if (TEST_MANIFEST_BASENAMES.has(name)) refs.push(...testManifestReferences(file, content));
    else if (name === 'customElements.js') {
      refs.push(...customElementsReferences(file, content, jarTargets));
    }
  }
  return refs;
}

function isDeclared(
  entry: PatchQueueForwardRegistrationEntry,
  file: string,
  created: string
): boolean {
  return (entry.metadata?.stagedDependencies?.registrations ?? []).some(
    (registration) =>
      normalizePathSlashes(registration.file) === file &&
      normalizePathSlashes(registration.creates) === created
  );
}

/** The discharge command, in the exact shape the support-files arm prints. */
export function formatRegistrationDeclaration(
  patch: string,
  file: string,
  line: string,
  creates: string,
  owner: string
): string {
  return (
    `fireforge patch staged-dependency ${patch} --add --kind registration ` +
    `--file ${file} --line "${quoteRegistrationLine(line)}" ` +
    `--creates ${creates} --owner ${owner}`
  );
}

/**
 * Finds every undeclared forward registration in the extended carriers:
 * a registration line a patch adds that names a file only a later-ordered
 * patch creates. Creators come from `createdFiles` (the `new file mode`
 * sections), never `filesAffected`.
 *
 * @param ctx - Queue in application order
 * @returns One record per (patch, carrier, created file), first line quoted
 */
export function findExtendedForwardRegistrations(
  ctx: PatchQueueView<PatchQueueForwardRegistrationEntry>
): ForwardRegistration[] {
  const jarTargets = buildJarTargetIndex(ctx.entries);
  const creatorsByPath = new Map<string, PatchQueueForwardRegistrationEntry[]>();
  for (const entry of ctx.entries) {
    for (const created of entry.createdFiles) {
      const path = normalizePathSlashes(created);
      const list = creatorsByPath.get(path) ?? [];
      list.push(entry);
      creatorsByPath.set(path, list);
    }
  }

  const found = new Map<string, ForwardRegistration>();
  const linesByKey = new Map<string, Set<string>>();
  for (const entry of ctx.entries) {
    for (const ref of referencesFor(entry, jarTargets)) {
      const candidates =
        ref.exact !== undefined
          ? (creatorsByPath.get(ref.exact) ?? []).map((owner) => [ref.exact ?? '', owner] as const)
          : [...creatorsByPath].flatMap(([path, owners]) =>
              ref.matches(path) ? owners.map((owner) => [path, owner] as const) : []
            );
      for (const [created, later] of candidates) {
        if (!isLaterOwner(later, entry)) continue;
        if (isDeclared(entry, ref.file, created)) continue;
        const key = `${entry.filename}|${ref.file}|${created}|${later.filename}`;
        const existing = found.get(key);
        if (existing !== undefined) {
          const lines = linesByKey.get(key) ?? new Set<string>();
          lines.add(ref.line);
          linesByKey.set(key, lines);
          existing.occurrences = lines.size;
          continue;
        }
        linesByKey.set(key, new Set([ref.line]));
        found.set(key, {
          patch: entry.filename,
          kind: ref.kind,
          file: ref.file,
          line: ref.line,
          token: ref.token,
          creates: created,
          owner: later.filename,
          occurrences: 1,
          command: formatRegistrationDeclaration(
            entry.filename,
            ref.file,
            ref.line,
            created,
            later.filename
          ),
        });
      }
    }
  }
  return [...found.values()];
}
