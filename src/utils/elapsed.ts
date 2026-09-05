// SPDX-License-Identifier: EUPL-1.2

/**
 * Formats a duration in milliseconds as `Xm Ys`, or `Ys` under a minute.
 *
 * The single spelling of FireForge's elapsed-time wording: `build` and
 * `package` each hand-rolled the same minute/second split, so a change to
 * the format silently applied to some progress lines and not others.
 *
 * @param ms - Duration in milliseconds; negative input is clamped to zero.
 * @returns The duration as `Xm Ys`, or `Ys` when under one minute.
 */
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
