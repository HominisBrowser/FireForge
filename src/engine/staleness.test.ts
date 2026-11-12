// SPDX-License-Identifier: EUPL-1.2
import { mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeEngineProject, makeProjectEngine, useMachSandbox } from '../testing/engine.js';
import { SYNTHETIC_FIREFOX_PATHS as PATHS } from '../testing/firefox.js';
import { commitAll } from '../testing/git.js';
import { type FileTree, useTempDir, writeTree } from '../testing/temp.js';
import { build } from './build.js';
import { deliveryOf, readInstallIndex } from './installManifests.js';
import { buildInputClass, buildStaleness, isTestPath, readBuildBaseline } from './staleness.js';
import type { Workspace } from './workspace.js';

const dir = useTempDir();
useMachSandbox();

/** A workspace whose engine was just built in full. */
async function built(extra: FileTree = {}): Promise<Workspace> {
  const workspace = await makeProjectEngine(await makeEngineProject(dir()), extra);
  await build(workspace);
  return workspace;
}

const edit = (workspace: Workspace, files: FileTree): Promise<void> =>
  writeTree(workspace.engineDir, files);

describe('buildInputClass', () => {
  it.each([
    ['dom/base/nsDocument.cpp', 'full'],
    ['dom/base/nsDocument.h', 'full'],
    ['servo/components/style/lib.rs', 'full'],
    ['dom/webidl/Window.webidl', 'full'],
    ['xpcom/ds/nsIArray.idl', 'full'],
    ['modules/libpref/init/StaticPrefList.yaml', 'full'],
    ['toolkit/library/rust/Cargo.toml', 'full'],
    ['browser/components/example/components.conf', 'full'],
    ['browser/modules/moz.build', 'full'],
    ['browser/moz.configure', 'full'],
    ['build/moz.configure/toolchain.configure', 'full'],
    ['toolkit/toolkit.mozbuild', 'full'],
    ['config/Makefile.in', 'full'],
    ['browser/base/jar.mn', 'jar'],
    ['browser/base/content/browser.js', 'ui'],
    ['toolkit/components/example/service.sys.mjs', 'ui'],
    ['browser/themes/shared/browser.css', 'ui'],
    ['browser/locales/en-US/browser/browser.ftl', 'ui'],
    ['browser/base/content/main.inc.xhtml', 'ui'],
    ['browser/app/profile/firefox.js', 'ui'],
    ['browser/themes/shared/chrome/icon.svg', 'ui'],
    // Compiled sources of tests never reach the browser binary.
    ['dom/base/test/gtest/TestThing.cpp', undefined],
    ['testing/web-platform/meta/foo.yml', undefined],
    ['taskcluster/kinds/build/kind.yml', undefined],
    ['browser/base/content/test/browser.toml', undefined],
    ['README.md', undefined],
    ['browser/branding/unofficial/default16.png', undefined],
  ])('%s is %s', (path, expected) => {
    expect(buildInputClass(path)).toBe(expected);
  });
});

describe('isTestPath', () => {
  it.each([
    ['browser/base/content/test/general/head.js', true],
    ['toolkit/components/x/tests/unit/test_x.js', true],
    ['testing/mochitest/api.js', true],
    ['third_party/x/testing/lib.js', true],
    ['browser/components/x/browser_thing.js', true],
    ['browser/components/x/test_thing.js', true],
    ['browser/base/content/browser.js', false],
    ['browser/components/contest/entry.js', false],
  ])('%s: %s', (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});

describe('buildStaleness', () => {
  it('is stale, needing a full build, until a build is recorded', async () => {
    const workspace = await makeProjectEngine(await makeEngineProject(dir()));
    expect(await buildStaleness(workspace)).toEqual({
      state: 'stale',
      paths: [],
      needs: 'full',
      why: 'no build of this workspace is recorded',
    });
    await build(workspace);
    expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
  });

  it('needs a UI build for a changed, added or deleted packaged file', async () => {
    const workspace = await built();
    await edit(workspace, {
      [PATHS.browserScript]: 'export const browserTitle = "edited";\n',
      'browser/base/content/added.js': '// new\n',
    });
    await rm(join(workspace.engineDir, PATHS.serviceModule));
    expect(await buildStaleness(workspace)).toMatchObject({
      state: 'stale',
      needs: 'ui',
      paths: ['browser/base/content/added.js', PATHS.browserScript, PATHS.serviceModule],
    });
    // Putting the content back makes it fresh again: staleness is about content, not time.
    await edit(workspace, {
      [PATHS.browserScript]: 'export const browserTitle = "baseline";\n',
      [PATHS.serviceModule]: 'export const version = 1;\n',
    });
    await rm(join(workspace.engineDir, 'browser/base/content/added.js'));
    expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
  });

  it('sees a change whether or not it was committed in the engine', async () => {
    const workspace = await built();
    await edit(workspace, { [PATHS.browserScript]: '// committed later\n' });
    await commitAll(workspace.engineDir, 'edit');
    expect(await buildStaleness(workspace)).toMatchObject({ needs: 'ui' });
  });

  it('needs a full build for compiled sources and build definitions, which a UI build does not clear', async () => {
    const workspace = await built();
    await edit(workspace, {
      'dom/base/Thing.cpp': 'int thing;\n',
      [PATHS.mozbuild]: 'DIRS += ["newtab", "other"]\n',
      [PATHS.browserScript]: '// also edited\n',
    });
    const stale = await buildStaleness(workspace);
    expect(stale).toMatchObject({
      state: 'stale',
      needs: 'full',
      paths: [PATHS.mozbuild, 'dom/base/Thing.cpp'],
    });
    // A UI build that ran anyway (from another tool) leaves the compiled change outstanding.
    const { recordBuild, snapshotEngine } = await import('./staleness.js');
    await recordBuild(workspace, 'ui', await snapshotEngine(workspace));
    expect(await buildStaleness(workspace)).toMatchObject({
      needs: 'full',
      paths: [PATHS.mozbuild, 'dom/base/Thing.cpp'],
    });
    await recordBuild(workspace, 'full', await snapshotEngine(workspace));
    expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
  });

  it('ignores tests, documentation and compiled test sources', async () => {
    const workspace = await built();
    await edit(workspace, {
      'browser/base/content/test/browser_thing.js': '// test\n',
      'browser/base/content/test/browser.toml': '["browser_thing.js"]\n',
      'dom/base/test/gtest/TestThing.cpp': 'int test;\n',
      'README.md': 'notes\n',
    });
    expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
  });

  it('needs a full build when the configuration changed', async () => {
    const workspace = await built();
    await writeTree(workspace.project.root, {
      [`configs/${process.platform}.mozconfig`]: 'ac_add_options --enable-debug\n',
    });
    expect(await buildStaleness(workspace)).toMatchObject({
      needs: 'full',
      paths: ['mozconfig'],
      why: expect.stringContaining('configuration') as string,
    });
  });

  it('needs a full build when the browser binary is gone', async () => {
    const workspace = await built();
    await rm(join(workspace.objDir, 'dist'), { recursive: true });
    expect(await buildStaleness(workspace)).toMatchObject({
      needs: 'full',
      why: 'the object directory holds no launchable browser',
    });
  });

  describe('jar.mn', () => {
    const ENTRY = '        content/browser/more.js              (content/more.js)\n';

    it('needs only a UI build for an entry added to a manifest the last full build knew', async () => {
      const workspace = await built();
      await edit(workspace, {
        [PATHS.jarManifest]: `browser.jar:\n        content/browser/browser.js              (content/browser.js)\n${ENTRY}`,
      });
      expect(await buildStaleness(workspace)).toMatchObject({
        needs: 'ui',
        paths: [PATHS.jarManifest],
      });
    });

    it('needs a full build for a new manifest, also after a UI build, and for one that redirects its base', async () => {
      const workspace = await built();
      await edit(workspace, { 'browser/extra/jar.mn': `extra.jar:\n${ENTRY}` });
      expect(await buildStaleness(workspace)).toMatchObject({
        needs: 'full',
        paths: ['browser/extra/jar.mn'],
      });
      const { recordBuild, snapshotEngine } = await import('./staleness.js');
      await recordBuild(workspace, 'ui', await snapshotEngine(workspace));
      expect(await buildStaleness(workspace)).toMatchObject({ needs: 'full' });
      await recordBuild(workspace, 'full', await snapshotEngine(workspace));
      expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });

      await edit(workspace, {
        [PATHS.jarManifest]: `[localization] browser.jar:\n${ENTRY}`,
      });
      expect(await buildStaleness(workspace)).toMatchObject({
        needs: 'full',
        paths: [PATHS.jarManifest],
      });
    });
  });

  describe('with install manifests in the object directory', () => {
    /** Installs engine files into `dist/bin` the way the faster backend records it. */
    async function install(
      workspace: Workspace,
      entries: ReadonlyArray<{ type: '1' | '2'; destination: string; source: string }>
    ): Promise<void> {
      const { engineDir, objDir } = workspace;
      await writeTree(objDir, {
        'faster/Makefile': 'INSTALL_MANIFESTS = dist/bin\n',
        'faster/install_dist_bin':
          '5\n' +
          entries
            .map((entry) => [entry.type, entry.destination, join(engineDir, entry.source)])
            .map((fields) => `${fields.join('\x1f')}\n`)
            .join(''),
        '_build_manifests/install/_test_files': `5\n1\x1fbrowser/head.js\x1f${join(engineDir, 'browser/base/content/test/head.js')}\n`,
      });
      for (const entry of entries) {
        const destination = join(objDir, 'dist/bin', entry.destination);
        await mkdir(dirname(destination), { recursive: true });
        if (entry.type === '1') await symlink(join(engineDir, entry.source), destination);
        else await writeTree(objDir, { [`dist/bin/${entry.destination}`]: 'copy\n' });
      }
    }

    it('does not count an edit the object directory serves by symlink', async () => {
      const workspace = await built();
      await install(workspace, [
        { type: '1', destination: 'chrome/browser.js', source: PATHS.browserScript },
        { type: '2', destination: 'modules/service.sys.mjs', source: PATHS.serviceModule },
      ]);
      await edit(workspace, { [PATHS.browserScript]: '// live through the symlink\n' });
      expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
      await edit(workspace, { [PATHS.serviceModule]: '// copied at build time\n' });
      expect(await buildStaleness(workspace)).toMatchObject({
        needs: 'ui',
        paths: [PATHS.serviceModule],
      });
    });

    it('classifies each way a file reaches the browser', async () => {
      const workspace = await built();
      await install(workspace, [
        { type: '1', destination: 'chrome/browser.js', source: PATHS.browserScript },
        { type: '2', destination: 'modules/service.sys.mjs', source: PATHS.serviceModule },
        { type: '1', destination: 'chrome/dangling.js', source: 'browser/base/content/gone.js' },
      ]);
      const { engineDir, objDir } = workspace;
      const index = await readInstallIndex(engineDir, objDir);
      expect(index).toBeDefined();
      if (index === undefined) return;
      const delivery = (path: string): Promise<string> => deliveryOf(index, engineDir, path);
      expect(await delivery(PATHS.browserScript)).toBe('live');
      expect(await delivery(PATHS.serviceModule)).toBe('packaged');
      expect(await delivery('browser/base/content/gone.js')).toBe('packaged');
      expect(await delivery('browser/base/content/test/head.js')).toBe('at-test');
      expect(await delivery('browser/base/content/unknown.js')).toBe('unlisted');
      expect(await readInstallIndex(engineDir, join(objDir, 'absent'))).toBeUndefined();
    });
  });

  it('records the kind of the last build and keeps the full snapshot across UI builds', async () => {
    const workspace = await built();
    const full = await readBuildBaseline(workspace);
    expect(full).toMatchObject({ kind: 'full' });
    expect(full?.tree).toBe(full?.fullTree);
    await edit(workspace, { [PATHS.browserScript]: '// edited\n' });
    const result = await build(workspace, { ui: true });
    expect(result.kind).toBe('ui');
    const ui = await readBuildBaseline(workspace);
    expect(ui).toMatchObject({ kind: 'ui', fullTree: full?.fullTree });
    expect(ui?.tree).not.toBe(full?.tree);
    expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
  });
});
