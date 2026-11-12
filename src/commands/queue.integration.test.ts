// SPDX-License-Identifier: EUPL-1.2
/** The patch-mode engine commands through the CLI: import, resolve, discard, reset. */
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../testing/cli.js';
import { git } from '../testing/git.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { useTempDir } from '../testing/temp.js';

const dir = useTempDir();
const BROWSER = 'browser/base/content/browser.js';
const MOZBUILD = 'browser/modules/moz.build';

async function queue(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
  await fixture.addPatch('infra-dirs', { [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n' });
  await fixture.resetEngine();
  return fixture;
}

function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('fireforge import', () => {
  it('applies the queue and reports each patch', async () => {
    const fixture = await queue();
    const result = await runCli(['import', '--json'], { cwd: fixture.root });
    expect(result.exitCode).toBe(0);
    expect(json(result.stdout)).toEqual({
      schemaVersion: 1,
      patches: [
        { patch: '001-ui-title.patch', status: 'applied-clean' },
        { patch: '002-infra-dirs.patch', status: 'applied-clean' },
      ],
      written: [BROWSER, MOZBUILD],
    });
    const text = await runCli(['import'], { cwd: fixture.root });
    expect(text.stdout).toBe('Applied 2 patch(es); 0 engine file(s) written.\n');
  });

  it('pauses on a failing patch, and resolve plus --continue finish it', async () => {
    const fixture = await queue();
    await fixture.upstream({ [BROWSER]: 'export const browserTitle = "upstream";\n' });
    const paused = await runCli(['import', '--json'], { cwd: fixture.root });
    expect(paused.exitCode).toBe(6);
    expect(json(paused.stdout)).toMatchObject({ code: 'patch-failed' });
    expect(paused.stderr).toContain('fireforge resolve');

    await fixture.edit({ [BROWSER]: 'export const browserTitle = "patched again";\n' });
    const resolved = await runCli(['resolve', '--json'], { cwd: fixture.root });
    expect(resolved.exitCode).toBe(0);
    expect(json(resolved.stdout)).toEqual({
      schemaVersion: 1,
      patch: '001-ui-title.patch',
      files: [BROWSER],
    });

    const resumed = await runCli(['import', '--continue'], { cwd: fixture.root });
    expect(resumed.exitCode).toBe(0);
    expect(await fixture.read(MOZBUILD)).toContain('mine');
  });

  it('refuses --until with --continue, and resolve without a paused import', async () => {
    const fixture = await queue();
    expect(
      (await runCli(['import', '--until', '1', '--continue'], { cwd: fixture.root })).exitCode
    ).toBe(8);
    const resolved = await runCli(['resolve'], { cwd: fixture.root });
    expect(resolved.exitCode).toBe(10);
  });

  it('refuses to overwrite unexported edits unless forced', async () => {
    const fixture = await queue();
    await fixture.edit({ [BROWSER]: 'mine\n' });
    const refused = await runCli(['import'], { cwd: fixture.root });
    expect(refused.exitCode).toBe(6);
    expect(refused.stderr).toContain(BROWSER);
    expect((await runCli(['import', '--force'], { cwd: fixture.root })).exitCode).toBe(0);
    expect(await fixture.read(BROWSER)).toContain('patched');
  });
});

describe('fireforge discard', () => {
  it('restores paths relative to the engine, or to the directory it runs in there', async () => {
    const fixture = await queue();
    await runCli(['import'], { cwd: fixture.root });
    await fixture.edit({ [BROWSER]: 'edited\n', 'browser/base/content/scratch.js': 'x\n' });
    const result = await runCli(['discard', BROWSER], { cwd: fixture.root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${BROWSER}: modified -> queue baseline (001-ui-title.patch)`);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "patched";\n');

    const inside = await runCli(['discard', 'scratch.js', '--json'], {
      cwd: join(fixture.engine, 'browser/base/content'),
    });
    expect(json(inside.stdout)).toMatchObject({
      paths: [
        { path: 'browser/base/content/scratch.js', was: 'unmanaged', to: 'upstream', owners: [] },
      ],
    });
    expect((await runCli(['discard', BROWSER], { cwd: fixture.root })).stdout).toBe(
      'Nothing to discard.\n'
    );
    expect((await runCli(['discard'], { cwd: fixture.root })).exitCode).toBe(8);
  });
});

describe('fireforge reset', () => {
  it('asks for --yes without a terminal, then resets the engine', async () => {
    const fixture = await queue();
    await runCli(['import'], { cwd: fixture.root });
    const refused = await runCli(['reset'], { cwd: fixture.root });
    expect(refused.exitCode).toBe(8);
    expect(refused.stderr).toContain('--yes');
    const result = await runCli(['reset', '--yes', '--json'], { cwd: fixture.root });
    expect(result.exitCode).toBe(0);
    expect(json(result.stdout)).toMatchObject({
      changed: true,
      snapshot: expect.stringContaining('refs/fireforge/recovery/') as string,
    });
    expect((await git(fixture.engine, ['status', '--porcelain'])).trim()).toBe('');
  });
});

describe('fireforge status and verify', () => {
  const pending = async (fixture: PatchFixture): Promise<Record<string, string>> => {
    const result = await runCli(['status', '--json'], { cwd: fixture.root });
    const report = json(result.stdout) as { pending: { code: string; subject?: string }[] };
    return Object.fromEntries(report.pending.map((entry) => [entry.subject ?? '', entry.code]));
  };

  it('names every way the engine can differ from the queue, with the command for each', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
    const earlier = join(dir(), 'earlier-queue');
    await cp(fixture.patches, earlier, { recursive: true });
    await fixture.addPatch('infra-dirs', { [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n' });
    await fixture.resetEngine();
    expect(await pending(fixture)).toEqual({ [BROWSER]: 'unapplied', [MOZBUILD]: 'unapplied' });
    expect((await runCli(['import'], { cwd: fixture.root })).exitCode).toBe(0);
    expect(await pending(fixture)).toEqual({});

    // The queue changes under the engine, as a pull does: what the import wrote is outdated, not an edit.
    await rm(fixture.patches, { recursive: true });
    await cp(earlier, fixture.patches, { recursive: true });
    expect(await pending(fixture)).toEqual({ [MOZBUILD]: 'outdated' });
    expect((await runCli(['import'], { cwd: fixture.root })).exitCode).toBe(0);
    expect(await pending(fixture)).toEqual({});

    await fixture.edit({
      [BROWSER]: 'export const browserTitle = "edited";\n',
      'browser/base/content/scratch.js': 'x\n',
    });
    expect(await pending(fixture)).toEqual({
      [BROWSER]: 'unexported',
      'browser/base/content/scratch.js': 'unmanaged',
    });
    const text = await runCli(['status', '--check'], { cwd: fixture.root });
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain(`fireforge re-export, or fireforge discard ${BROWSER}`);
    expect(text.stderr).toContain('2 thing(s) are unaccounted for.');

    await fixture.edit({ [BROWSER]: null, 'browser/base/content/scratch.js': null });
    expect(await pending(fixture)).toEqual({ [BROWSER]: 'missing' });
  });

  it('verify fails on a patch body that no longer matches the manifest', async () => {
    const fixture = await queue();
    const sound = await runCli(['verify', '--json'], { cwd: fixture.root });
    expect(json(sound.stdout)).toMatchObject({ mode: 'patches', pass: true, problems: [] });
    await rm(join(fixture.patches, '001-ui-title.patch'));
    const broken = await runCli(['verify'], { cwd: fixture.root });
    expect(broken.exitCode).toBe(6);
    expect(broken.stdout).toContain('001-ui-title.patch');
    expect(broken.stderr).toContain('problem(s) in the patch queue.');
    expect(broken.stderr).toContain('fireforge verify');
  });
});
