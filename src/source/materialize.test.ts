// SPDX-License-Identifier: EUPL-1.2
import { chmod, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configureLog } from '../kernel/log.js';
import type { SourceProject } from '../project/index.js';
import { git } from '../testing/git.js';
import { sourceUrl, startScript } from '../testing/script.js';
import { createSourceFixture, type SourceFixture } from '../testing/source.js';
import { useTempDir } from '../testing/temp.js';
import { materialize, type MaterializeResult, override, recordDeployment } from './index.js';

const dir = useTempDir();
const MANIFEST = 'browser/manifest.txt';
const SERVICE = 'toolkit/modules/Service.sys.mjs';
const PRISTINE_MANIFEST = 'first\nsecond\nthird\nfourth\nfifth\n';

interface Setup {
  value: SourceFixture;
  project: SourceProject;
  engine: string;
  state: string;
  run: () => Promise<MaterializeResult>;
}

const locked: string[] = [];
afterEach(async () => {
  for (const path of locked.splice(0)) await chmod(path, 0o755);
});

async function setup(): Promise<Setup> {
  const value = await createSourceFixture(dir());
  const project = await value.load();
  const engine = await value.engine(join(dir(), 'workspace', 'engine'));
  const state = join(dir(), 'workspace');
  return {
    value,
    project,
    engine,
    state,
    run: () => materialize(project, value.pristine, { engineDir: engine, stateDir: state }),
  };
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'none',
    (error: unknown) => (error as { code: string }).code
  );
}

const read = (root: string, path: string): Promise<string> => readFile(join(root, path), 'utf8');

const UNCHANGED = { written: [], restored: [], removed: [] };

/** Sets a file's modification time to `seconds` ago, past any timestamp granularity. */
async function age(path: string, seconds = 60): Promise<void> {
  const then = new Date(Date.now() - seconds * 1000);
  await utimes(path, then, then);
}

describe('materialize', () => {
  it('writes only what differs and does nothing when nothing changed', async () => {
    const { value, project, engine, run } = await setup();
    await override(project, value.pristine, MANIFEST);
    await value.write({ [`src/${MANIFEST}`]: 'local\n', 'src/browser/new.js': 'export {};\n' });
    expect(await run()).toEqual({
      written: [MANIFEST, 'browser/new.js'],
      restored: [],
      removed: [],
    });
    expect(await read(engine, MANIFEST)).toBe('local\n');
    expect(await run()).toEqual(UNCHANGED);
    await value.write({ 'src/browser/new.js': 'export const changed = 1;\n' });
    expect((await run()).written).toEqual(['browser/new.js']);
  });

  // Windows has no executable bit.
  it.skipIf(process.platform === 'win32')('keeps executable modes', async () => {
    const { value, project, engine, run } = await setup();
    await override(project, value.pristine, 'browser/run.sh');
    await value.write({ 'src/browser/run.sh': '#!/bin/sh\nexit 1\n' });
    await value.write(
      { 'src/browser/tool.sh': '#!/bin/sh\n' },
      { executable: ['src/browser/tool.sh'] }
    );
    await run();
    expect((await stat(join(engine, 'browser/run.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(engine, 'browser/tool.sh'))).mode & 0o111).not.toBe(0);
    await chmod(join(value.root, 'src/browser/tool.sh'), 0o644);
    expect((await run()).written).toEqual(['browser/tool.sh']);
    expect((await stat(join(engine, 'browser/tool.sh'))).mode & 0o111).toBe(0);
  });

  it('restores upstream for a removed override, deletes a removed creation, and honours tombstones', async () => {
    const { value, project, engine, run } = await setup();
    await override(project, value.pristine, MANIFEST);
    await override(project, value.pristine, SERVICE, { delete: true });
    await value.write({ [`src/${MANIFEST}`]: 'local\n', 'src/browser/new.js': 'export {};\n' });
    expect(await run()).toMatchObject({ removed: [SERVICE] });
    await expect(read(engine, SERVICE)).rejects.toThrow();
    await value.remove(
      `src/${MANIFEST}`,
      `.fireforge-sources/overrides/${MANIFEST}.json`,
      `.fireforge-sources/overrides/${SERVICE}.json`,
      'src/browser/new.js'
    );
    expect(await run()).toEqual({
      written: [],
      restored: [MANIFEST, SERVICE],
      removed: ['browser/new.js'],
    });
    expect(await read(engine, MANIFEST)).toBe(PRISTINE_MANIFEST);
    expect(await read(engine, SERVICE)).toBe('export const version = 1;\n');
    await expect(read(engine, 'browser/new.js')).rejects.toThrow();
  });

  it('never touches paths it does not own, and refuses to overwrite drift it cannot account for', async () => {
    const { value, engine, run } = await setup();
    await value.write({ 'src/browser/new.js': 'export {};\n' });
    await run();
    // Written by another step (a component deployment) at a path nobody owns.
    await writeFile(join(engine, 'browser/deployed.js'), 'deployed\n');
    await writeFile(join(engine, 'browser/base/jar.mn'), 'registered by a deployment\n');
    expect(await run()).toEqual(UNCHANGED);
    expect(await read(engine, 'browser/deployed.js')).toBe('deployed\n');
    // An owned output edited in the engine.
    await writeFile(join(engine, 'browser/new.js'), 'foreign\n');
    await value.write({ 'src/browser/new.js': 'export const next = 1;\n' });
    expect(await failureCode(run())).toBe('materialize-drift');
    expect(await read(engine, 'browser/new.js')).toBe('foreign\n');
    // A path someone else wrote that the checkout starts to own.
    await value.write({ 'src/browser/deployed.js': 'now owned\n' });
    expect(await failureCode(run())).toBe('materialize-drift');
    expect(await read(engine, 'browser/deployed.js')).toBe('deployed\n');
    expect(await read(engine, 'browser/base/jar.mn')).toBe('registered by a deployment\n');
  });

  it('counts what a deployment wrote over an owned file as accounted for', async () => {
    const { value, project, engine, state, run } = await setup();
    const JAR = 'browser/base/jar.mn';
    await override(project, value.pristine, JAR);
    await value.write({ [`src/${JAR}`]: 'browser.jar:\n  owned line\n' });
    await run();
    // A component deployment registers itself in the owned manifest.
    await writeFile(join(engine, JAR), 'browser.jar:\n  owned line\n  component line\n');
    expect(await failureCode(run())).toBe('materialize-drift');
    await recordDeployment(value.pristine, { engineDir: engine, stateDir: state }, [JAR]);
    expect(await run()).toEqual(UNCHANGED);
    expect(await read(engine, JAR)).toBe('browser.jar:\n  owned line\n  component line\n');
    // A new owned version replaces the deployed bytes; the deployment registers again after.
    await value.write({ [`src/${JAR}`]: 'browser.jar:\n  second line\n' });
    expect((await run()).written).toEqual([JAR]);
    expect(await read(engine, JAR)).toBe('browser.jar:\n  second line\n');
    // Given back, the deployed bytes are restored to upstream like the owned ones.
    await writeFile(join(engine, JAR), 'browser.jar:\n  second line\n  component line\n');
    await recordDeployment(value.pristine, { engineDir: engine, stateDir: state }, [JAR]);
    await value.remove(`src/${JAR}`, `.fireforge-sources/overrides/${JAR}.json`);
    expect((await run()).restored).toEqual([JAR]);
  });

  it('reads a file whose size and mtime match but which changed', async () => {
    const { value, engine, run } = await setup();
    const owned = join(value.root, 'src/browser/new.js');
    await value.write({ 'src/browser/new.js': 'export const a = 1;\n' });
    const { mtime } = await stat(owned);
    await run();
    // Same size, same mtime: an edit within one tick of a coarse timestamp.
    await writeFile(owned, 'export const b = 2;\n');
    await utimes(owned, mtime, mtime);
    expect((await run()).written).toEqual(['browser/new.js']);
    expect(await read(engine, 'browser/new.js')).toBe('export const b = 2;\n');
    // An old mtime does not vouch for a rewrite that put it back: the inode's change time moved.
    await age(owned);
    await run();
    const aged = await stat(owned);
    await writeFile(owned, 'export const c = 3;\n');
    await utimes(owned, aged.atime, aged.mtime);
    expect((await run()).written).toEqual(['browser/new.js']);
    expect(await read(engine, 'browser/new.js')).toBe('export const c = 3;\n');
  });

  it('refuses an owned file with an unresolved merge conflict', async () => {
    const { value, run } = await setup();
    await value.write({ 'src/browser/new.js': 'base\n' });
    await value.commit('base');
    await git(value.root, ['checkout', '-q', '-b', 'other']);
    await value.write({ 'src/browser/new.js': 'theirs\n' });
    await value.commit('theirs');
    await git(value.root, ['checkout', '-q', '-']);
    await value.write({ 'src/browser/new.js': 'ours\n' });
    await value.commit('ours');
    await git(value.root, ['merge', '-q', 'other']).catch(() => undefined);
    expect(await failureCode(run())).toBe('source-invalid');
  });

  it('undoes a run killed in the middle before planning the next', async () => {
    const { value, project, engine, state, run } = await setup();
    await override(project, value.pristine, MANIFEST);
    await override(project, value.pristine, SERVICE);
    await value.write({ [`src/${MANIFEST}`]: 'v1\n', [`src/${SERVICE}`]: 'v1\n' });
    await run();
    await value.write({ [`src/${MANIFEST}`]: 'v2 manifest\n', [`src/${SERVICE}`]: 'v2 service\n' });
    // What a run killed after its first write leaves: that write, and the journal.
    const script = join(dir(), 'killed-run.mts');
    await writeFile(
      script,
      [
        `import { transaction } from '${sourceUrl('kernel/journal.ts')}';`,
        `await transaction(${JSON.stringify(join(state, 'source-materialize.journal'))}, 'the materialization', async (tx) => {`,
        `  await tx.write(${JSON.stringify(join(engine, MANIFEST))}, 'v2 manifest\\n');`,
        `  process.kill(process.pid, 'SIGKILL');`,
        `});`,
        '',
      ].join('\n')
    );
    await startScript(script, [], { cwd: dir() }).result;
    expect(await read(engine, MANIFEST)).toBe('v2 manifest\n');
    const logged: string[] = [];
    const previous = configureLog({ write: (text) => logged.push(text) });
    try {
      expect((await run()).written).toEqual([MANIFEST, SERVICE]);
    } finally {
      configureLog(previous);
    }
    expect(logged.join('')).toContain('Undid an interrupted run of the materialization');
    expect(await read(engine, MANIFEST)).toBe('v2 manifest\n');
    expect(await read(engine, SERVICE)).toBe('v2 service\n');
    expect(await run()).toEqual(UNCHANGED);
  });

  it.each([
    { from: 'file', to: 'directory' },
    { from: 'directory', to: 'file' },
  ] as const)('turns a $from into a $to', async ({ from, to }) => {
    const { value, engine, run } = await setup();
    const shape = async (kind: 'file' | 'directory'): Promise<void> => {
      await value.remove('src/browser/dir');
      await value.write(
        kind === 'file'
          ? { 'src/browser/dir': 'as a file\n' }
          : { 'src/browser/dir/inner.js': 'as a directory\n' }
      );
    };
    await shape(from);
    await run();
    await shape(to);
    await run();
    if (to === 'file') expect(await read(engine, 'browser/dir')).toBe('as a file\n');
    else expect(await read(engine, 'browser/dir/inner.js')).toBe('as a directory\n');
    expect(await run()).toEqual(UNCHANGED);
  });

  // Windows does not make a directory read-only through its mode.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rolls a failed run back, and the next run completes it',
    async () => {
      const { value, project, engine, run } = await setup();
      await override(project, value.pristine, MANIFEST);
      await run();
      await value.write({
        [`src/${MANIFEST}`]: 'second run\n',
        'src/toolkit/modules/New.sys.mjs': 'export {};\n',
      });
      const blocked = join(engine, 'toolkit/modules');
      await chmod(blocked, 0o555);
      locked.push(blocked);
      await expect(run()).rejects.toThrow();
      expect(await read(engine, MANIFEST)).toBe(PRISTINE_MANIFEST);
      await chmod(blocked, 0o755);
      expect((await run()).written).toEqual([MANIFEST, 'toolkit/modules/New.sys.mjs']);
      expect(await read(engine, MANIFEST)).toBe('second run\n');
    }
  );

  // Windows does not make a directory read-only through its mode.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'undoes an interrupted run whose rollback could not finish before the next run',
    async () => {
      const { value, project, engine, run } = await setup();
      await override(project, value.pristine, MANIFEST);
      await override(project, value.pristine, SERVICE);
      await run();
      await value.write({
        [`src/${MANIFEST}`]: 'second run\n',
        [`src/${SERVICE}`]: 'export {};\n',
      });
      const blocked = join(engine, 'toolkit/modules');
      await chmod(blocked, 0o555);
      locked.push(blocked);
      const logged: string[] = [];
      const previous = configureLog({ write: (text) => logged.push(text) });
      try {
        // The write and its undo both fail in the locked directory: the journal stays behind.
        await expect(run()).rejects.toThrow();
        await chmod(blocked, 0o755);
        expect((await run()).written).toEqual([MANIFEST, SERVICE]);
      } finally {
        configureLog(previous);
      }
      expect(logged.join('')).toContain('Undid an interrupted run of the materialization');
      expect(await read(engine, SERVICE)).toBe('export {};\n');
    }
  );

  it('refuses owned files whose content is undefined', async () => {
    const { value, run } = await setup();
    await value.write({ 'src/browser/manifest.txt/inner.js': 'under an upstream file\n' });
    expect(await failureCode(run())).toBe('source-invalid');
  });
});
