// SPDX-License-Identifier: EUPL-1.2
import { readSourceBlobs } from '../authored/index.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { isCompiledSourcePath } from '../negative-control-compiled.js';
import { parseControlDiff } from '../negative-control-diff.js';
import { adapterOptionValues } from './adapter-arguments.js';
import type { JobStep } from './schema.js';

/**
 * Whether a negative control can touch compiled output, by what its captured
 * diff names. A diff that cannot be read counts as compiled.
 */
export async function compiledControl(snapshot: AuthoredSnapshot, step: JobStep): Promise<boolean> {
  const path = adapterOptionValues(step, '--negative-control')[0];
  const input = snapshot.inputs.find((entry) => entry.path === path);
  if (input === undefined) return true;
  try {
    const bytes = (await readSourceBlobs(snapshot.repository, [input.blob])).get(input.blob);
    if (bytes === undefined) return true;
    return parseControlDiff(bytes.toString('utf8')).some((file) => isCompiledSourcePath(file.path));
  } catch {
    return true;
  }
}
