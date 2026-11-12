// SPDX-License-Identifier: EUPL-1.2
/**
 * Override records and engine paths. An override record at
 * `<metadataRoot>/overrides/<engine path>.json` is the upstream identity of
 * one upstream file the project touches: the pristine commit, blob and mode
 * the touch started from, the component it belongs to, and whether it is an
 * edit (`override`, with the owned bytes at `<sourceRoot>/<path>`) or an
 * explicit deletion (`delete`, a tombstone with no owned file).
 */
import { posix } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { stringifyJson } from '../kernel/json.js';
import { type Infer, s } from '../kernel/schema.js';

/** A git repository holding the pristine commit, read only. */
export interface Pristine {
  readonly repo: string;
  readonly commit: string;
}

/** The modes an owned file may have: regular or executable. */
export type RegularMode = '100644' | '100755';

const objectId = s.string({
  pattern: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/,
  format: 'a complete lowercase Git object ID',
});

/** Component names: they become patch names on export. */
export const COMPONENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** The schema of one override record. */
export const overrideRecordSchema = s
  .object({
    kind: s
      .enum(['override', 'delete'])
      .describe('override: the owned file replaces upstream; delete: upstream is removed'),
    base: s
      .object({
        commit: objectId.describe('The pristine commit the touch started from'),
        blob: objectId.describe('The upstream blob at that commit'),
        mode: s.enum(['100644', '100755']).describe('The upstream mode at that commit'),
      })
      .describe('The upstream identity the touch started from'),
    component: s
      .string({ pattern: COMPONENT_PATTERN, format: 'a component name such as "ui-sidebar"' })
      .describe('The component the change belongs to; one exported patch per component'),
    classification: s
      .enum(['registration', 'exception'])
      .describe('registration: wiring an addition in; exception: a reviewed upstream change'),
    adr: s
      .string({ pattern: /\S/, format: 'a project-relative path' })
      .describe('The decision record approving an exception')
      .optional(),
  })
  .refine((record) =>
    record.classification === 'exception' && record.adr === undefined
      ? 'needs "adr" for an exception'
      : undefined
  );

/** One override record. */
export type OverrideRecord = Infer<typeof overrideRecordSchema>;

/**
 * The bytes of a record file: sorted keys, two-space indent, final newline,
 * so a record is a function of its content.
 *
 * @param record - The record
 */
export function encodeRecord(record: OverrideRecord): string {
  return stringifyJson(record, { sortKeys: true });
}

/**
 * The component a path belongs to when none is named: its top directory (or
 * top-level file), without leading dots or other characters a component name
 * cannot start with.
 *
 * @param path - An engine path
 */
export function defaultComponent(path: string): string {
  const top = (path.split('/')[0] ?? path).replace(/^[^a-zA-Z0-9]+/, '');
  return top === '' ? 'root' : top;
}

/** File names that, under the source root, configure git instead of supplying an engine file. */
const GIT_CONTROL_NAMES = new Set(['.gitattributes', '.gitignore']);

/** Top-level engine paths FireForge itself writes. */
const RESERVED_ENGINE_PATHS = new Set(['mozconfig']);

/**
 * Why a valid engine path cannot be owned, or undefined.
 *
 * @param path - An engine path
 */
export function unownableReason(path: string): string | undefined {
  const name = posix.basename(path);
  if (GIT_CONTROL_NAMES.has(name)) {
    return `is named ${name}, which under the source root would configure git for the owned files instead of supplying an engine file`;
  }
  return RESERVED_ENGINE_PATHS.has(path) ? 'is written by FireForge' : undefined;
}

/**
 * A path folded as a case-insensitive file system compares it.
 *
 * @param path - Any path
 */
export function foldCase(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Why a string cannot be an engine path, or undefined: it must be one
 * canonical relative POSIX spelling with no `.`, `..` or `.git` segment and
 * no backslash or control character.
 *
 * @param path - The candidate
 */
export function enginePathProblem(path: string): string | undefined {
  if (path === '' || posix.isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    return 'is not a relative path';
  }
  if (/[\\\p{Cc}]/u.test(path)) return 'holds a backslash or a control character';
  if (posix.normalize(path) !== path || path.endsWith('/')) return 'is not in canonical form';
  if (path.split('/').some((part) => part === '.' || part === '..' || foldCase(part) === '.git')) {
    return 'has a ".", ".." or ".git" segment';
  }
  return undefined;
}

/**
 * Refuses a string that is not an engine path.
 *
 * @param path - The candidate, as the user typed it
 * @throws `source-invalid-path` (exit code 8)
 */
export function assertEnginePath(path: string): void {
  const problem = enginePathProblem(path);
  if (problem !== undefined) {
    throw new FireForgeError('source-invalid-path', `"${path}" ${problem}.`, {
      exitCode: ExitCode.INVALID_ARGUMENT,
      hint: 'Name the file by its engine path, such as browser/base/jar.mn.',
    });
  }
}

/**
 * The ancestors of a path, outermost first: `a/b/c` gives `a`, `a/b`.
 *
 * @param path - An engine path
 */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** Code-unit order, which no locale changes. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
