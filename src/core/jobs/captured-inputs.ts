// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';

import { readSourceBlobs } from '../authored/index.js';
import { assertSourcePath } from '../authored/paths.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { adapterOptionValues } from './adapter-arguments.js';
import type { JobStep } from './schema.js';

async function inputDigest(snapshot: AuthoredSnapshot, path: string): Promise<string> {
  assertSourcePath(path);
  if (/^(?:engine|node_modules|\.fireforge|\.git)(?:\/|$)/.test(path))
    throw new Error(`Job file input is not an ordinary captured root input: ${path}`);
  const input = snapshot.inputs.find((entry) => entry.path === path);
  if (!input) throw new Error(`Job file input was not captured: ${path}`);
  const bytes = (await readSourceBlobs(snapshot.repository, [input.blob])).get(input.blob);
  if (!bytes) throw new Error(`Captured job input blob is unavailable: ${path}`);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Authenticate all supported input-bearing options before submission is acknowledged. */
export async function authenticateAdapterInputs(
  snapshot: AuthoredSnapshot,
  step: JobStep
): Promise<void> {
  const paths = [
    ...adapterOptionValues(step, '--negative-control'),
    ...adapterOptionValues(step, '--console-allow-file'),
  ];
  for (const value of adapterOptionValues(step, '--profile-file')) {
    const parts = value.split('=');
    if (parts.length !== 2 || !parts[0] || !parts[1])
      throw new Error('Profile input must be captured source=destination');
    assertSourcePath(parts[1]);
    paths.push(parts[0]);
  }
  await Promise.all(paths.map((path) => inputDigest(snapshot, path)));
}

/** A control's identity comes from immutable captured bytes, never a phase-end mutable file. */
export async function capturedControlDigest(
  snapshot: AuthoredSnapshot | undefined,
  step: JobStep
): Promise<string | undefined> {
  const paths = adapterOptionValues(step, '--negative-control');
  if (paths.length === 0) return undefined;
  if (!snapshot || paths.length !== 1 || !paths[0])
    throw new Error('Negative control requires exactly one captured input');
  return inputDigest(snapshot, paths[0]);
}
