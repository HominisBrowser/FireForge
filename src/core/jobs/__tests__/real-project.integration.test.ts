// SPDX-License-Identifier: EUPL-1.2
/** What a real project asks of a host, as real processes against real-shaped configure output and a fake mach. */
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { ExitCode } from '../../../errors/codes.js';
import { writeAt } from '../../authored/__tests__/fixtures.js';
import { ONNX_RUNTIME_DIR_VARIABLE } from '../../mach-mozconfig.js';
import { probeDisplay } from '../display-probe.js';
import { type NativeProbe, nativeSiteParent, validateNativeProbe } from '../native-state.js';
import { checkConfiguredObjdir, readHostToolchain, toolchainRoots } from '../native-tools.js';
import { qualityToolIdentity } from '../quality-tools.js';
import type { JobRecord } from '../schema.js';
import type { SlotRecord } from '../slot-types.js';
import { readJournal, readJson, slotDirectory } from '../store.js';
import {
  type CliResult,
  type HostFixture,
  hostFixture,
  lintClean,
  removeHostFixture,
} from './host-fixture.js';

// Whole hosts, side by side.
vi.setConfig({ testTimeout: 300_000 });

const fixtures: HostFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

type Options = NonNullable<Parameters<typeof hostFixture>[0]>;

const commit = (f: HostFixture, message: string): void => {
  execFileSync('git', ['-C', f.project, 'add', '-A']);
  execFileSync('git', [
    '-C',
    f.project,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@e',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    message,
  ]);
};

async function host(options: Options = {}, extra: string[] = []): Promise<HostFixture> {
  const f = await hostFixture(options);
  fixtures.push(f);
  return init(f, extra);
}

async function init(f: HostFixture, extra: string[] = []): Promise<HostFixture> {
  const result = await f.cli(f.project, [
    'host',
    'init',
    '--slots',
    '1',
    '--from-engine',
    f.donor,
    ...extra,
  ]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return f;
}

const slotRoot = (f: HostFixture): string => join(slotDirectory(f.namespace, 'a'), 'root');
const readRecord = (f: HostFixture): Promise<SlotRecord> =>
  readJson<SlotRecord>(join(slotDirectory(f.namespace, 'a'), 'slot.json'));
const newest = async (f: HostFixture): Promise<JobRecord> => {
  const jobs = [...(await readJournal(f.namespace)).values()];
  const job = jobs.sort((x, y) => x.submittedAt.localeCompare(y.submittedAt)).at(-1);
  if (job === undefined) throw new Error('no job');
  return job;
};
const expectExit = (result: CliResult, code: number): void => {
  expect(result.code, result.stdout + result.stderr).toBe(code);
};

const lockfile = (version: string): string =>
  `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/tool': { version, integrity: `sha512-${version}` } } })}\n`;
const hiddenLock = (version: string): string =>
  `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { 'node_modules/tool': { version, integrity: `sha512-${version}` } } })}\n`;

async function installTool(root: string, version: string): Promise<void> {
  await writeAt(root, 'node_modules/.package-lock.json', hiddenLock(version));
  await writeAt(root, 'node_modules/tool/package.json', JSON.stringify({ name: 'tool', version }));
  await writeAt(root, 'node_modules/tool/index.js', `export const version = '${version}';\n`);
}

describe.concurrent('a host set up from a real engine', () => {
  it('gives configure the frozen SDK and ONNX Runtime without a host path in the generated mozconfig', async () => {
    const f = await host();
    const manifest = await readHostToolchain(f.namespace);
    const generation = join(f.toolchains, manifest.digest);
    expect(manifest.native.environment?.['MACOS_SDK_DIR']).toBe(join(generation, 'MacOSX26.5.sdk'));
    expect(manifest.native.environment?.[ONNX_RUNTIME_DIR_VARIABLE]).toBe(
      join(generation, 'onnxruntime-aarch64-apple-darwin')
    );
    // Neither name configure ignores is exported.
    for (const name of ['ONNX_RUNTIME', 'LIBCLANG_PATH', 'CLANG_PATH'])
      expect(manifest.native.environment?.[name]).toBeUndefined();
    const objdir = join(slotRoot(f), 'engine', 'obj-fake');
    const subst = async (key: string): Promise<unknown> =>
      JSON.parse(await readFile(join(objdir, 'config.statusd', 'substs', key), 'utf8'));
    expect(await subst('CC')).toContain(`-isysroot ${join(generation, 'MacOSX26.5.sdk')}`);
    expect(await subst('ONNX_RUNTIME')).toBe(
      join(generation, 'onnxruntime-aarch64-apple-darwin', 'libonnxruntime.dylib')
    );
    const generated = await readFile(join(slotRoot(f), 'engine', 'mozconfig'), 'utf8');
    expect(generated).toContain(`--with-onnx-runtime=$${ONNX_RUNTIME_DIR_VARIABLE}`);
    expect(generated).not.toContain(f.toolchains);
    expect(generated).not.toContain(f.home);
    await checkConfiguredObjdir(objdir, manifest);
  });

  it('refuses a configure that lost what the deriving engine selected, and one that moved it', async () => {
    const f = await host();
    const manifest = await readHostToolchain(f.namespace);
    const objdir = join(slotRoot(f), 'engine', 'obj-fake');
    const path = join(objdir, 'config.statusd', 'substs', 'ONNX_RUNTIME');
    const original = await readFile(path, 'utf8');
    await rm(path);
    await expect(checkConfiguredObjdir(objdir, manifest)).rejects.toThrow(
      /did not select ONNX_RUNTIME/
    );
    await writeFile(path, '""');
    await expect(checkConfiguredObjdir(objdir, manifest)).rejects.toThrow(
      /did not select ONNX_RUNTIME/
    );
    await writeFile(
      path,
      JSON.stringify(
        join(f.home, '.mozbuild/onnxruntime-aarch64-apple-darwin/libonnxruntime.dylib')
      )
    );
    await expect(checkConfiguredObjdir(objdir, manifest)).rejects.toThrow(
      /ONNX_RUNTIME is not in this host's toolchain/
    );
    await writeFile(path, original);
    await checkConfiguredObjdir(objdir, manifest);
  });
});

describe.concurrent('a qualified Mach site', () => {
  it('may name its sibling sites, as real ones name mach, and nothing foreign', async () => {
    const f = await host();
    const root = slotRoot(f);
    const parent = await nativeSiteParent(root);
    const manifest = await readHostToolchain(f.namespace);
    const external = await Promise.all(toolchainRoots(manifest).map((path) => realpath(path)));
    const sites = await Promise.all(
      ['mach', 'common', 'build'].map((name) => realpath(join(parent, name)))
    );
    const common = join(parent, 'common');
    const packages = join(parent, 'mach', 'lib', 'python3.12', 'site-packages');
    const probe: NativeProbe = {
      executable: join(common, 'bin', 'python'),
      prefix: common,
      paths: [packages],
    };
    await validateNativeProbe(probe, common, root, [...external, ...sites]);
    await expect(validateNativeProbe(probe, common, root, external)).rejects.toThrow(
      /Uncovered managed Python runtime path/
    );
    await expect(
      validateNativeProbe({ ...probe, paths: [packages, f.home] }, common, root, [
        ...external,
        ...sites,
      ])
    ).rejects.toThrow(/Uncovered managed Python runtime path/);
  });
});

describe.concurrent('a dependency tree against its lockfile', () => {
  it('refuses a job whose lockfile moved, names the command, and runs after it', async () => {
    const f = await hostFixture({ projectFiles: { 'package-lock.json': lockfile('1.0.0') } });
    fixtures.push(f);
    await installTool(f.project, '1.0.0');
    commit(f, 'lock');
    await init(f);
    expect(await readFile(join(slotRoot(f), 'node_modules/tool/index.js'), 'utf8')).toContain(
      '1.0.0'
    );
    expectExit(await f.cli(f.project, ['job', 'run', '--check']), 0);
    const before = (await newest(f)).qualityToolsDigest;

    await writeFile(join(f.project, 'package-lock.json'), lockfile('1.1.0'));
    commit(f, 'bump');
    const refused = await f.cli(f.project, ['job', 'run', '--check']);
    expectExit(refused, ExitCode.JOB_FAILED);
    const job = await newest(f);
    expect(job.reason).toMatch(/node_modules was installed for another package-lock.json/);
    expect(job.reason).toMatch(/fireforge slot refresh-deps a/);
    // A refusal, not an integrity failure: the slot stays usable.
    expect((await readRecord(f)).quarantined).toBeNull();

    // A checkout that pulled the lockfile but never installed it must not pass as refreshed.
    const stale = await f.cli(f.project, ['slot', 'refresh-deps', 'a']);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr + stale.stdout).toMatch(/node_modules\/tool 1\.0\.0/);

    await installTool(f.project, '1.1.0');
    expectExit(await f.cli(f.project, ['slot', 'refresh-deps', 'a']), 0);
    expect(await readFile(join(slotRoot(f), 'node_modules/tool/index.js'), 'utf8')).toContain(
      '1.1.0'
    );
    expectExit(await f.cli(f.project, ['job', 'run', '--check']), 0);
    expect((await newest(f)).qualityToolsDigest).not.toBe(before);
  });

  it('holds declared trees through both audits, refuses an undeclared one, and binds them into the quality digest', async () => {
    const kitLock = JSON.stringify({
      packages: { '': {}, 'node_modules/kit': { version: '1.0.0' } },
    });
    const engineLock = JSON.stringify({
      packages: {
        '': {},
        'node_modules/@typescript/lib-dom': { version: '1.0.0' },
        'node_modules/eslint-plugin-mozilla': {
          resolved: 'tools/lint/eslint/eslint-plugin-mozilla',
          link: true,
        },
        'node_modules/tmp': { version: '1.0.0' },
      },
    });
    const f = await hostFixture({
      config: {
        slots: {
          dependencyCaches: [
            { source: 'engine/node_modules', target: 'engine/node_modules' },
            { source: 'tools/vendor/kit/node_modules', target: 'tools/vendor/kit/node_modules' },
            {
              source: 'components/kit/dist',
              target: 'components/kit/dist',
              lockfile: 'tools/vendor/kit/package-lock.json',
            },
          ],
        },
      },
      pristineFiles: {
        'package-lock.json': engineLock,
        '.gitignore': 'node_modules/\n',
        'tools/lint/eslint/eslint-plugin-mozilla/index.js': 'module.exports = {};\n',
      },
      projectFiles: { 'tools/vendor/kit/package-lock.json': kitLock },
    });
    fixtures.push(f);
    await writeAt(f.project, '.gitignore', 'engine/\n.fireforge/\nnode_modules/\ndist/\n');
    commit(f, 'kit');
    // The shape Firefox's own tree has: a package with no name, a package called tmp, and a linked workspace.
    await writeAt(f.donor, 'node_modules/.package-lock.json', engineLock);
    await writeAt(f.donor, 'node_modules/@typescript/lib-dom/package.json', '{"version":"1.0.0"}');
    await writeAt(f.donor, 'node_modules/tmp/index.js', 'module.exports = {};\n');
    await symlink(
      '../tools/lint/eslint/eslint-plugin-mozilla',
      join(f.donor, 'node_modules/eslint-plugin-mozilla')
    );
    await writeAt(f.project, 'tools/vendor/kit/node_modules/.package-lock.json', kitLock);
    await writeAt(f.project, 'tools/vendor/kit/node_modules/kit/index.js', 'export {};\n');
    await writeAt(f.project, 'components/kit/dist/kit.js', 'export {};\n');
    await init(f);
    const root = slotRoot(f);
    expect(
      (await lstat(join(root, 'engine/node_modules/eslint-plugin-mozilla'))).isSymbolicLink()
    ).toBe(true);
    expectExit(await f.cli(f.project, ['slot', 'audit', 'a']), 0);
    expectExit(await f.cli(f.project, ['job', 'run', '--check']), 0);

    const digest = await qualityToolIdentity(root);
    await writeFile(join(root, 'components/kit/dist/kit.js'), 'export const tampered = 1;\n');
    expect(await qualityToolIdentity(root)).not.toBe(digest);
    await writeAt(
      f.project,
      'src/browser/new.js',
      lintClean('/** A value. */\nexport const value = 2;\n')
    );
    commit(f, 'next');
    const changed = await f.cli(f.project, ['job', 'run', '--check']);
    expectExit(changed, ExitCode.JOB_FAILED);
    expect((await newest(f)).reason).toMatch(
      /components\/kit\/dist changed since it was installed/
    );
    await writeFile(join(root, 'components/kit/dist/kit.js'), 'export {};\n');
    expectExit(await f.cli(f.project, ['slot', 'refresh-deps', 'a', '--from-engine', f.donor]), 0);

    await writeAt(root, 'tools/vendor/other/node_modules/x/index.js', 'stray\n');
    const rootDrift = await f.cli(f.project, ['slot', 'audit', 'a']);
    expect(rootDrift.code).not.toBe(0);
    expect(rootDrift.stderr + rootDrift.stdout).toMatch(/Undeclared captured-root drift/);
    await rm(join(root, 'tools/vendor/other'), { recursive: true });
    await writeAt(root, 'engine/undeclared/index.js', 'stray\n');
    const engineDrift = await f.cli(f.project, ['slot', 'audit', 'a']);
    expect(engineDrift.code).not.toBe(0);
    expect(engineDrift.stderr + engineDrift.stdout).toMatch(/Undeclared engine drift/);
  });

  it.each([
    ['an absolute link', 'absolute alias'],
    ['a link leaving the tree', 'escapes its root'],
    ['a profile', 'Private/runtime cache entry'],
  ])('refuses a tree holding %s, naming the entry', async (kind, message) => {
    const f = await hostFixture();
    fixtures.push(f);
    await writeAt(f.project, 'node_modules/tool/index.js', 'export {};\n');
    if (kind === 'a profile') await writeAt(f.project, 'node_modules/tool/cookies.sqlite', 'x');
    else
      await symlink(
        kind === 'an absolute link' ? f.home : '../../outside',
        join(f.project, 'node_modules/tool/link')
      );
    const result = await f.cli(f.project, [
      'host',
      'init',
      '--slots',
      '1',
      '--from-engine',
      f.donor,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(message);
  });

  it('refuses a cache overlapping what the source captures', async () => {
    const f = await hostFixture({
      config: { slots: { dependencyCaches: [{ source: 'kit/dist', target: 'kit/dist' }] } },
      projectFiles: { 'kit/dist/tracked.js': 'export {};\n' },
    });
    fixtures.push(f);
    const result = await f.cli(f.project, [
      'host',
      'init',
      '--slots',
      '1',
      '--from-engine',
      f.donor,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('overlaps files this source captures');
  });

  it('keeps declared trees through a restore', async () => {
    const lock = JSON.stringify({ packages: { '': {}, 'node_modules/kit': { version: '1.0.0' } } });
    const f = await hostFixture({
      config: {
        slots: {
          dependencyCaches: [
            { source: 'engine/node_modules', target: 'engine/node_modules' },
            { source: 'tools/vendor/kit/node_modules', target: 'tools/vendor/kit/node_modules' },
          ],
        },
      },
      pristineFiles: { 'package-lock.json': lock, '.gitignore': 'node_modules/\n' },
      projectFiles: { 'tools/vendor/kit/package-lock.json': lock },
    });
    fixtures.push(f);
    commit(f, 'kit');
    await writeAt(f.donor, 'node_modules/.package-lock.json', lock);
    await writeAt(f.donor, 'node_modules/kit/index.js', 'export {};\n');
    await writeAt(f.project, 'tools/vendor/kit/node_modules/.package-lock.json', lock);
    await writeAt(f.project, 'tools/vendor/kit/node_modules/kit/index.js', 'export {};\n');
    await init(f);
    await writeAt(slotRoot(f), 'tools/vendor/stray.txt', 'stray\n');
    expectExit(await f.cli(f.project, ['slot', 'restore', 'a']), 0);
    const root = slotRoot(f);
    expect(await readFile(join(root, 'tools/vendor/kit/node_modules/kit/index.js'), 'utf8')).toBe(
      'export {};\n'
    );
    expect(await readFile(join(root, 'engine/node_modules/kit/index.js'), 'utf8')).toBe(
      'export {};\n'
    );
    await expect(lstat(join(root, 'tools/vendor/stray.txt'))).rejects.toThrow();
    expectExit(await f.cli(f.project, ['slot', 'audit', 'a']), 0);
  });
});

describe.concurrent('project checks in a slot', () => {
  it('name the captured files for a check with no repository to ask', async () => {
    const f = await host({
      check: {
        skip: ['typecheck', 'furnace-validate', 'token-coverage'],
        extraSteps: [
          {
            name: 'tracked',
            command: 'grep -qx fireforge.json "$FIREFORGE_CAPTURED_FILES"',
            footprint: { static: true },
          },
        ],
      },
    });
    expectExit(await f.cli(f.project, ['job', 'run', '--check']), 0);
    const list = await readFile(join(slotRoot(f), '.fireforge', 'captured-files'), 'utf8');
    expect(list.split('\n')).toContain('configs/common.mozconfig');
    expect(list).not.toContain('engine/');
  });
});

describe.concurrent('a release package', () => {
  const release = {
    build: {
      release: {
        overlay: 'configs/release.mozconfig',
        secrets: { variable: 'FIXTURE_SECRETS_DIR', files: ['api.key'] },
        outputs: ['dist/*.dmg'],
      },
    },
  };
  const overlay =
    'ac_add_options --enable-updater\nac_add_options --with-api-keyfile=$FIXTURE_SECRETS_DIR/api.key\n';

  it('refuses at submit until its declared inputs exist', async () => {
    const f = await host({
      config: release,
      projectFiles: { 'configs/release.mozconfig': overlay },
    });
    const missing = await f.cli(f.project, ['job', 'run', '--release']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr + missing.stdout).toMatch(/--release-secrets/);
    const secrets = join(f.directory, 'secrets');
    await mkdir(secrets);
    expectExit(await f.cli(f.project, ['host', 'init', '--release-secrets', secrets]), 0);
    const absent = await f.cli(f.project, ['job', 'run', '--release']);
    expect(absent.code).not.toBe(0);
    expect(absent.stderr + absent.stdout).toMatch(/Release secret api.key is missing/);
    const undeclared = await host();
    const noRecipe = await undeclared.cli(undeclared.project, ['job', 'run', '--release']);
    expect(noRecipe.stderr + noRecipe.stdout).toMatch(/needs build.release/);
  });

  it('builds with the overlay last in its own object directory, leaving the development build and anchor alone', async () => {
    const f = await host({
      config: release,
      projectFiles: { 'configs/release.mozconfig': overlay },
    });
    const secrets = join(f.directory, 'secrets');
    await writeAt(secrets, 'api.key', 'not-in-any-record\n');
    expectExit(await f.cli(f.project, ['host', 'init', '--release-secrets', secrets]), 0);
    expectExit(await f.cli(f.project, ['job', 'run', '--build', 'full']), 0);
    const built = await readRecord(f);
    expect(built.fullBuildAnchor).toBeDefined();
    const devMarker = join(slotRoot(f), 'engine/obj-fake/dist/bin/fixture');
    const devBytes = await readFile(devMarker, 'utf8');
    // What an earlier release left, which this one must not build on.
    const stale = join(slotRoot(f), '.fireforge/release/obj/stale.o');
    await writeAt(dirname(stale), 'stale.o', 'earlier release\n');

    const result = await f.cli(f.project, ['job', 'run', '--release']);
    expectExit(result, 0);
    const job = await newest(f);
    expect(job.state).toBe('passed');
    // What it built is on the disk, and the slot's accounting says so beside its development build.
    const accounted = await readRecord(f);
    expect(accounted.storage?.releaseBytes).toBeGreaterThan(0);
    expect(accounted.storage?.consumedBytes).toBe(built.storage?.consumedBytes);
    expect(job.outputs?.[0]?.path).toBeDefined();
    const identity = await readJson<Record<string, unknown>>(
      join(job.outputs?.[0]?.path ?? '', 'release.json')
    );
    expect(identity).toMatchObject({
      recipe: 'release',
      sourceId: job.request.sourceId,
      secrets: ['api.key'],
    });
    expect(identity['toolchain']).toBe((await readHostToolchain(f.namespace)).digest);
    expect(identity['overlay']).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain('not-in-any-record');
    const objdir = String(identity['objdir']);
    expect(objdir).toBe(join(await realpath(slotRoot(f)), '.fireforge/release/obj'));
    await lstat(join(objdir, 'dist/fixture-153.6.0.en-US.mac.dmg'));
    await expect(lstat(stale)).rejects.toThrow(/ENOENT/);
    // The declared output leaves the slot, beside the identity.
    expect(
      await readFile(join(job.outputs?.[0]?.path ?? '', 'dist/fixture-153.6.0.en-US.mac.dmg'))
    ).toEqual(await readFile(join(objdir, 'dist/fixture-153.6.0.en-US.mac.dmg')));
    // What configure selected for a release is held to the toolchain too.
    await checkConfiguredObjdir(objdir, await readHostToolchain(f.namespace));

    const composed = await readFile(join(slotRoot(f), '.fireforge/release/mozconfig'), 'utf8');
    const lines = composed.split('\n');
    expect(lines.indexOf('ac_add_options --enable-updater')).toBeGreaterThan(
      lines.findIndex((line) => line.includes('--disable-bootstrap'))
    );
    expect(lines.filter(Boolean).at(-1)).toBe(`mk_add_options MOZ_OBJDIR="${objdir}"`);

    const after = await readRecord(f);
    expect(after.fullBuildAnchor).toEqual(built.fullBuildAnchor);
    expect(after.trustedBuild).toEqual(built.trustedBuild);
    expect(after.requiresBuild).toBe(built.requiresBuild);
    expect(await readFile(devMarker, 'utf8')).toBe(devBytes);
    expectExit(await f.cli(f.project, ['slot', 'audit', 'a']), 0);
  });

  it('runs only on qualified sites: a slot qualified before the source declared a release requalifies by name', async () => {
    const f = await host();
    const qualified = join(slotRoot(f), '.fireforge', 'native-qualified.json');
    const before = await readJson<{ sites: Array<{ name: string }> }>(qualified);
    expect(before.sites.map((site) => site.name)).toEqual(['build', 'common', 'mach']);
    const config = await readJson<Record<string, unknown>>(join(f.project, 'fireforge.json'));
    await writeAt(f.project, 'fireforge.json', JSON.stringify({ ...config, ...release }));
    await writeAt(f.project, 'configs/release.mozconfig', overlay);
    commit(f, 'declare a release');
    const secrets = join(f.directory, 'secrets');
    await writeAt(secrets, 'api.key', 'key\n');
    expectExit(await f.cli(f.project, ['host', 'init', '--release-secrets', secrets]), 0);

    const refused = await f.cli(f.project, ['job', 'run', '--release']);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toMatch(
      /taskgraph[\s\S]*run: fireforge slot qualify-native a/
    );
    expectExit(await f.cli(f.project, ['slot', 'qualify-native', 'a']), 0);
    expectExit(await f.cli(f.project, ['job', 'run', '--release']), 0);
    const after = await readJson<{ sites: Array<{ name: string }> }>(qualified);
    expect(after.sites.map((site) => site.name)).toEqual(['build', 'common', 'mach', 'taskgraph']);

    // A source that stops declaring the release drops the site at its next qualification.
    await writeAt(f.project, 'fireforge.json', JSON.stringify(config));
    commit(f, 'no release');
    const stale = await f.cli(f.project, ['job', 'run', '--build', 'full']);
    expect(stale.stdout + stale.stderr).toMatch(
      /needs build, common, mach; run: fireforge slot qualify-native a/
    );
    expectExit(await f.cli(f.project, ['slot', 'qualify-native', 'a']), 0);
    expectExit(await f.cli(f.project, ['job', 'run', '--build', 'full']), 0);
    await expect(lstat(join(await nativeSiteParent(slotRoot(f)), 'taskgraph'))).rejects.toThrow(
      /ENOENT/
    );
  });
});

describe.concurrent('declared browser shapes', () => {
  const testFile = (record: string): string =>
    lintClean(`/** A test. */\n// fake-mach-record ${record}\nexport const test = 1;\n`);

  it('runs a throttled test with the fixed taskpolicy arguments', async () => {
    const f = await host();
    const record = join(f.directory, 'throttled.json');
    await writeAt(f.project, 'src/browser/test/browser_a.js', testFile(record));
    commit(f, 'test');
    const result = await f.cli(f.project, [
      'job',
      'run',
      '--throttle',
      'utility',
      '--test',
      'browser/test/browser_a.js',
      '--build',
      'full',
    ]);
    expectExit(result, 0);
    const seen = await readJson<{ args: string[] }>(record);
    expect(seen.args).toContain('--debugger=taskpolicy');
    expect(seen.args).toContain('--debugger-args=-c utility');
    expect((await newest(f)).request.steps.at(-1)?.throttle).toBe('utility');
  });

  it('reads red when a held front never saw the browser, naming why', async () => {
    if ((await probeDisplay()).state === 'unavailable') return;
    const f = await host();
    await writeAt(
      f.project,
      'src/browser/test/browser_a.js',
      testFile(join(f.directory, 'x.json'))
    );
    commit(f, 'test');
    const result = await f.cli(f.project, [
      'job',
      'run',
      '--headed',
      '--hold-front',
      '--test',
      'browser/test/browser_a.js',
      '--build',
      'full',
    ]);
    expectExit(result, ExitCode.JOB_FAILED);
    const logs = await readdir(join(f.namespace, 'logs'));
    const log = await Promise.all(
      logs.map((name) => readFile(join(f.namespace, 'logs', name), 'utf8'))
    );
    expect(log.join('\n')).toMatch(
      /No browser of this phase was ever seen|supported on darwin only/
    );
  });

  it('refuses holdFront on a step with no window', async () => {
    const f = await host();
    const result = await f.cli(f.project, ['job', 'run', '--hold-front', '--check']);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--hold-front/);
  });
});
