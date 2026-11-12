// SPDX-License-Identifier: EUPL-1.2
/** `build` and `buildAudit`: how the browser is built and packaged, and the packaging audit. */
import { posix } from 'node:path';

import { s } from '../../kernel/schema.js';
import {
  enginePath,
  isContainedRelative,
  positive,
  projectPath,
  text,
  uniqueBy,
} from './common.js';

/** One spelling per path: relative, normalized, forward slashes, no trailing slash. */
function isCanonical(path: string): boolean {
  return (
    isContainedRelative(path) &&
    path !== '.' &&
    !path.includes('\\') &&
    !path.endsWith('/') &&
    posix.normalize(path) === path
  );
}

const releaseOutput = s
  .string({ pattern: /\S/, format: 'a path in the release object directory' })
  .refine((path) =>
    isCanonical(path) && !posix.dirname(path).includes('*')
      ? undefined
      : 'must be a canonical path in the object directory, with * only in the last segment'
  );

const release = s
  .object({
    overlay: projectPath.describe('Captured mozconfig fragment appended last for a release build'),
    secrets: s
      .object({
        variable: s
          .string({ pattern: /^[A-Z][A-Z0-9_]{0,63}$/, format: 'an environment variable name' })
          .describe('Environment variable naming the directory the overlay reads secrets from'),
        files: s
          .array(s.string({ pattern: /^[\w.-]+$/, format: 'a file name' }))
          .describe('Files that must be in that directory; a release missing one refuses'),
      })
      .describe('Secret files the overlay reads, which are never committed')
      .optional(),
    outputs: s
      .array(releaseOutput, { min: 1 })
      .describe('Paths in the release object directory to collect, such as dist/*.dmg')
      .optional(),
  })
  .describe('How a release build differs from a development build');

/** The `build` section. */
export const buildSection = s
  .object({
    jobs: positive.describe('Parallel jobs for mach build').optional(),
    release: release.optional(),
  })
  .describe('Build settings');

const unpackaged = s.object({
  path: enginePath
    .refine((path) =>
      path.includes('**')
        ? 'must not use "**": a carve-out may glob within one path segment only'
        : undefined
    )
    .describe('Engine-relative path, exact or with * inside one segment'),
  reason: text.describe('Why the file is never packaged'),
});

/** The `buildAudit` section. */
export const buildAuditSection = s
  .object({
    unpackaged: s
      .array(unpackaged)
      .refine(uniqueBy((entry) => entry.path, 'path'))
      .describe('Sources the post-build audit treats as intentionally unpackaged')
      .optional(),
  })
  .describe('Post-build packaging audit');
