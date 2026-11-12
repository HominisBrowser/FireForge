// SPDX-License-Identifier: EUPL-1.2
/** The patch-queue editing commands through the CLI: re-export and the patch subcommands. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../testing/cli.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { readTree, useTempDir } from '../testing/temp.js';

const dir = useTempDir();
const BROWSER = 'browser/base/content/browser.js';
const PANEL = 'browser/components/panel/panel.mjs';
const PANEL_CSS = 'browser/components/panel/panel.css';

async function queue(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-panel', {
    [PANEL]: 'export const panel = 1;\n',
    [PANEL_CSS]: '.p {}\n',
  });
  await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
  return fixture;
}

function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function manifest(fixture: PatchFixture): Promise<Record<string, unknown>> {
  return json(await readFile(join(fixture.patches, 'patches.json'), 'utf8'));
}

describe('fireforge re-export', () => {
  it('rewrites the named patch and reports each one', async () => {
    const fixture = await queue();
    await fixture.edit({ [BROWSER]: 'export const browserTitle = "edited";\n' });
    const result = await runCli(['re-export', '--all', '--json'], { cwd: fixture.root });
    expect(result.exitCode).toBe(0);
    expect(json(result.stdout)).toEqual({
      schemaVersion: 1,
      dryRun: false,
      patches: [
        {
          patch: '001-ui-panel.patch',
          status: 'unchanged',
          adopted: [],
          dropped: [],
          stamped: false,
        },
        {
          patch: '002-ui-title.patch',
          status: 'rewritten',
          adopted: [],
          dropped: [],
          stamped: false,
        },
      ],
    });
  });

  it('previews with --dry-run, adopts with --scan, and needs patches or --all', async () => {
    const fixture = await queue();
    await fixture.edit({ 'browser/components/panel/extra.mjs': '// extra\n' });
    const before = await readTree(fixture.patches);
    const preview = await runCli(['re-export', 'ui-panel', '--scan', '--dry-run'], {
      cwd: fixture.root,
    });
    expect(preview.stdout).toBe(
      'Would rewrite 001-ui-panel.patch\n  + browser/components/panel/extra.mjs (adopted)\n'
    );
    expect(await readTree(fixture.patches)).toEqual(before);
    expect((await runCli(['re-export'], { cwd: fixture.root })).exitCode).toBe(8);
    expect((await runCli(['re-export', '1', '--all'], { cwd: fixture.root })).exitCode).toBe(8);
  });
});

describe('fireforge patch', () => {
  it('renames, reorders and compacts, reporting the renamed files', async () => {
    const fixture = await queue();
    const renamed = await runCli(['patch', 'rename', '2', 'ui-heading', '--json'], {
      cwd: fixture.root,
    });
    expect(json(renamed.stdout)).toEqual({
      schemaVersion: 1,
      renamed: [{ from: '002-ui-title.patch', to: '002-ui-heading.patch' }],
      created: [],
      rewritten: [],
      removed: [],
    });
    const moved = await runCli(['patch', 'reorder', 'ui-heading', '--order', '9'], {
      cwd: fixture.root,
    });
    expect(moved.stdout).toBe('Renamed 002-ui-heading.patch -> 009-ui-heading.patch\n');
    expect((await runCli(['patch', 'reorder', 'ui-heading'], { cwd: fixture.root })).exitCode).toBe(
      8
    );
    const compacted = await runCli(['patch', 'compact'], { cwd: fixture.root });
    expect(compacted.stdout).toBe('Renamed 009-ui-heading.patch -> 002-ui-heading.patch\n');
  });

  it('splits files out of a patch and moves them back', async () => {
    const fixture = await queue();
    const split = await runCli(
      ['patch', 'split', 'ui-panel', PANEL_CSS, '--name', 'ui-panel-style', '--json'],
      { cwd: fixture.root }
    );
    expect(json(split.stdout)).toMatchObject({
      created: ['002-ui-panel-style.patch'],
      rewritten: ['001-ui-panel.patch'],
      renamed: [{ from: '002-ui-title.patch', to: '003-ui-title.patch' }],
    });
    const back = await runCli(['patch', 'move-files', 'ui-panel-style', 'ui-panel', 'panel.css'], {
      cwd: join(fixture.engine, 'browser/components/panel'),
    });
    expect(back.exitCode).toBe(0);
    expect(back.stdout).toContain('Removed 002-ui-panel-style.patch');
  });

  it('deletes and retires patches, naming the files left unowned', async () => {
    const fixture = await queue();
    const retired = await runCli(['patch', 'retire', 'ui-title', '--reason', 'gone', '--json'], {
      cwd: fixture.root,
    });
    expect(json(retired.stdout)).toMatchObject({
      removed: ['002-ui-title.patch'],
      files: [BROWSER],
    });
    expect((await manifest(fixture))['retired']).toEqual([
      { order: 2, name: 'ui-title', reason: 'gone' },
    ]);
    const deleted = await runCli(['patch', 'delete', 'ui-panel'], { cwd: fixture.root });
    expect(deleted.stdout).toBe('Removed 001-ui-panel.patch\n');
  });

  it('edits metadata with patch set', async () => {
    const fixture = await queue();
    const result = await runCli(
      [
        'patch',
        'set',
        'ui-panel',
        '--description',
        'Panel',
        '--tier',
        'branding',
        '--lint-ignore',
        'file-too-large',
        '--max',
        '900',
        '--reason',
        'tracked',
        '--staged-dependency',
        `${PANEL}:browser/later.mjs`,
        '--json',
      ],
      { cwd: fixture.root }
    );
    expect(json(result.stdout)).toEqual({
      schemaVersion: 1,
      patch: '001-ui-panel.patch',
      changed: true,
      description: 'Panel',
      tier: 'branding',
      lintIgnore: [{ rule: 'file-too-large', max: 900, reason: 'tracked' }],
      stagedDependencies: [{ file: PANEL, creates: 'browser/later.mjs', reason: 'tracked' }],
    });
    const cleared = await runCli(
      [
        'patch',
        'set',
        '1',
        '--tier',
        'none',
        '--remove-lint-ignore',
        'file-too-large',
        '--remove-staged-dependency',
        `${PANEL}:browser/later.mjs`,
      ],
      { cwd: fixture.root }
    );
    expect(cleared.stdout).toBe('Updated 001-ui-panel.patch\n');
    expect((await manifest(fixture))['patches']).toEqual([
      { order: 1, name: 'ui-panel', description: 'Panel' },
      { order: 2, name: 'ui-title' },
    ]);
    expect(
      (await runCli(['patch', 'set', '1', '--max', '3'], { cwd: fixture.root })).exitCode
    ).toBe(8);
    expect(
      (await runCli(['patch', 'set', '1', '--staged-dependency', 'nocolon'], { cwd: fixture.root }))
        .exitCode
    ).toBe(8);
  });
});
