// SPDX-License-Identifier: EUPL-1.2
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';

import { getPlatform } from '../../../utils/platform.js';
import { sourceFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/capture.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import { toolchainManifestPath } from '../native-tools.js';
import type { NativeToolchainManifest } from '../slot-types.js';
import { writeDurable } from '../store.js';
import { toolTreeDigest, treeStatSignature } from '../tool-files.js';

export interface NativeFixture extends Awaited<ReturnType<typeof sourceFixture>> {
  directory: string;
  namespace: string;
  tools: string;
  engine: string;
  manifest: NativeToolchainManifest;
  snapshot: AuthoredSnapshot;
}

export async function permissions(path: string, frozen: boolean): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (!frozen) await chmod(path, 0o700);
    for (const entry of await readdir(path)) await permissions(join(path, entry), frozen);
    if (frozen) await chmod(path, 0o555);
  } else await chmod(path, frozen ? 0o444 : 0o600);
}

export async function nativeFixture(): Promise<NativeFixture> {
  const base = await sourceFixture();
  const directory = dirname(base.root),
    tools = join(directory, 'immutable-tools'),
    engine = join(base.root, 'engine');
  await mkdir(engine);
  for (const path of [
    'python/bin/python3',
    'python/lib/os.py',
    'python/site/runtime.py',
    'native/cc',
    'native/cxx',
    'native/rustc',
    'native/cargo',
    'native/include/sdk.h',
  ]) {
    await writeAt(tools, path, `fixture tool bytes A: ${path}\n`);
  }
  const manifest: NativeToolchainManifest = {
    schemaVersion: 3,
    platform: platform(),
    arch: arch(),
    digest: 'fixture-toolchain',
    signature: '',
    rootDigests: {},
    python: {
      executable: join(tools, 'python/bin/python3'),
      roots: [tools],
      sites: ['common', 'build'],
    },
    native: {
      executables: {
        CC: join(tools, 'native/cc'),
        CXX: join(tools, 'native/cxx'),
        RUSTC: join(tools, 'native/rustc'),
        CARGO: join(tools, 'native/cargo'),
      },
      roots: [tools],
      configured: {},
    },
  };
  await writeAt(base.root, 'configs/common.mozconfig', 'ac_add_options --disable-bootstrap\n');
  await writeAt(
    base.root,
    `configs/${getPlatform()}.mozconfig`,
    'ac_add_options --enable-application=browser\n'
  );
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: base.root,
    intendedPaths: ['src', 'configs'],
    pristineRepository: base.pristine,
  });
  await permissions(tools, true);
  const namespace = join(directory, 'coordinator');
  manifest.signature = await treeStatSignature([tools]);
  manifest.rootDigests = { [tools]: await toolTreeDigest(tools) };
  await writeDurable(toolchainManifestPath(namespace), manifest);
  return { ...base, directory, namespace, tools, engine, manifest, snapshot };
}

export function pythonInformation(fixture: NativeFixture): { stdout: string; stderr: string } {
  const library = join(fixture.tools, 'python/lib'),
    site = join(fixture.tools, 'python/site');
  return {
    stdout: JSON.stringify({
      executable: fixture.manifest.python.executable,
      paths: [library, site],
      stdlib: library,
      purelib: site,
      platlib: site,
    }),
    stderr: '',
  };
}

export async function removeNativeFixture(fixture: NativeFixture): Promise<void> {
  await permissions(fixture.directory, false);
  await rm(fixture.directory, { recursive: true, force: true });
}
