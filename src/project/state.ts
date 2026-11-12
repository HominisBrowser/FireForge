// SPDX-License-Identifier: EUPL-1.2
/**
 * The project state document, `.fireforge/state.json`. It is one JSON object
 * of named sections; each module that keeps state declares its section with
 * {@link defineStateSection} and its own schema, and reads and updates only
 * that section. Sections it does not know are carried through untouched.
 *
 * A section that fails its schema is an error naming the section, the key
 * path and the command that repairs it; it is never silently reset. Updates
 * are serialised by a lock, and the file is replaced atomically, so a reader
 * never sees a half-written document and no update is lost.
 */
import { join } from 'node:path';

import { ExitCode, FireForgeError, invariant } from '../kernel/errors.js';
import { readJsonIfExists, writeJson } from '../kernel/json.js';
import { withLock } from '../kernel/lock.js';
import { s, type Schema } from '../kernel/schema.js';
import type { ProjectPaths } from './project.js';

/** One module's part of the state document. */
export interface StateSection<T> {
  /** Top-level key of the section. */
  readonly key: string;
  readonly schema: Schema<T>;
  /** What to run when the section is invalid, such as `fireforge doctor`. */
  readonly repair: string;
}

/**
 * Declares a section of the state document.
 *
 * @param key - Top-level key, unique across modules
 * @param schema - What the section holds
 * @param repair - The command that repairs an invalid section
 */
export function defineStateSection<T>(
  key: string,
  schema: Schema<T>,
  repair: string
): StateSection<T> {
  return { key, schema, repair };
}

type StatePaths = Pick<ProjectPaths, 'state' | 'stateDir'>;

const StateDocument = s.record(s.unknown());

async function readDocument(paths: StatePaths): Promise<Record<string, unknown>> {
  const document = await readJsonIfExists(paths.state, StateDocument, {
    code: 'state-invalid',
    exitCode: ExitCode.CONFIG_ERROR,
    hint: `Move ${paths.state} aside; each command recreates the state it needs.`,
  });
  return document ?? {};
}

function sectionOf<T>(
  paths: StatePaths,
  document: Record<string, unknown>,
  section: StateSection<T>
): T | undefined {
  const raw = document[section.key];
  if (raw === undefined) return undefined;
  const result = section.schema.validate(raw);
  if (result.ok) return result.value;
  const lines = result.issues.map((issue) => {
    const at = issue.path === '' ? '' : issue.path.startsWith('[') ? issue.path : `.${issue.path}`;
    return `"${section.key}${at}" ${issue.message}`;
  });
  throw new FireForgeError('state-invalid', `${paths.state}: ${lines.join('; ')}`, {
    exitCode: ExitCode.CONFIG_ERROR,
    hint: `Run "${section.repair}" to repair it.`,
  });
}

/**
 * Reads one section of the state document.
 *
 * @param project - The project whose state to read
 * @param section - The section
 * @returns The section, or undefined when the document or the section is absent
 * @throws `state-invalid` (exit code 2) when the document or the section is malformed
 */
export async function readState<T>(
  project: { readonly paths: StatePaths },
  section: StateSection<T>
): Promise<T | undefined> {
  return sectionOf(project.paths, await readDocument(project.paths), section);
}

/**
 * Replaces one section of the state document with what `update` returns,
 * under the state lock. Returning undefined removes the section.
 *
 * @param project - The project whose state to update
 * @param section - The section
 * @param update - Receives the current section (undefined when absent) and returns the next
 * @returns The section as written
 * @throws `state-invalid` (exit code 2) when the current document or section is malformed
 */
export async function updateState<T>(
  project: { readonly paths: StatePaths },
  section: StateSection<T>,
  update: (current: T | undefined) => T | undefined
): Promise<T | undefined> {
  const { paths } = project;
  const lock = join(paths.stateDir, 'state.lock');
  return withLock(lock, { label: 'project state' }, async () => {
    const document = await readDocument(paths);
    const next = update(sectionOf(paths, document, section));
    invariant(
      next === undefined || section.schema.validate(next).ok,
      () => `the update of state section "${section.key}" does not match its schema`
    );
    // An undefined value is dropped by serialisation, which removes the section.
    await writeJson(paths.state, { ...document, [section.key]: next });
    return next;
  });
}
