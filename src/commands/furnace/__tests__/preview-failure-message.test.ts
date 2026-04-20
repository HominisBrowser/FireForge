// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { buildStorybookFailureMessage } from '../preview.js';

describe('buildStorybookFailureMessage', () => {
  it('classifies missing chrome-map.json as a backend-build failure', () => {
    // Finding #11: the eval log reported
    // `FileNotFoundError: [...] chrome-map.json` AFTER a successful npm
    // install. The pre-0.16.0 heuristic matched "No such file" but the
    // second clause only looked for the literal "backend" string, so
    // chrome-map.json failures were misdiagnosed as dep failures and
    // operators were sent back to `--install`. The 0.16.0 pattern list
    // explicitly recognises backend-artifact filenames.
    const output = [
      'FileNotFoundError: [Errno 2] No such file or directory:',
      "'/project/engine/obj-aarch64-apple-darwin25.4.0/chrome-map.json'",
    ].join(' ');

    const message = buildStorybookFailureMessage(output, false);
    expect(message).toMatch(/Firefox build backend artifacts are missing/);
    expect(message).toMatch(/Rerun "fireforge build"/);
    // Must NOT suggest `--install` — that is the wrong recovery for a
    // missing backend artifact and was the eval's reported misdirection.
    expect(message).not.toMatch(/fireforge furnace preview --install/);
  });

  it('classifies missing config.status as a backend-build failure', () => {
    const output = 'ENOENT: config.status not found';
    const message = buildStorybookFailureMessage(output, false);
    expect(message).toMatch(/backend artifacts are missing/);
  });

  it('keeps the dep-failure hint for generic missing-Storybook-workspace errors', () => {
    // The second branch (not a backend artifact) still points at the
    // `--install` workflow — that path covers the original "missing
    // Storybook packages" symptom that pre-dated finding #11.
    const output = 'ENOENT: Storybook workspace file missing';
    const message = buildStorybookFailureMessage(output, false);
    expect(message).toMatch(/missing Storybook workspace files/);
    expect(message).toMatch(/fireforge furnace preview --install/);
  });

  it('tailors the install hint when --install was already requested', () => {
    const output = 'ENOENT: Storybook workspace file missing';
    const message = buildStorybookFailureMessage(output, true);
    expect(message).toMatch(/mach storybook upgrade/);
    expect(message).not.toMatch(/fireforge furnace preview --install/);
  });

  it('falls back to the generic message when no specific signal matches', () => {
    const message = buildStorybookFailureMessage('Storybook failed because reasons', false);
    expect(message).toMatch(/Check the output above/);
  });
});
