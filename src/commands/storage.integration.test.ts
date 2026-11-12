// SPDX-License-Identifier: EUPL-1.2
/**
 * The commands that cross or move the storage, through the CLI: `migrate`
 * with the `export` that goes back, `rebase` in each mode onto a second
 * seeded pin, and `setup` in each mode.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { type HostPaths, hostPaths } from '../project/index.js';
import { readQueue, replayQueue } from '../queue/index.js';
import { type CliResult, runCli } from '../testing/cli.js';
import { TEST_PIN, TEST_PIN_KEY } from '../testing/config.js';
import { makeSourceProject, seedPristine, useMachSandbox } from '../testing/engine.js';
import { SYNTHETIC_FIREFOX_PATHS } from '../testing/firefox.js';
import { commitAll, git, initRepo } from '../testing/git.js';
import { createPatchProject } from '../testing/patch-project.js';
import { useTempDir, writeTree } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

const BROWSER = SYNTHETIC_FIREFOX_PATHS.browserScript;
const SERVICE = SYNTHETIC_FIREFOX_PATHS.serviceModule;
const MULTI = 'browser/base/content/multi.js';
const LINES = 'one\ntwo\nthree\nfour\nfive\n';
const NEXT_PIN = { version: '140.10.0esr', product: 'firefox-esr' } as const;

const host = (): HostPaths => hostPaths({ FIREFORGE_HOME: join(dir(), 'home') });

const cli = (project: { root: string }, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: project.root, env: { FIREFORGE_HOME: host().root } });

const json = (result: CliResult): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>;

const config = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, 'fireforge.json'), 'utf8')) as Record<string, unknown>;

describe('fireforge migrate --to-source', () => {
  it('turns a patch queue into owned files, and export writes a queue with the same tree', async () => {
    const commit = await seedPristine(host());
    const pristine = join(host().pristine, TEST_PIN_KEY);
    const fixture = await createPatchProject(join(dir(), 'project'));
    await fixture.addPatch(
      'ui-title',
      { [BROWSER]: 'export const browserTitle = "mine";\n' },
      { lintIgnore: ['jsdoc', { rule: 'large-patch-files', max: 9, reason: 'reviewed' }] }
    );
    await fixture.addPatch(
      'branding-panel',
      { 'browser/branding/mine/panel.mjs': 'export const panel = 1;\n', [SERVICE]: null },
      { tier: 'branding' }
    );
    await fixture.addPatch('ui-extra', { 'browser/base/content/extra.mjs': 'export {};\n' });
    const original = await replayQueue(pristine, commit, fixture.patches);
    await initRepo(fixture.root, { '.gitignore': 'engine/\n.fireforge/\n' });

    await writeTree(fixture.root, { 'notes.txt': 'uncommitted\n' });
    const dirty = await cli(fixture, 'migrate', '--to-source');
    expect(dirty.exitCode).toBe(ExitCode.GIT_ERROR);
    expect(dirty.stderr).toContain('notes.txt');
    expect(await config(fixture.root)).not.toHaveProperty('mode');
    await commitAll(fixture.root, 'notes');

    const migrated = await cli(fixture, 'migrate', '--to-source', '--json');
    expect(migrated.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(migrated)).toMatchObject({
      pristineCommit: commit,
      created: ['browser/base/content/extra.mjs', 'browser/branding/mine/panel.mjs'],
      overridden: [BROWSER],
      deleted: [SERVICE],
    });
    expect(await config(fixture.root)).toMatchObject({
      mode: 'source',
      source: { root: 'src', pristineCommit: commit },
      patchLint: {
        waivers: [
          { group: 'ui-title', rule: 'jsdoc' },
          { group: 'ui-title', rule: 'large-patch-files', max: 9, reason: 'reviewed' },
        ],
      },
      exportQueue: {
        groups: [
          {
            name: 'branding-panel-created',
            paths: ['browser/branding/mine/**'],
            tier: 'branding',
          },
          { name: 'ui-extra', paths: ['browser/base/content/extra.mjs'] },
        ],
        componentTiers: { 'branding-panel': 'branding' },
      },
    });
    expect(await exists(fixture.patches)).toBe(false);
    expect(await readFile(join(fixture.root, 'src', BROWSER), 'utf8')).toContain('"mine"');
    expect((await cli(fixture, 'status', '--check')).exitCode).toBe(ExitCode.SUCCESS);
    expect((await cli(fixture, 'verify')).exitCode).toBe(ExitCode.SUCCESS);

    expect((await cli(fixture, 'export')).exitCode).toBe(ExitCode.SUCCESS);
    expect(await replayQueue(pristine, commit, fixture.patches)).toBe(original);
    const queue = await readQueue(fixture.patches);
    expect(
      queue.patches.map((patch) => [patch.name, patch.tier, patch.lintIgnore?.length ?? 0])
    ).toEqual([
      ['branding-panel', 'branding', 0],
      ['ui-title', undefined, 2],
      ['branding-panel-created', 'branding', 0],
      ['ui-extra', undefined, 0],
    ]);
  }, 60_000);
});

describe('fireforge rebase', () => {
  it('merges a source-mode project onto the new pin and writes the pin', async () => {
    await seedPristine(host(), { [MULTI]: LINES });
    const next = await seedPristine(host(), { [MULTI]: LINES.replace('one', 'ONE') }, NEXT_PIN);
    const project = await makeSourceProject(dir(), {
      files: { 'src/browser/base/content/panel.mjs': 'export {};\n' },
    });
    expect((await cli(project, 'override', MULTI)).exitCode).toBe(ExitCode.SUCCESS);
    await writeTree(project.root, { [`src/${MULTI}`]: LINES.replace('five', 'FIVE') });
    await commitAll(project.root, 'own multi.js');

    expect((await cli(project, 'rebase', '--continue')).exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    const same = await cli(project, 'rebase', '--to', TEST_PIN.version);
    expect(same.exitCode).toBe(ExitCode.INVALID_ARGUMENT);

    const rebased = await cli(project, 'rebase', '--to', NEXT_PIN.version, '--json');
    expect(rebased.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(rebased)).toMatchObject({
      status: 'complete',
      pin: NEXT_PIN,
      conflicts: [],
      entries: expect.arrayContaining([{ subject: MULTI, outcome: 'merged' }]) as unknown,
    });
    expect(await config(project.root)).toMatchObject({
      firefox: NEXT_PIN,
      source: { pristineCommit: next },
    });
    expect(await readFile(join(project.root, 'src', MULTI), 'utf8')).toBe(
      'ONE\ntwo\nthree\nfour\nFIVE\n'
    );
    expect((await cli(project, 'status', '--check')).exitCode).toBe(ExitCode.SUCCESS);
  }, 60_000);

  it('moves a patch-mode project: new engine, new pin, the queue re-applied and restamped', async () => {
    await seedPristine(host(), { [MULTI]: LINES });
    const next = await seedPristine(host(), { [MULTI]: LINES.replace('one', 'ONE') }, NEXT_PIN);
    const fixture = await createPatchProject(join(dir(), 'project'), {
      files: { [MULTI]: LINES },
    });
    await fixture.addPatch('ui-multi', { [MULTI]: LINES.replace('five', 'FIVE') });

    const dry = await cli(fixture, 'rebase', '--to', NEXT_PIN.version, '--dry-run', '--json');
    expect(json(dry)).toMatchObject({ status: 'dry-run', conflicts: [] });
    expect(await config(fixture.root)).toMatchObject({ firefox: { version: TEST_PIN.version } });

    await fixture.edit({ 'browser/base/content/loose.mjs': 'export {};\n' });
    const refused = await cli(fixture, 'rebase', '--to', NEXT_PIN.version);
    expect(refused.exitCode).toBe(ExitCode.PATCH_ERROR);
    expect(refused.stderr).toContain('browser/base/content/loose.mjs');
    await fixture.edit({ 'browser/base/content/loose.mjs': null });

    const rebased = await cli(fixture, 'rebase', '--to', NEXT_PIN.version, '--json');
    expect(rebased.stderr).toBe('');
    expect(json(rebased)).toMatchObject({ status: 'complete', pin: NEXT_PIN });
    expect(await config(fixture.root)).toMatchObject({ firefox: NEXT_PIN });
    expect((await git(fixture.engine, ['rev-parse', 'HEAD'])).trim()).toBe(next);
    expect(await fixture.read(MULTI)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    const [patch] = (await readQueue(fixture.patches)).patches;
    expect(patch?.firefox).toEqual(NEXT_PIN);
    expect((await cli(fixture, 'status', '--check')).exitCode).toBe(ExitCode.SUCCESS);
  }, 60_000);
  it('rebases over unexported engine edits under --force, keeping them in a recovery snapshot', async () => {
    await seedPristine(host(), { [MULTI]: LINES });
    await seedPristine(host(), { [MULTI]: LINES.replace('one', 'ONE') }, NEXT_PIN);
    const fixture = await createPatchProject(join(dir(), 'project'), {
      files: { [MULTI]: LINES },
    });
    await fixture.addPatch('ui-multi', { [MULTI]: LINES.replace('five', 'FIVE') });
    const loose = 'browser/base/content/loose.mjs';
    await fixture.edit({ [loose]: 'export const kept = 1;\n' });

    const refused = await cli(fixture, 'rebase', '--to', NEXT_PIN.version);
    expect(refused.exitCode).toBe(ExitCode.PATCH_ERROR);
    expect(refused.stderr).toContain('--force');
    const clash = await cli(fixture, 'rebase', '--to', NEXT_PIN.version, '--force', '--dry-run');
    expect(clash.exitCode).toBe(ExitCode.INVALID_ARGUMENT);

    const forced = await cli(fixture, 'rebase', '--to', NEXT_PIN.version, '--force', '--json');
    expect(json(forced)).toMatchObject({ status: 'complete', pin: NEXT_PIN });
    expect(await fixture.read(loose)).toBeUndefined();
    expect(await fixture.read(MULTI)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    const refs = (await git(fixture.engine, ['for-each-ref', '--format=%(refname)'])).split('\n');
    const recovery = refs.find((ref) => ref.includes('recovery'));
    expect(recovery).toBeDefined();
    expect(await git(fixture.engine, ['show', `${recovery ?? ''}:${loose}`])).toBe(
      'export const kept = 1;\n'
    );
  }, 60_000);

  it('aborts a paused patch-mode rebase back to the version, engine and queue it left', async () => {
    const first = await seedPristine(host(), { [MULTI]: LINES });
    await seedPristine(host(), { [MULTI]: LINES.replace('five', 'upstream') }, NEXT_PIN);
    const fixture = await createPatchProject(join(dir(), 'project'), {
      files: { [MULTI]: LINES },
    });
    await fixture.addPatch('ui-multi', { [MULTI]: LINES.replace('five', 'FIVE') });

    const paused = await cli(fixture, 'rebase', '--to', NEXT_PIN.version);
    expect(paused.exitCode).toBe(ExitCode.PATCH_ERROR);
    expect(await config(fixture.root)).toMatchObject({ firefox: NEXT_PIN });
    const second = await cli(fixture, 'rebase', '--to', '140.11.0esr');
    expect(second.exitCode).toBe(ExitCode.PATCH_ERROR);
    expect(second.stderr).toContain('fireforge rebase --abort');

    const aborted = await cli(fixture, 'rebase', '--abort', '--json');
    expect(aborted.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(aborted)).toMatchObject({ status: 'aborted', pin: TEST_PIN });
    expect(await config(fixture.root)).toMatchObject({ firefox: TEST_PIN });
    expect((await git(fixture.engine, ['rev-parse', 'HEAD'])).trim()).toBe(first);
    expect(await fixture.read(MULTI)).toBe(LINES.replace('five', 'FIVE'));
    expect((await cli(fixture, 'status', '--check')).exitCode).toBe(ExitCode.SUCCESS);
    const [patch] = (await readQueue(fixture.patches)).patches;
    expect(patch?.firefox).toEqual(TEST_PIN);
    // Nothing of the abandoned rebase is left to abort or continue.
    expect((await cli(fixture, 'rebase', '--abort')).exitCode).toBe(ExitCode.PATCH_ERROR);
  }, 60_000);
});

describe('fireforge setup', () => {
  const answers = ['--name', 'My Browser', '--vendor', 'Acme', '--firefox-version'];

  it('creates a patch-mode project from options alone, and refuses to guess or overwrite', async () => {
    const project = { root: dir() };
    const invalid = await cli(project, 'setup', ...answers, 'nonsense');
    expect(invalid.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(invalid.stderr).toContain('firefox.version');
    const missing = await cli(project, 'setup', '--name', 'My Browser');
    expect(missing.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(missing.stderr).toContain('--vendor is required');

    const created = await cli(project, 'setup', ...answers, '140.9.0esr', '--json');
    expect(created.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(created)).toMatchObject({
      mode: 'patches',
      appId: 'org.mybrowser.browser',
      binaryName: 'mybrowser',
      product: 'firefox-esr',
      license: 'EUPL-1.2',
      files: expect.arrayContaining([
        'fireforge.json',
        'configs/common.mozconfig',
        'LICENSE',
      ]) as unknown,
    });
    expect(await config(dir())).toEqual({
      name: 'My Browser',
      vendor: 'Acme',
      appId: 'org.mybrowser.browser',
      binaryName: 'mybrowser',
      license: 'EUPL-1.2',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    expect(await readFile(join(dir(), '.gitignore'), 'utf8')).toBe('engine/\n.fireforge/\n');
    expect((await cli(project, 'config', 'get', 'firefox.version')).stdout).toBe('140.9.0esr\n');
    // What setup writes without --license is the license an absent key means.
    expect(json(await cli(project, 'config', 'get', 'license', '--json'))).toMatchObject({
      value: 'EUPL-1.2',
      default: 'EUPL-1.2',
    });

    // The mode is not a key to set: the refusal names the command that changes it.
    const mode = await cli(project, 'config', 'set', 'mode', 'source');
    expect(mode.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(mode.stderr).toMatch(/^error\[config-mode-switch\]: "mode" cannot be set to "source"/);
    expect(mode.stderr).toMatch(/^hint: Run "fireforge migrate --to-source"/m);
    expect(await config(dir())).not.toHaveProperty('mode');

    // An existing project is never replaced, whatever the flags.
    const again = await cli(project, 'setup', ...answers, '140.9.0esr');
    expect(again.exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(again.stderr).toContain('fireforge config set');
    expect((await cli(project, 'setup', ...answers, '140.9.0esr', '--force')).exitCode).toBe(
      ExitCode.INVALID_ARGUMENT
    );
    expect((await cli(project, 'config', 'get', 'firefox.version')).stdout).toBe('140.9.0esr\n');
  });

  it('creates a source-mode project pinned to the pristine commit of its Firefox', async () => {
    const commit = await seedPristine(host());
    const project = { root: join(dir(), 'project') };
    await initRepo(project.root, { 'README.md': 'mine\n' });
    const created = await cli(
      project,
      'setup',
      ...answers,
      TEST_PIN.version,
      '--mode',
      'source',
      '--license',
      '0BSD'
    );
    expect(created.exitCode).toBe(ExitCode.SUCCESS);
    expect(await config(project.root)).toMatchObject({
      mode: 'source',
      source: { root: 'src', metadataRoot: '.fireforge-sources', pristineCommit: commit },
    });
    expect(await readFile(join(project.root, 'LICENSE'), 'utf8')).toContain('Acme');
    expect(await readFile(join(project.root, 'src/.gitattributes'), 'utf8')).toContain(
      'merge=fireforge'
    );
    expect((await cli(project, 'status', '--check')).stdout).toBe(
      '0 owned path(s) in 0 group(s)\nNothing is unaccounted for.\n'
    );
  });
});
