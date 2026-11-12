// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { hash } from '../kernel/hash.js';
import { loadProject } from '../project/index.js';
import { useMachSandbox } from '../testing/engine.js';
import { readMachLog, writeSyntheticFirefox } from '../testing/firefox.js';
import { initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { build } from './build.js';
import { composeReleaseMozconfig, matchReleaseOutput, packageBrowser } from './package.js';
import { type Workspace, workspaceAt } from './workspace.js';

const dir = useTempDir();
useMachSandbox();
const OVERLAY = 'ac_add_options --disable-tests\n';

/** A patch-mode project over a synthetic engine, with the given `build` section. */
async function workspaceWith(buildSection?: unknown): Promise<Workspace> {
  const root = join(dir(), 'project');
  await writeTree(root, {
    'fireforge.json': JSON.stringify({
      name: 'Test Browser',
      vendor: 'Test',
      appId: 'org.example.testbrowser',
      binaryName: 'testbrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      ...(buildSection === undefined ? {} : { build: buildSection }),
    }),
    'configs/common.mozconfig': 'ac_add_options --enable-application=browser\n',
    [`configs/${process.platform}.mozconfig`]: '# platform\n',
    'configs/release.mozconfig': OVERLAY,
  });
  const engineDir = join(root, 'engine');
  await writeSyntheticFirefox(engineDir, {
    '.mach-state/binary-name': 'testbrowser',
    '.mach-state/record-env': 'RELEASE_KEYS\n',
  });
  await initRepo(engineDir);
  const project = await loadProject(root, { FIREFORGE_HOME: join(dir(), 'home') });
  return workspaceAt(project, {
    name: 'engine',
    kind: 'project',
    engineDir,
    stateDir: project.paths.stateDir,
    stateFile: project.paths.state,
  });
}

describe('the release recipe', () => {
  it('puts the overlay after the generated options and the object directory last', () => {
    expect(composeReleaseMozconfig('generated\n\n', 'overlay\n', '/ws/obj')).toBe(
      'generated\n\n# Release overlay\noverlay\n\nmk_add_options MOZ_OBJDIR="/ws/obj"\n'
    );
  });

  it('matches a declared output exactly, or by a * in its last segment', async () => {
    const objDir = join(dir(), 'obj');
    await writeTree(objDir, {
      'dist/a.dmg': '',
      'dist/b.dmg': '',
      'dist/notes.txt': '',
      'dist/host/bin/mar': '',
      'config.status': '',
    });
    expect(await matchReleaseOutput(objDir, 'dist/*.dmg')).toEqual(['dist/a.dmg', 'dist/b.dmg']);
    expect(await matchReleaseOutput(objDir, 'dist/host/bin/mar')).toEqual(['dist/host/bin/mar']);
    expect(await matchReleaseOutput(objDir, 'config.*')).toEqual(['config.status']);
    expect(await matchReleaseOutput(objDir, 'dist/*.zip')).toEqual([]);
    expect(await matchReleaseOutput(objDir, 'absent/*.zip')).toEqual([]);
  });
});

describe('packageBrowser', () => {
  it('packages the development build and refuses a missing one', async () => {
    const workspace = await workspaceWith();
    await expect(packageBrowser(workspace)).rejects.toMatchObject({ code: 'build-missing' });
    await build(workspace, {});
    const result = await packageBrowser(workspace);
    expect(result).toEqual({
      objDir: workspace.objDir,
      outputs: [join(workspace.objDir, 'dist', 'testbrowser.package')],
    });
  });

  it('refuses a release the project or the host has not set up', async () => {
    await expect(packageBrowser(await workspaceWith(), { release: true })).rejects.toMatchObject({
      code: 'release-not-configured',
      exitCode: ExitCode.CONFIG_ERROR,
    });
    await expect(
      packageBrowser(await workspaceWith({ release: { overlay: 'configs/absent.mozconfig' } }), {
        release: true,
      })
    ).rejects.toMatchObject({ code: 'release-overlay-missing' });
    const secret = await workspaceWith({
      release: {
        overlay: 'configs/release.mozconfig',
        secrets: { variable: 'RELEASE_KEYS', files: ['api.key'] },
      },
    });
    await expect(packageBrowser(secret, { release: true })).rejects.toMatchObject({
      code: 'release-secrets-missing',
    });
    const secrets = join(dir(), 'secrets');
    await mkdir(secret.project.host.root, { recursive: true });
    await writeFile(
      join(secret.project.host.root, 'host.json'),
      JSON.stringify({ releaseSecrets: secrets })
    );
    await expect(packageBrowser(secret, { release: true })).rejects.toThrow(/api\.key is not in/);
    expect(await readMachLog(secret.engineDir)).toEqual([]);
  });

  it('builds a release from clean in its own object directory and collects the outputs', async () => {
    const workspace = await workspaceWith({
      jobs: 3,
      release: {
        overlay: 'configs/release.mozconfig',
        secrets: { variable: 'RELEASE_KEYS', files: ['api.key'] },
        outputs: ['dist/*.package', 'config.status'],
      },
    });
    const secrets = join(dir(), 'secrets');
    await writeTree(secrets, { 'api.key': 'secret-value\n' });
    await writeTree(workspace.project.host.root, {
      'host.json': JSON.stringify({ releaseSecrets: secrets }),
    });
    await writeTree(workspace.releaseObjDir, { 'dist/stale.package': 'left over\n' });
    const outputDir = join(dir(), 'out');

    const result = await packageBrowser(workspace, { release: true, outputDir });

    expect(result).toEqual({
      objDir: workspace.releaseObjDir,
      outputDir,
      outputs: [join(outputDir, 'dist/testbrowser.package'), join(outputDir, 'config.status')],
    });
    const mozconfig = join(workspace.stateDir, 'release', 'mozconfig');
    const composed = await readFile(mozconfig, 'utf8');
    expect(composed).toContain('--enable-application=browser');
    expect(
      composed.endsWith(`${OVERLAY}\nmk_add_options MOZ_OBJDIR="${workspace.releaseObjDir}"\n`)
    ).toBe(true);
    const calls = await readMachLog(workspace.engineDir);
    expect(calls.map((call) => call.args)).toEqual([['build', '-j3'], ['package']]);
    expect(calls[0]?.env).toMatchObject({ MOZCONFIG: mozconfig, RELEASE_KEYS: secrets });
    expect(calls[0]?.env['MOZ_BUILD_DATE']).toMatch(/^\d{14}$/);
    expect(calls[1]?.env['MOZ_BUILD_DATE']).toBe(calls[0]?.env['MOZ_BUILD_DATE']);
    // The development object directory is untouched.
    await expect(readFile(join(workspace.objDir, 'mozinfo.json'))).rejects.toThrow(/ENOENT/);

    const record = await readFile(join(outputDir, 'release.json'), 'utf8');
    expect(record).not.toContain('secret-value');
    expect(JSON.parse(record)).toEqual({
      pin: { product: 'firefox-esr', version: '140.9.0esr' },
      overlay: { path: 'configs/release.mozconfig', sha256: hash(OVERLAY) },
      buildDate: calls[0]?.env['MOZ_BUILD_DATE'],
      secrets: ['api.key'],
      outputs: ['dist/testbrowser.package', 'config.status'],
    });
  });

  it('fails a release whose declared output the build did not produce', async () => {
    const workspace = await workspaceWith({
      release: { overlay: 'configs/release.mozconfig', outputs: ['dist/*.dmg'] },
    });
    await expect(
      packageBrowser(workspace, { release: true, outputDir: join(dir(), 'out') })
    ).rejects.toMatchObject({ code: 'release-output-missing', exitCode: ExitCode.BUILD_ERROR });
  });
});
