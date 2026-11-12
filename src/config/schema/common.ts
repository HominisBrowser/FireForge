// SPDX-License-Identifier: EUPL-1.2
/**
 * Field schemas several sections of `fireforge.json` share. Schemas are
 * immutable values: `describe`, `optional` and `default` return new ones.
 */
import { isAbsolute } from 'node:path';

import { toError } from '../../kernel/errors.js';
import { isInside } from '../../kernel/fs.js';
import { s, type Schema } from '../../kernel/schema.js';

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

/**
 * Whether a path is relative and stays inside whatever directory it is
 * resolved against: not absolute on any platform, no `..` that climbs out,
 * no NUL.
 *
 * @param path - The path as written in the configuration
 */
export function isContainedRelative(path: string): boolean {
  return (
    path.trim() !== '' &&
    !isAbsolute(path) &&
    !WINDOWS_ABSOLUTE.test(path) &&
    isInside('/fireforge-root', path)
  );
}

/** A string with at least one non-whitespace character. */
export const text: Schema<string> = s.string({ pattern: /\S/, format: 'a non-empty string' });

function relative(root: 'project' | 'engine'): Schema<string> {
  const noun = `${root === 'engine' ? 'an' : 'a'} ${root}-relative path`;
  return s
    .string({ pattern: /\S/, format: noun })
    .refine((path) =>
      isContainedRelative(path) ? undefined : `must be ${noun} inside the ${root}`
    );
}

/** A path relative to the project root that stays inside it. */
export const projectPath: Schema<string> = relative('project');

/** A path or glob relative to the engine root that stays inside it. */
export const enginePath: Schema<string> = relative('engine');

/** How loudly an opt-in rule reports; `off` disables it. */
export const severity: Schema<'off' | 'warning' | 'error'> = s.enum(['off', 'warning', 'error']);

/** A whole number of at least one. */
export const positive: Schema<number> = s.int({ min: 1 });

/**
 * A `refine` test refusing a list in which two entries share a name.
 *
 * @param name - Picks the name of an entry
 * @param noun - What the name is, for the message: "group name", "step name"
 */
export function uniqueBy<T>(
  name: (entry: T) => string,
  noun: string
): (entries: T[]) => string | undefined {
  return (entries) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = name(entry);
      if (seen.has(key)) return `repeats the ${noun} "${key}"`;
      seen.add(key);
    }
    return undefined;
  };
}

/**
 * A `refine` test refusing a string that is not a valid regular expression.
 *
 * @param pattern - The pattern source
 */
export function validRegExp(pattern: string): string | undefined {
  try {
    new RegExp(pattern);
    return undefined;
  } catch (error: unknown) {
    return `must be a valid regular expression: ${toError(error).message}`;
  }
}
