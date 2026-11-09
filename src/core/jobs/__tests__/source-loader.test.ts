// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Script } from 'node:vm';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { assertSourceLoaderEnvironment, sourceLoaderIdentity } from '../source-loader.js';

const bootstrap = fileURLToPath(new URL('../source-loader-bootstrap.cjs', import.meta.url));

const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv('ESBUILD_BINARY_PATH', '');
  vi.stubEnv('TSX_TSCONFIG_PATH', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function put(root: string, file: string, bytes: string): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), bytes);
}
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ff-source-loader-'));
  roots.push(root);
  await put(root, 'tsconfig.json', '{"compilerOptions":{"target":"ES2023"}}');
  await put(
    root,
    'node_modules/tsx/package.json',
    JSON.stringify({ name: 'tsx', main: 'index.mjs', dependencies: { esbuild: '1' } })
  );
  await put(root, 'node_modules/tsx/index.mjs', 'export const loader = 1;');
  await put(
    root,
    'node_modules/esbuild/package.json',
    JSON.stringify({ name: 'esbuild', optionalDependencies: { '@esbuild/platform': '1' } })
  );
  await put(root, 'node_modules/esbuild/api.mjs', 'export const transform = 1;');
  await put(root, 'node_modules/@esbuild/platform/package.json', '{"name":"@esbuild/platform"}');
  await put(root, 'node_modules/@esbuild/platform/bin/compiler', 'native compiler bytes');
  return root;
}

it.each([
  'node_modules/tsx/index.mjs',
  'node_modules/esbuild/api.mjs',
  'node_modules/@esbuild/platform/bin/compiler',
  'tsconfig.json',
])('invalidates source execution on same-version %s changes', async (file) => {
  const root = await fixture();
  const from = join(root, 'src/executor.mjs');
  const before = await sourceLoaderIdentity(root, from);
  const replacement =
    file === 'tsconfig.json' ? '{"compilerOptions":{"target":"ES2024"}}' : 'new bytes';
  await put(root, file, replacement);
  expect(await sourceLoaderIdentity(root, from)).not.toBe(before);
});

it('refuses a missing loader rather than binding an absent development dependency', async () => {
  const root = await fixture();
  await rm(join(root, 'node_modules'), { recursive: true });
  await expect(sourceLoaderIdentity(root, join(root, 'source.mjs'))).rejects.toThrow(
    'installed tsx'
  );
});

it.each([
  { extends: '../external.json' },
  { compilerOptions: { paths: { '*': ['/external/*'] } } },
  { compilerOptions: { baseUrl: '/external' } },
  { compilerOptions: { rootDirs: ['/external'] } },
  { compilerOptions: { plugins: [{ name: 'external' }] } },
  [],
])('refuses an unqualified source configuration: %j', async (config) => {
  const root = await fixture();
  await put(root, 'tsconfig.json', JSON.stringify(config));
  await expect(sourceLoaderIdentity(root, join(root, 'source.mjs'))).rejects.toThrow(
    /qualif|self-contained/
  );
});

it('accepts only the owned source configuration without changing inherited project environment', async () => {
  const root = await fixture();
  const environment = { TSX_TSCONFIG_PATH: join(root, '.', 'tsconfig.json') };
  expect(() => {
    assertSourceLoaderEnvironment(root, {});
  }).not.toThrow();
  expect(() => {
    assertSourceLoaderEnvironment(root, environment);
  }).not.toThrow();
  expect(environment).toEqual({ TSX_TSCONFIG_PATH: join(root, '.', 'tsconfig.json') });
});

it('refuses binary or foreign configuration overrides before source execution', async () => {
  const root = await fixture();
  expect(() => {
    assertSourceLoaderEnvironment(root, { ESBUILD_BINARY_PATH: '/unbound/compiler' });
  }).toThrow('ESBUILD_BINARY_PATH');
  expect(() => {
    assertSourceLoaderEnvironment(root, { TSX_TSCONFIG_PATH: '/unbound/config.json' });
  }).toThrow('TSX_TSCONFIG_PATH');
  vi.stubEnv('ESBUILD_BINARY_PATH', '/unbound/compiler');
  await expect(sourceLoaderIdentity(root, join(root, 'source.mjs'))).rejects.toThrow(
    'ESBUILD_BINARY_PATH'
  );
});

it('registers the actual source bootstrap with its own config without setting process-wide config', async () => {
  const register = vi.fn();
  const source = await readFile(bootstrap, 'utf8');
  new Script(source, { filename: pathToFileURL(bootstrap).href }).runInNewContext({
    __dirname: dirname(bootstrap),
    require: (name: string) => {
      if (name === 'node:path') return { join };
      if (name === 'tsx/esm/api') return { register };
      throw new Error(`Unexpected bootstrap import: ${name}`);
    },
  });
  expect(register).toHaveBeenCalledExactlyOnceWith({
    tsconfig: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
  });
});

it('loads real TypeScript from a project with incompatible config without leaking config to its children', async () => {
  const root = await fixture();
  await put(root, 'tsconfig.json', '{"extends":"/unavailable-project-config.json"}');
  await put(
    root,
    'probe.mts',
    'const value: number = 17; console.log(JSON.stringify({value,config:process.env.TSX_TSCONFIG_PATH || null}));'
  );
  const child = await promisify(execFile)(
    process.execPath,
    ['--import', bootstrap, join(root, 'probe.mts')],
    { cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: '', TSX_DISABLE_CACHE: '1' } }
  );
  expect(JSON.parse(child.stdout)).toEqual({ value: 17, config: null });
});
