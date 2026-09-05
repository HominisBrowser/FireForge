// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { buildStorybookFailureMessage } from '../preview.js';

describe('buildStorybookFailureMessage', () => {
  it('classifies missing chrome-map.json as a backend-build failure', () => {
    // A `FileNotFoundError: [...] chrome-map.json` after a successful npm
    // install is a backend-artifact failure, not a dependency one. A
    // heuristic that matches "No such file" but only looks for the literal
    // "backend" string misdiagnoses it and sends operators back to
    // `--install`. The pattern list explicitly recognises backend-artifact
    // filenames.
    const output = [
      'FileNotFoundError: [Errno 2] No such file or directory:',
      "'/project/engine/obj-aarch64-apple-darwin25.4.0/chrome-map.json'",
    ].join(' ');

    const message = buildStorybookFailureMessage(output, false);
    expect(message).toMatch(/Firefox build backend artifacts are missing/);
    expect(message).toMatch(/Rerun "fireforge build"/);
    // Must not suggest `--install`, the wrong recovery for a missing
    // backend artifact.
    expect(message).not.toMatch(/fireforge furnace preview --install/);
  });

  it('classifies missing config.status as a backend-build failure', () => {
    const output = 'ENOENT: config.status not found';
    const message = buildStorybookFailureMessage(output, false);
    expect(message).toMatch(/backend artifacts are missing/);
  });

  it('keeps the dep-failure hint for generic missing-Storybook-workspace errors', () => {
    // The second branch (not a backend artifact) still points at the
    // `--install` workflow, which covers the genuine "missing Storybook
    // packages" symptom.
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
