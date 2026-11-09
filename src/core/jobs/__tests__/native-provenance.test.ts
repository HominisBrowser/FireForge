// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import {
  assertNativeBootstrapDisabled,
  assertPythonResolution,
  checkConfiguredTools,
  nativeToolEnvironment,
  needsNativeTools,
  parseConfiguredTool,
  readHostToolchain,
} from '../native-tools.js';
import { toolchainManifestPath } from '../native-tools.js';
import { writeDurable } from '../store.js';
import { toolTreeDigest, treeStatSignature } from '../tool-files.js';
import {
  type NativeFixture,
  nativeFixture,
  permissions,
  removeNativeFixture,
} from './native-fixture.js';

const fixtures: NativeFixture[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map(removeNativeFixture));
});

async function fixture(): Promise<NativeFixture> {
  const value = await nativeFixture();
  fixtures.push(value);
  return value;
}

async function configure(engine: string, values: Record<string, unknown>): Promise<void> {
  const substs = join(engine, 'obj-x', 'config.statusd', 'substs');
  await mkdir(substs, { recursive: true });
  await writeFile(join(engine, 'obj-x', 'config.status'), 'configured');
  for (const [key, value] of Object.entries(values))
    await writeFile(join(substs, key), JSON.stringify(value));
}

describe('the host toolchain manifest', () => {
  it('names what to do when a host has none, and refuses another platform’s', async () => {
    const value = await fixture();
    await expect(readHostToolchain(join(value.directory, 'absent'))).rejects.toThrow(
      /fireforge host init --from-engine/
    );
    await writeDurable(toolchainManifestPath(value.namespace), {
      ...value.manifest,
      platform: 'plan9',
    });
    await expect(readHostToolchain(value.namespace)).rejects.toThrow(/Unsupported toolchain/);
    await writeDurable(toolchainManifestPath(value.namespace), {
      ...value.manifest,
      schemaVersion: 1,
    });
    await expect(readHostToolchain(value.namespace)).rejects.toThrow(/Unsupported toolchain/);
  });

  it('gives a job tools from the manifest, and private state for everything writable', async () => {
    const value = await fixture();
    expect(nativeToolEnvironment(value.manifest, value.root)).toMatchObject({
      CC: value.manifest.native.executables['CC'],
      MOZBUILD_STATE_PATH: join(value.root, '.fireforge/native-state'),
      PYTHONNOUSERSITE: '1',
      MACH_NO_UV: '1',
    });
    const environment = nativeToolEnvironment(
      {
        ...value.manifest,
        native: {
          ...value.manifest.native,
          executables: { ...value.manifest.native.executables, EVIL: '/x/evil' },
          environment: { WASI_SYSROOT: '/frozen/sysroot' },
        },
      },
      value.root
    );
    expect(environment['EVIL']).toBeUndefined();
    expect(environment['WASI_SYSROOT']).toBe('/frozen/sysroot');
  });

  it('leaves an assembler that is the C compiler for configure to derive with its flags', () => {
    return fixture().then((value) => {
      const cc = value.manifest.native.executables['CC'] ?? '';
      const derived = { ...value.manifest.native.executables, AS: cc };
      const own = { ...value.manifest.native.executables, AS: '/frozen/bin/as' };
      const env = (executables: Record<string, string>): Record<string, string> =>
        nativeToolEnvironment(
          { ...value.manifest, native: { ...value.manifest.native, executables } },
          value.root
        );
      expect(env(derived)['AS']).toBeUndefined();
      expect(env(derived)['CC']).toBe(cc);
      expect(env(own)['AS']).toBe('/frozen/bin/as');
    });
  });

  it('native adapters need it; a check needs it only for a step that is not declared static', async () => {
    const value = await fixture();
    for (const command of ['build', 'test', 'run', 'package'] as const)
      expect(needsNativeTools({ command, args: [] })).toBe(true);
    for (const command of ['lint', 'typecheck', 'verify', 'status', 'check'] as const)
      expect(needsNativeTools({ command, args: [] }, value.snapshot)).toBe(false);
  });
});

describe('captured bootstrap policy', () => {
  it('refuses a config that lets configure fetch its own tools, by file and line', async () => {
    const value = await fixture();
    await assertNativeBootstrapDisabled(value.snapshot);
    await writeAt(
      value.root,
      'configs/common.mozconfig',
      '# ok\nac_add_options --enable-bootstrap\n'
    );
    const enabled = await captureAuthoredSnapshot({
      projectRoot: value.root,
      pristineRepository: value.pristine,
    });
    await expect(assertNativeBootstrapDisabled(enabled)).rejects.toThrow(
      /configs\/common\.mozconfig:2: replace/
    );
    await writeAt(value.root, 'configs/common.mozconfig', '# nothing about bootstrap\n');
    const silent = await captureAuthoredSnapshot({
      projectRoot: value.root,
      pristineRepository: value.pristine,
    });
    await expect(assertNativeBootstrapDisabled(silent)).rejects.toThrow(/add the line/);
  });
});

describe('configured tools', () => {
  it('parses each export shape a real objdir holds', () => {
    expect(parseConfiguredTool('/t/clang -isysroot /t/sdk -mmacosx-version-min=11.0')).toEqual({
      command: '/t/clang',
      paths: ['/t/clang', '/t/sdk'],
    });
    expect(parseConfiguredTool(['/t/clang', '--sysroot=/t/wasi'])).toEqual({
      command: '/t/clang',
      paths: ['/t/clang', '/t/wasi'],
    });
    expect(parseConfiguredTool(undefined)).toEqual({ paths: [] });
  });

  it('requires the build commands and refuses what the manifest does not cover', async () => {
    const value = await fixture();
    const tools = value.manifest.native.executables;
    const required = {
      CC: tools['CC'],
      CXX: tools['CXX'],
      RUSTC: tools['RUSTC'],
      CARGO: tools['CARGO'],
    };
    await configure(value.engine, required);
    await checkConfiguredTools(value.engine, value.manifest);

    await rm(join(value.engine, 'obj-x/config.statusd/substs/CARGO'));
    await expect(checkConfiguredTools(value.engine, value.manifest)).rejects.toThrow(
      /missing config\.statusd\/substs\/CARGO/
    );

    const elsewhere = await mkdtemp(join(tmpdir(), 'ff-uncovered-'));
    try {
      const rogue = join(elsewhere, 'cc');
      await writeFile(rogue, '#!/bin/sh\n');
      await configure(value.engine, { ...required, CC: `${rogue} -v` });
      await expect(checkConfiguredTools(value.engine, value.manifest)).rejects.toThrow(
        /not in this host's toolchain/
      );
      await configure(value.engine, { ...required, CC: 'clang' });
      await expect(checkConfiguredTools(value.engine, value.manifest)).rejects.toThrow(
        /absolute compiler command/
      );
      await configure(value.engine, { ...required, CC: tools['CXX'] });
      await expect(checkConfiguredTools(value.engine, value.manifest)).rejects.toThrow(
        /differs from this host's toolchain/
      );
      await configure(value.engine, {
        ...required,
        CC: `${tools['CC']} -isysroot ${elsewhere}`,
      });
      await expect(checkConfiguredTools(value.engine, value.manifest)).rejects.toThrow(/argument/);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('ignores an object directory configure has not finished', async () => {
    const value = await fixture();
    await mkdir(join(value.engine, 'obj-partial/config.statusd/substs'), { recursive: true });
    await checkConfiguredTools(value.engine, value.manifest);
  });
});

describe('Python resolution', () => {
  /** The host's real interpreter, as a manifest would record one used in place. */
  function hostPython(): { executable: string; paths: string[]; prefix: string } {
    const output = execFileSync(
      'python3',
      ['-I', '-c', 'import json,sys;print(json.dumps([sys.executable,sys.path,sys.base_prefix]))'],
      { encoding: 'utf8' }
    );
    const [executable, paths, prefix] = JSON.parse(output) as [string, string[], string];
    return { executable, paths, prefix };
  }

  it('accepts an interpreter that resolves inside its roots, and refuses one that does not', async () => {
    const value = await fixture();
    const python = hostPython();
    const roots = await Promise.all(
      [python.prefix, ...python.paths].map((path) => realpath(path).catch(() => ''))
    );
    const covered = {
      ...value.manifest,
      python: { executable: python.executable, roots: [...new Set(roots.filter(Boolean))] },
    };
    await assertPythonResolution(covered);
    await expect(
      assertPythonResolution({
        ...value.manifest,
        python: { executable: python.executable, roots: [value.tools] },
      })
    ).rejects.toThrow(/Uncovered Python/);
    vi.stubEnv('PYTHONPATH', value.directory);
    await expect(assertPythonResolution(covered)).rejects.toThrow(/PYTHONPATH/);
  });
});

describe('tool tree identity', () => {
  it('binds bytes and links, ignores write bits, and refuses a link out of its roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ff-tool-tree-'));
    try {
      const tools = join(root, 'tools');
      await writeAt(tools, 'bin/tool', 'bytes A');
      await symlink('tool', join(tools, 'bin/alias'));
      const before = await toolTreeDigest(tools);
      const signature = await treeStatSignature([tools]);
      await permissions(tools, true);
      expect(await toolTreeDigest(tools)).toBe(before);
      expect(await treeStatSignature([tools])).not.toBe(signature);
      await permissions(tools, false);
      await writeAt(tools, 'bin/tool', 'bytes B');
      expect(await toolTreeDigest(tools)).not.toBe(before);

      await writeAt(root, 'outside/secret', 'secret');
      await symlink(join(root, 'outside/secret'), join(tools, 'bin/escape'));
      await expect(toolTreeDigest(tools)).rejects.toThrow(/escapes declared root/);
      await expect(toolTreeDigest(tools, { aliases: [join(root, 'outside')] })).resolves.toMatch(
        /^[a-f0-9]{64}$/
      );
      await expect(toolTreeDigest(tools, { externalLinks: true })).resolves.toMatch(
        /^[a-f0-9]{64}$/
      );
      expect(await toolTreeDigest(join(root, 'absent'), { optional: true })).toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
