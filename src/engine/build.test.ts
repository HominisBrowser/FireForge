// SPDX-License-Identifier: EUPL-1.2
import { cp, lstat, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { makeEngineProject, makeProjectEngine, useMachSandbox } from '../testing/engine.js';
import { readMachLog, scriptMach, SYNTHETIC_FIREFOX_PATHS as PATHS } from '../testing/firefox.js';
import { type FileTree, useTempDir, writeTree } from '../testing/temp.js';
import { build } from './build.js';
import { withBuildSlot } from './hostLocks.js';
import { discardMovedObjdir, requireBuilt } from './objdir.js';
import { buildStaleness, readBuildBaseline } from './staleness.js';
import { type Workspace, workspaceAt } from './workspace.js';

const dir = useTempDir();
const logged = useMachSandbox();

async function workspaceWith(
  config: Record<string, unknown> = {},
  engineFiles: FileTree = {}
): Promise<Workspace> {
  return makeProjectEngine(await makeEngineProject(dir(), { config }), engineFiles);
}

const machCalls = async (workspace: Workspace): Promise<string[]> =>
  (await readMachLog(workspace.engineDir)).map((call) => call.args.join(' '));

describe('build', () => {
  it('writes the mozconfig, runs a full build and records it', async () => {
    const workspace = await workspaceWith({ build: { jobs: 6 } });
    await expect(requireBuilt(workspace)).rejects.toMatchObject({
      code: 'build-missing',
      exitCode: ExitCode.BUILD_ERROR,
    });
    const result = await build(workspace);
    expect(result).toMatchObject({
      kind: 'full',
      unpackaged: [],
    });
    expect(result.discardedObjdirOf).toBeUndefined();
    expect(await machCalls(workspace)).toEqual(['build -j 6']);
    expect(await readFile(join(workspace.engineDir, 'mozconfig'), 'utf8')).toContain(
      'MOZ_OBJDIR=@TOPSRCDIR@/obj-fireforge'
    );
    expect(await requireBuilt(workspace)).toContain(join('obj-fireforge', 'dist'));
    expect(await readBuildBaseline(workspace)).toMatchObject({ kind: 'full' });
    await build(workspace, { jobs: 2 });
    expect((await machCalls(workspace)).at(-1)).toBe('build -j 2');
  });

  it('runs a UI build when asked and nothing needs more', async () => {
    const workspace = await workspaceWith();
    await build(workspace);
    await writeTree(workspace.engineDir, { [PATHS.browserScript]: '// edited\n' });
    const result = await build(workspace, { ui: true });
    expect(result.kind).toBe('ui');
    expect(result.escalated).toBeUndefined();
    expect(await machCalls(workspace)).toEqual(['build', 'build faster']);
  });

  it('runs a full build instead of a UI build when the workspace needs one, and says why', async () => {
    const workspace = await workspaceWith();
    const first = await build(workspace, { ui: true });
    expect(first).toMatchObject({
      kind: 'full',
      escalated: 'no build of this workspace is recorded',
    });
    await writeTree(workspace.engineDir, { 'dom/base/Thing.cpp': 'int thing;\n' });
    const second = await build(workspace, { ui: true });
    expect(second.kind).toBe('full');
    expect(second.escalated).toContain('dom/base/Thing.cpp');
    expect(logged()).toContain('Running a full build instead of a UI build');
    expect(await machCalls(workspace)).toEqual(['build', 'build']);
  });

  it('fails with the build exit code and records nothing when mach fails', async () => {
    const workspace = await workspaceWith();
    await scriptMach(workspace.engineDir, 'build', { stderr: ['error: no'], exit: 2 });
    await expect(build(workspace)).rejects.toMatchObject({
      code: 'build-failed',
      exitCode: ExitCode.BUILD_ERROR,
      message: expect.stringMatching(/^mach build exited 2 after /) as string,
    });
    expect(await readBuildBaseline(workspace)).toBeUndefined();
    await scriptMach(workspace.engineDir, 'build', { exit: 137 });
    await expect(build(workspace)).rejects.toMatchObject({
      message: expect.stringContaining('killed by SIGKILL') as string,
    });
  });

  it('records the engine as the build started reading it, so an edit made meanwhile stays stale', async () => {
    const workspace = await workspaceWith();
    await build(workspace);
    await scriptMach(workspace.engineDir, 'build', { sleep: 1.5 });
    const running = build(workspace);
    await new Promise((settle) => setTimeout(settle, 700));
    await writeFile(join(workspace.engineDir, PATHS.mozbuild), '# edited while the build ran\n');
    await running;
    expect(await buildStaleness(workspace)).toMatchObject({
      state: 'stale',
      needs: 'full',
      paths: [PATHS.mozbuild],
    });
  });

  it('waits for a host build slot', async () => {
    const workspace = await workspaceWith();
    const attempt = withBuildSlot(workspace.project.host, 0, () => build(workspace, { waitMs: 0 }));
    await expect(attempt).rejects.toMatchObject({
      code: 'lock-timeout',
      exitCode: ExitCode.LOCK_TIMEOUT,
    });
    expect(await machCalls(workspace)).toEqual([]);
  });

  it('warns about a changed front-end file that nothing packages', async () => {
    const workspace = await workspaceWith({
      buildAudit: { unpackaged: [{ path: 'browser/tools/*.js', reason: 'developer tool' }] },
    });
    await build(workspace);
    await writeTree(workspace.engineDir, {
      [PATHS.browserScript]: '// registered in jar.mn\n',
      'browser/base/content/orphan.js': '// registered nowhere\n',
      'browser/base/content/part.inc.xhtml': '<!-- included -->\n',
      'browser/base/content/test/browser_orphan.js': '// a test\n',
      'browser/tools/helper.js': '// declared\n',
      'browser/modules/Listed.sys.mjs': '// in moz.build\n',
      [PATHS.mozbuild]: 'DIRS += ["newtab"]\nEXTRA_JS_MODULES += [\n    "Listed.sys.mjs",\n]\n',
    });
    const result = await build(workspace);
    expect(result.unpackaged).toEqual(['browser/base/content/orphan.js']);
    expect(logged()).toContain('1 changed file(s) are not packaged');
    // Once built, the same file is no longer a change, so the next build is quiet.
    expect((await build(workspace)).unpackaged).toEqual([]);
  });
});

describe('an object directory that came from another path', () => {
  /**
   * What a real object directory still holds about the source it was built
   * from after `mach configure` has run at a new path: none of these is
   * configure's output, and nothing makes the build regenerate them.
   */
  const builtRecords = (engineDir: string, objDir: string): FileTree => ({
    '.cargo/config.toml': [
      '[source.crates-io]',
      'replace-with = "vendored-sources"',
      '',
      '[source.vendored-sources]',
      `directory = "${engineDir}/third_party/rust"`,
      '',
    ].join('\n'),
    '.mozconfig-client-mk': `MOZ_OBJDIR=${objDir}\nOBJDIR=${objDir}\nFOUND_MOZCONFIG=${engineDir}/mozconfig\nexport FOUND_MOZCONFIG\n`,
    // The generator writes every character outside its safe set as an escape, the dot included.
    'build/rust/mozbuild/buildconfig.rs': `pub const TOPSRCDIR: &str = "${engineDir.replaceAll('.', '\\u{2e}')}";\n`,
    'aarch64-apple-darwin/release/build/mozglue-static-068ecad25dac9508/output': [
      `cargo:rerun-if-changed=${engineDir}/mozglue/static/rust/wrappers.cpp`,
      `cargo:rustc-link-search=native=${objDir}/aarch64-apple-darwin/release/build/mozglue-static-068ecad25dac9508/out`,
      '',
    ].join('\n'),
    'aarch64-apple-darwin/release/build/webrender-2e2612cf7d6f03f3/out/shaders.rs': `shaders.insert("base", SourceWithDigest { source: include_str!("${engineDir}/gfx/wr/webrender/res/base.glsl"), digest: "d5ae695bab268b7d"});\n`,
    'browser/base/.deps/thing.o.pp': `thing.o: ${engineDir}/browser/base/thing.cpp ${objDir}/dist/include/mozilla-config.h\n${engineDir}/browser/base/thing.cpp:\n`,
    'install_dist_bin.track': `4\n1actors/Thing.sys.mjs\x1f${engineDir}/toolkit/actors/Thing.sys.mjs\n`,
    'config.statusd/substs/top_srcdir': `"${engineDir}"\n`,
  });

  /** Builds at one path, then copies the engine with its object directory to a second project. */
  async function moved(): Promise<{ from: Workspace; to: Workspace }> {
    const from = await makeProjectEngine(await makeEngineProject(dir(), {}, 'first'));
    await build(from);
    await writeTree(from.objDir, builtRecords(from.engineDir, from.objDir));
    await symlink(
      join(from.engineDir, PATHS.browserScript),
      join(from.objDir, 'dist/bin/browser.js')
    );
    const project = await makeEngineProject(dir(), {}, 'second');
    await cp(from.engineDir, join(project.root, 'engine'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    const to = workspaceAt(project, {
      name: 'engine',
      kind: 'project',
      engineDir: join(project.root, 'engine'),
      stateDir: project.paths.stateDir,
      stateFile: project.paths.state,
    });
    await writeFile(join(to.engineDir, '.mach-state/commands.jsonl'), '');
    return { from, to };
  }

  it('is discarded whole by the next build, which starts from nothing', async () => {
    const { from, to } = await moved();
    expect(await buildStaleness(to)).toMatchObject({ needs: 'full' });
    const result = await build(to, { ui: true });
    expect(result).toMatchObject({ kind: 'full', discardedObjdirOf: from.engineDir });
    expect(logged()).toContain(`was configured for ${from.engineDir}`);
    expect(logged()).toContain('full build from nothing');
    // No configure over the old directory: the build configures the new one itself.
    expect(await machCalls(to)).toEqual(['build']);

    // Nothing the old build recorded survives, in any spelling of its path.
    for (const path of Object.keys(builtRecords(from.engineDir, from.objDir))) {
      await expect(lstat(join(to.objDir, path))).rejects.toThrow();
    }
    await expect(lstat(join(to.objDir, 'dist/bin/browser.js'))).rejects.toThrow();
    const mozinfo = JSON.parse(await readFile(join(to.objDir, 'mozinfo.json'), 'utf8')) as object;
    expect(mozinfo).toMatchObject({ topsrcdir: to.engineDir, topobjdir: to.objDir });
    expect(await buildStaleness(to)).toEqual({ state: 'fresh' });
    expect((await build(to)).discardedObjdirOf).toBeUndefined();
  });

  it('leaves the workspace it came from untouched', async () => {
    const { from, to } = await moved();
    await build(to);
    expect(await readFile(join(from.objDir, '.cargo/config.toml'), 'utf8')).toContain(
      `directory = "${from.engineDir}/third_party/rust"`
    );
    expect(await readlink(join(from.objDir, 'dist/bin/browser.js'))).toBe(
      join(from.engineDir, PATHS.browserScript)
    );
    expect(await readFile(join(from.engineDir, PATHS.browserScript), 'utf8')).toBe(
      await readFile(join(to.engineDir, PATHS.browserScript), 'utf8')
    );
    expect(await discardMovedObjdir(from)).toBeUndefined();
    expect((await build(from)).discardedObjdirOf).toBeUndefined();
  });

  it('is discarded when only the object directory was configured under another name', async () => {
    const workspace = await workspaceWith();
    await build(workspace);
    const mozinfoPath = join(workspace.objDir, 'mozinfo.json');
    const mozinfo = JSON.parse(await readFile(mozinfoPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      mozinfoPath,
      JSON.stringify({
        ...mozinfo,
        topobjdir: join(workspace.engineDir, 'obj-aarch64-apple-darwin27.2.0'),
      })
    );
    expect(await buildStaleness(workspace)).toMatchObject({
      needs: 'full',
      why: 'the object directory was configured at another path and cannot be used here',
    });
    expect(await discardMovedObjdir(workspace)).toBe(workspace.engineDir);
    await expect(lstat(workspace.objDir)).rejects.toThrow();
    expect(await buildStaleness(workspace)).toMatchObject({
      needs: 'full',
      why: 'the object directory holds no launchable browser',
    });
  });

  it('is kept when it was never configured', async () => {
    const workspace = await workspaceWith();
    await writeTree(workspace.objDir, { 'partial.o': 'left by an interrupted configure\n' });
    expect(await discardMovedObjdir(workspace)).toBeUndefined();
    expect((await lstat(join(workspace.objDir, 'partial.o'))).isFile()).toBe(true);
  });
});
