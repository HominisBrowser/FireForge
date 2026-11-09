// SPDX-License-Identifier: EUPL-1.2
/** Full checks have no selection, help or bypass forms; only output and bounded concurrency vary. */
export function assertFullCheckArguments(
  args: readonly string[],
  maximumJobs?: number
): number | undefined {
  let jobs: number | undefined,
    json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    if ((arg === '--jobs' || arg?.startsWith('--jobs=')) && jobs === undefined) {
      const value = arg === '--jobs' ? args[++index] : arg.slice('--jobs='.length);
      if (
        !value ||
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1
      )
        throw new Error('Full check requires a positive bounded --jobs value');
      jobs = Number(value);
      if (maximumJobs !== undefined && jobs > maximumJobs)
        throw new Error('Full check --jobs exceeds admitted CPU');
      continue;
    }
    throw new Error(`Full check does not permit narrowed, help or unknown arguments: ${arg ?? ''}`);
  }
  return jobs;
}
