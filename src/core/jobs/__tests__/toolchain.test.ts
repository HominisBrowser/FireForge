// SPDX-License-Identifier: EUPL-1.2
/** The derived toolchain, against real-shaped configure output and real files. */
import { execFileSync } from 'node:child_process';
import { chmod, lstat, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureAuthoredSnapshot } from '../../authored/index.js';
import {
  assertToolchainCurrent,
  bootstrapChanges,
  checkConfiguredTools,
  nativeBuildDigest,
  readHostToolchain,
} from '../native-tools.js';
import { deriveToolchain } from '../toolchain.js';
import { fixtureTool, type HostFixture, hostFixture, removeHostFixture } from './host-fixture.js';

// Real processes and real clones, beside whatever else the suite is running.
vi.setConfig({ testTimeout: 180_000 });

const fixtures: HostFixture[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
});

async function derived(): Promise<HostFixture> {
  const fixture = await hostFixture();
  fixtures.push(fixture);
  vi.stubEnv('FIREFORGE_TOOLCHAINS', fixture.toolchains);
  await deriveToolchain({ namespace: fixture.namespace, engine: fixture.donor });
  return fixture;
}

describe('deriving a toolchain from configure output', () => {
  it('clones the tools configure named read-only under their digest, with no host path in captured source', async () => {
    const f = await derived();
    const manifest = await readHostToolchain(f.namespace);
    const generation = join(f.toolchains, manifest.digest);
    expect(manifest.native.executables['CC']).toBe(join(generation, 'clang/bin/clang'));
    expect(manifest.native.executables['CXX']).toBe(join(generation, 'clang/bin/clang++'));
    // The rustup proxy became the binary it would have run: a frozen tool cannot consult user state.
    expect(manifest.native.executables['RUSTDOC']).toBe(join(generation, 'stable/bin/rustdoc'));
    expect(manifest.native.environment?.['WASI_SYSROOT']).toBe(
      join(generation, 'sysroot-wasm32-wasi')
    );
    expect(manifest.native.roots).toContain(join(generation, 'MacOSX26.5.sdk'));
    const tool = await lstat(join(generation, 'clang/bin/clang'));
    expect(tool.mode & 0o222).toBe(0);
    expect((await lstat(join(generation, 'clang/bin'))).mode & 0o222).toBe(0);
    await expect(writeFile(join(generation, 'clang/bin/clang'), 'x')).rejects.toThrow(/EACCES/);
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.project,
      pristineRepository: f.pristine,
    });
    expect(JSON.stringify(snapshot)).not.toContain(f.toolchains);
    expect(snapshot.inputs.map((input) => input.path)).not.toContain('toolchain.json');
  });

  it('reuses a generation whose digest exists, and a changed tool makes a new one', async () => {
    const f = await derived();
    const first = await readHostToolchain(f.namespace);
    const again = await deriveToolchain({ namespace: f.namespace, engine: f.donor });
    expect(again.reused).toBe(true);
    expect(again.manifest.digest).toBe(first.digest);
    await writeFile(fixtureTool(f, '.mozbuild/clang/bin/clang'), '#!/bin/sh\necho new\n');
    const next = await deriveToolchain({ namespace: f.namespace, engine: f.donor });
    expect(next.reused).toBe(false);
    expect(next.manifest.digest).not.toBe(first.digest);
    expect((await readdir(f.toolchains)).filter((name) => !name.endsWith('.json'))).toHaveLength(2);
  });

  it('names what is missing rather than deriving from an unconfigured engine', async () => {
    const f = await derived();
    await expect(deriveToolchain({ namespace: f.namespace, engine: f.project })).rejects.toThrow(
      /no configured object directory/
    );
  });
});

describe('checking a toolchain per job', () => {
  it('a recorded stat signature passes unread; changed bytes with a changed mtime invalidate', async () => {
    const f = await derived();
    const manifest = await readHostToolchain(f.namespace);
    await assertToolchainCurrent(manifest);
    const tool = manifest.native.executables['CC'] ?? '';
    const parent = join(tool, '..');
    await chmod(parent, 0o755);
    await chmod(tool, 0o755);
    await writeFile(tool, '#!/bin/sh\necho different compiler\n');
    await chmod(tool, 0o555);
    await chmod(parent, 0o555);
    await expect(assertToolchainCurrent(manifest)).rejects.toThrow(/bytes changed/);
  });

  it('a moved mtime over the same bytes is not a new toolchain', async () => {
    const f = await derived();
    const manifest = await readHostToolchain(f.namespace);
    const tool = manifest.native.executables['CC'] ?? '';
    await utimes(tool, new Date(), new Date(Date.now() + 5_000));
    await assertToolchainCurrent(manifest);
  });

  it('only reading the bytes catches a change that restored its mtime, which is why a final gate does', async () => {
    const f = await hostFixture();
    fixtures.push(f);
    vi.stubEnv('FIREFORGE_TOOLCHAINS', f.toolchains);
    const stamp = new Date('2020-01-01T00:00:00Z');
    await utimes(fixtureTool(f, '.rustup/toolchains/stable/bin/cargo'), stamp, stamp);
    const { manifest } = await deriveToolchain({ namespace: f.namespace, engine: f.donor });
    const tool = manifest.native.executables['CARGO'] ?? '';
    const bytes = await readFile(tool, 'utf8');
    await chmod(tool, 0o755);
    await writeFile(tool, bytes.replace('tool', 'loot'));
    await chmod(tool, 0o555);
    await utimes(tool, stamp, stamp);
    await assertToolchainCurrent(manifest);
    await expect(assertToolchainCurrent(manifest, { full: true })).rejects.toThrow(/bytes changed/);
  });
});

describe('what the anchor binds', () => {
  it('is the same whichever slot asks and however often the tools requalify', async () => {
    const f = await derived();
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.project,
      pristineRepository: f.pristine,
    });
    const manifest = await readHostToolchain(f.namespace);
    const digest = nativeBuildDigest(manifest, snapshot);
    const again = await deriveToolchain({ namespace: f.namespace, engine: f.donor });
    expect(nativeBuildDigest(again.manifest, snapshot)).toBe(digest);
    expect(digest).not.toContain(f.directory);
  });
});

describe('an incomplete manifest', () => {
  it('names the tool configure picked that nobody derived', async () => {
    const f = await derived();
    const manifest = await readHostToolchain(f.namespace);
    delete manifest.native.executables['AR'];
    const engine = join(f.directory, 'slot-engine');
    const substs = join(engine, 'obj-x', 'config.statusd', 'substs');
    execFileSync('mkdir', ['-p', substs]);
    await writeFile(join(engine, 'obj-x', 'config.status'), 'x');
    for (const key of ['CC', 'CXX', 'RUSTC', 'CARGO', 'AR'])
      await writeFile(
        join(substs, key),
        JSON.stringify(
          manifest.native.executables[key] ??
            join(f.toolchains, manifest.digest, 'clang/bin/llvm-ar')
        )
      );
    await expect(checkConfiguredTools(engine, manifest)).rejects.toThrow(
      /Configured AR .* is missing from this host's toolchain/
    );
  });
});

describe('a bootstrap mozconfig', () => {
  it('is reported as the exact edit, by file and line', () => {
    expect(
      bootstrapChanges(
        new Map([
          ['configs/common.mozconfig', '# build\nac_add_options --enable-bootstrap\n'],
          ['configs/darwin.mozconfig', ''],
        ])
      )
    ).toEqual([
      {
        path: 'configs/common.mozconfig',
        line: 2,
        change:
          'replace "ac_add_options --enable-bootstrap" with "ac_add_options --disable-bootstrap"',
      },
    ]);
    expect(bootstrapChanges(new Map([['configs/common.mozconfig', '']]))[0]?.change).toMatch(
      /add the line/
    );
    expect(
      bootstrapChanges(
        new Map([['configs/common.mozconfig', 'ac_add_options --disable-bootstrap\n']])
      )
    ).toEqual([]);
  });
});
