// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasBrowserChromeAssertion } from '../../../core/patch-lint.js';
import { ensureDir, writeText } from '../../../utils/fs.js';
import { scaffoldMochikitTestFiles } from '../create-mochikit.js';
import {
  generateMochikitChromeTomlEntry,
  generateMochikitChromeTomlSkeleton,
  generateMochikitTestContent,
  mochikitTestFileName,
} from '../create-templates.js';

describe('mochikit templates', () => {
  it('produces the canonical test basename', () => {
    expect(mochikitTestFileName('moz-widget')).toBe('test_moz-widget.html');
  });

  it('emits a mochikit HTML test with the right imports and assertions', () => {
    const html = generateMochikitTestContent('moz-widget');
    expect(html).toContain('chrome://mochikit/content/tests/SimpleTest/SimpleTest.js');
    expect(html).toContain('chrome://global/content/elements/moz-widget.mjs');
    expect(html).toContain('customElements.whenDefined("moz-widget")');
    expect(html).toContain('add_task(');
  });

  it('omits SimpleTest.waitForExplicitFinish so add_task can finish the test on its own', () => {
    // A generated scaffold combining `waitForExplicitFinish` with `add_task`
    // and no explicit `SimpleTest.finish()` hangs forever in
    // `fireforge test --headless`. `add_task` already calls `finish()` when
    // every task resolves, so dropping `waitForExplicitFinish()` is the
    // minimum fix that makes the scaffold terminate without requiring
    // operators to remember a `finish()` call.
    const html = generateMochikitTestContent('moz-widget');
    expect(html).not.toContain('waitForExplicitFinish');
    expect(html).not.toContain('SimpleTest.finish');
  });

  it('clears the patch-lint assertion floor', () => {
    // The scaffold's only SimpleTest reference is the harness <script> src, so
    // it must satisfy the floor through its real `ok()`/`is()` assertions
    // rather than through a lint rule loose enough to accept the script tag.
    expect(hasBrowserChromeAssertion(generateMochikitTestContent('moz-widget'))).toBe(true);
  });

  it('chrome.toml skeleton has an empty [DEFAULT] stanza', () => {
    const toml = generateMochikitChromeTomlSkeleton('# header');
    expect(toml).toContain('[DEFAULT]');
  });

  it('chrome.toml entry points at the per-test file', () => {
    const entry = generateMochikitChromeTomlEntry('moz-widget');
    expect(entry).toContain('["test_moz-widget.html"]');
  });
});

describe('scaffoldMochikitTestFiles', () => {
  let engineDir: string;

  beforeEach(async () => {
    engineDir = await mkdtemp(join(tmpdir(), 'ff-mochikit-'));
  });

  afterEach(async () => {
    await rm(engineDir, { recursive: true, force: true });
  });

  it('writes the test file and a fresh chrome.toml when one does not exist', async () => {
    const files = await scaffoldMochikitTestFiles('moz-foo', 'MPL-2.0', { engine: engineDir });
    expect(files).toContain('test_moz-foo.html');
    expect(files).toContain('chrome.toml');

    const testHtml = await readFile(
      join(engineDir, 'toolkit/content/tests/widgets/test_moz-foo.html'),
      'utf8'
    );
    expect(testHtml).toContain('moz-foo');

    const toml = await readFile(
      join(engineDir, 'toolkit/content/tests/widgets/chrome.toml'),
      'utf8'
    );
    expect(toml).toContain('[DEFAULT]');
    expect(toml).toContain('["test_moz-foo.html"]');
  });

  it('appends a per-test entry without duplicating [DEFAULT] when chrome.toml exists', async () => {
    await ensureDir(join(engineDir, 'toolkit/content/tests/widgets'));
    await writeText(
      join(engineDir, 'toolkit/content/tests/widgets/chrome.toml'),
      '# existing\n\n[DEFAULT]\n\n["test_existing.html"]\n'
    );

    const files = await scaffoldMochikitTestFiles('moz-bar', 'MPL-2.0', { engine: engineDir });
    expect(files).not.toContain('chrome.toml');

    const toml = await readFile(
      join(engineDir, 'toolkit/content/tests/widgets/chrome.toml'),
      'utf8'
    );
    expect(toml).toContain('["test_existing.html"]');
    expect(toml).toContain('["test_moz-bar.html"]');
    expect(toml.match(/\[DEFAULT\]/g)?.length).toBe(1);
  });

  it('is idempotent when the same component is scaffolded twice', async () => {
    await scaffoldMochikitTestFiles('moz-baz', 'MPL-2.0', { engine: engineDir });
    await scaffoldMochikitTestFiles('moz-baz', 'MPL-2.0', { engine: engineDir });

    const toml = await readFile(
      join(engineDir, 'toolkit/content/tests/widgets/chrome.toml'),
      'utf8'
    );
    expect(toml.match(/\["test_moz-baz\.html"\]/g)?.length).toBe(1);
  });

  it('records a journal when one is supplied', async () => {
    const { createRollbackJournal } = await import('../../../core/furnace-rollback.js');
    const journal = createRollbackJournal();
    const files = await scaffoldMochikitTestFiles(
      'moz-journaled',
      'MPL-2.0',
      { engine: engineDir },
      journal
    );
    expect(files).toContain('test_moz-journaled.html');
    // The journal records the test file path and (for a fresh widgets dir)
    // the created directory entries.
    expect(journal.files.size).toBeGreaterThan(0);
  });

  it('journals the chrome.toml append when appending to an existing manifest', async () => {
    const { createRollbackJournal } = await import('../../../core/furnace-rollback.js');
    await ensureDir(join(engineDir, 'toolkit/content/tests/widgets'));
    await writeText(
      join(engineDir, 'toolkit/content/tests/widgets/chrome.toml'),
      '# existing\n\n[DEFAULT]\n\n'
    );
    const journal = createRollbackJournal();
    await scaffoldMochikitTestFiles('moz-append', 'MPL-2.0', { engine: engineDir }, journal);
    const manifestKey = join(engineDir, 'toolkit/content/tests/widgets/chrome.toml');
    expect(journal.files.has(manifestKey)).toBe(true);
  });
});
