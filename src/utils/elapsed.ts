// SPDX-License-Identifier: EUPL-1.2

/** Formats elapsed milliseconds for progress messages. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Returns formatted elapsed time since a start timestamp from Date.now(). */
export function elapsedSince(startedAt: number): string {
  return formatElapsed(Date.now() - startedAt);
}
