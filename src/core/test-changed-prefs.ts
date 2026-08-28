// SPDX-License-Identifier: EUPL-1.2
/**
 * Recognizer for the one mochitest failure shape that is a function of run
 * LENGTH rather than of the code under test: the time-driven
 * changed-preference checks.
 *
 * Separate from `test-harness-crash.ts` because it is not a crash
 * classification — the run failed, and the classifier's verdict is correct.
 * What this adds is which KIND of failure it was, which is a different
 * question and one that only grows as more such shapes are recorded.
 */

import { collectUnexpectedFailureBlocks } from './test-harness-crash.js';

/**
 * Preferences that move on their own as a function of how LONG a run takes,
 * not of what it tested.
 *
 * Both are time-driven: a long run crosses the cold-startup check interval
 * and the pref moves under the harness. The observable consequence is that
 * chunk length, not the change under test, decides whether the suite is
 * red — the same work at a smaller `--chunk` passes. FireForge cannot
 * suppress the check (it is the harness's, not ours) but it can stop the
 * pair being indistinguishable from two real assertion failures, which is
 * the whole cost of the shape.
 *
 * Matched as substrings: the harness prints fully-qualified pref names and
 * the leading namespace has moved upstream more than once.
 */
const TIME_DRIVEN_PREF_NAMES = ['lastColdStartupCheck', 'globalprivacycontrol'] as const;

/** A failure block that is a changed-preference report rather than an assertion. */
const CHANGED_PREF_BLOCK_PATTERN = /pref(?:erence)?s?\b/i;

/**
 * Describes a failure set that consists ENTIRELY of changed-preference
 * checks on {@link TIME_DRIVEN_PREF_NAMES}.
 *
 * Deliberately keyed on the pref NAMES rather than on the harness's phrasing
 * of its changed-preference report: the phrasing is upstream copy that has
 * no stable contract with us, and the names are the part that identifies the
 * shape. A single block that names anything else — a real assertion, a
 * different pref — disqualifies the whole set, because the point is to
 * describe a run whose every failure is this noise, never to explain away
 * one real failure sitting beside it.
 *
 * Pure; returns undefined when the shape does not apply.
 *
 * @param output - Combined harness stdout+stderr
 * @returns Operator-facing explanation, or undefined
 */
export function describeChangedPrefNoise(output: string): string | undefined {
  const blocks = collectUnexpectedFailureBlocks(output, CHANGED_PREF_BLOCK_LIMIT).filter(
    (block) => !block.startsWith('…')
  );
  if (blocks.length === 0) return undefined;
  const namesSeen = new Set<string>();
  for (const block of blocks) {
    if (!CHANGED_PREF_BLOCK_PATTERN.test(block)) return undefined;
    const matched = TIME_DRIVEN_PREF_NAMES.filter((name) => block.includes(name));
    if (matched.length === 0) return undefined;
    for (const name of matched) namesSeen.add(name);
  }
  return (
    `Every unexpected result in this run is a changed-preference check on ${[...namesSeen].join(' / ')}. ` +
    'Those preferences are TIME-DRIVEN: they move once a run is long enough to cross the ' +
    'cold-startup check interval, so they correlate with run LENGTH rather than with the ' +
    'change under test or with the build. The first probe is to halve the chunk size ' +
    '(`--chunk 8` where a 40-row chunk tripped it) and see whether the same work passes; ' +
    'if it does, this was harness noise, not a regression. FireForge cannot forgive the ' +
    'check — it belongs to the harness — only tell you which kind of failure you are ' +
    'looking at.'
  );
}

/** Failure blocks inspected before the changed-pref shape is abandoned. */
const CHANGED_PREF_BLOCK_LIMIT = 20;

/** Short verdict-line note for the changed-preference-noise shape. */
export function changedPrefNoiseVerdictNote(output: string): string | undefined {
  return describeChangedPrefNoise(output) === undefined
    ? undefined
    : 'all unexpected results are time-driven changed-pref checks';
}
