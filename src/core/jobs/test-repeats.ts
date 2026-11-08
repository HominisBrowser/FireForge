// SPDX-License-Identifier: EUPL-1.2

/** Reject ambiguous repetition flags; evidence must match the actual native request. */
export function requestedTestRepeats(args: readonly string[]): number {
  const flags = args.flatMap((arg, index) =>
    arg === '--repeat' || arg.startsWith('--repeat=') ? [index] : []
  );
  if (flags.length > 1) throw new Error('Repeated --repeat flags are ambiguous');
  const index = flags[0];
  const count = index === undefined ? 1 : Number(args[index]?.split('=')[1] ?? args[index + 1]);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('Invalid requested test repetition count');
  return count;
}
