// SPDX-License-Identifier: EUPL-1.2
import { tagNameToClassName } from '../../core/furnace-constants.js';
import { escapeRegex } from '../../utils/regex.js';

function deriveTestStem(componentName: string, binaryName: string): string {
  const strippedName = componentName.startsWith('moz-') ? componentName.slice(4) : componentName;
  const withoutBinaryPrefix = strippedName.startsWith(binaryName + '-')
    ? strippedName.slice(binaryName.length + 1)
    : strippedName;
  return withoutBinaryPrefix.replace(/-/g, '_');
}

/** Rewrites scaffolded browser-chrome test literals after a component rename. */
export function updateBrowserChromeTestContent(
  content: string,
  oldName: string,
  newName: string,
  binaryName: string
): string {
  const oldClassName = tagNameToClassName(oldName);
  const newClassName = tagNameToClassName(newName);
  const oldUnderscored = oldName.replace(/-/g, '_');
  const newUnderscored = newName.replace(/-/g, '_');
  const oldTestStem = deriveTestStem(oldName, binaryName);
  const newTestStem = deriveTestStem(newName, binaryName);
  // ONE pass over the content, not four chained `.replace()` calls.
  //
  // Chaining let each rule see the previous rule's output. Renaming
  // `acme-widget` to `acme-widget-v2` rewrote `test_acme_widget_defined` to
  // `test_acme_widget_v2_defined` via the underscored form, and then the stem
  // rule matched the `acme_widget` still inside that result and produced
  // `test_acme_widget_v2_v2_defined`. A single alternation with a callback
  // cannot re-enter its own output.
  //
  // Ordering is longest-first, because JS alternation takes the first
  // alternative that matches at a given position.
  const alternatives: Array<{ pattern: string; to: string }> = [
    // The stem is a short bare fragment (`moz-` and binary prefixes stripped,
    // hyphens underscored) — `panel` for `moz-panel`. Matching it loose, even
    // with hyphen guards, rewrote unrelated underscore-delimited identifiers
    // such as `test_panel_group_integration`, because `_` must stay a legal
    // neighbour for the generated name to match at all. The scaffold emits the
    // stem in exactly one shape, so anchor to that shape instead of guessing
    // from boundaries — with its own guards, so the anchored shape cannot
    // match inside a longer identifier (`mytest_panel_defined_extra`).
    {
      pattern: `(?<![\\w-])test_${escapeRegex(oldTestStem)}_defined(?![\\w-])`,
      to: `test_${newTestStem}_defined`,
    },
    // Word-boundary-aware, matching `furnace/rename.ts` and
    // `rename-xpcshell.ts`: without the guards a rename of `moz-panel` rewrote
    // `moz-panel-group`. `_` stays a legal neighbour for the underscored form
    // because it is deliberately embedded in generated identifiers; `-` does
    // not.
    //
    // Skipped when the underscored form IS the tag name (a hyphen-less
    // component): both rules then match the same text and this one would win
    // on order, substituting `newUnderscored` where the tag `newName` was
    // meant. The stem rule still covers the one generated identifier shape.
    ...(oldUnderscored === oldName
      ? []
      : [
          {
            pattern: `(?<![A-Za-z0-9-])${escapeRegex(oldUnderscored)}(?![A-Za-z0-9-])`,
            to: newUnderscored,
          },
        ]),
    { pattern: `(?<![\\w-])${escapeRegex(oldName)}(?![\\w-])`, to: newName },
    { pattern: `\\b${escapeRegex(oldClassName)}\\b`, to: newClassName },
  ];

  // Each alternative is its own capture group and the replacement is picked by
  // the group that matched — not by matched TEXT, which is ambiguous whenever
  // two rules can produce the same match with different substitutions.
  const combined = new RegExp(alternatives.map(({ pattern }) => `(${pattern})`).join('|'), 'g');
  return content.replace(combined, (matched, ...args) => {
    const groups = args.slice(0, alternatives.length) as Array<string | undefined>;
    const index = groups.findIndex((group) => group !== undefined);
    return alternatives[index]?.to ?? matched;
  });
}
