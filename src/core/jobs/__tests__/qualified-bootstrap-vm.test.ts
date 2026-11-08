// SPDX-License-Identifier: EUPL-1.2
import * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, Script } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The actual shipped CommonJS body is compiled unchanged under its real filename.
// No application process, global process object, or production bypass is patched.
const asset = fileURLToPath(
  new URL('../../../../runtime/qualified-node-bootstrap.cjs', import.meta.url)
);
let directory: string;
let root: string;
let entry: string;
let source: string;
let admitted: Record<string, unknown>;
let reply: { status: number; stdout: string; stderr: string } | undefined;
let cwd: string;
let env: Record<string, string>;
let manifest: Record<string, unknown>;
let injectedReadError: string | undefined;
const calls: Array<{
  command: string;
  args: string[];
  options: { input: string; env: Record<string, string> };
}> = [];

async function put(file: string, bytes: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
async function execute(
  args: string[] = [],
  name = 'prettier'
): Promise<{ argv: string[]; env: Record<string, string> }> {
  manifest['name'] = name;
  await put(path.join(directory, 'tool/package.json'), JSON.stringify(manifest));
  const processFixture = {
    env: { ...env },
    argv: [process.execPath, entry, ...args],
    execPath: process.execPath,
    pid: 2468,
    cwd: () => cwd,
  };
  const controlledRequire = (id: string): unknown => {
    if (id === 'node:fs' || id === 'fs')
      return {
        ...fs,
        readFileSync: (file: fs.PathOrFileDescriptor, options: BufferEncoding): string => {
          if (injectedReadError && String(file).endsWith(injectedReadError))
            throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
          return fs.readFileSync(file, options);
        },
      };
    if (id === 'node:path' || id === 'path') return path;
    if (id === 'node:os' || id === 'os') return { devNull, tmpdir };
    if (id === 'node:child_process' || id === 'child_process')
      return {
        spawnSync: (
          command: string,
          values: string[],
          options: { input: string; env: Record<string, string> }
        ) => {
          calls.push({ command, args: values, options });
          return reply ?? { status: 0, stdout: JSON.stringify(admitted), stderr: '' };
        },
      };
    throw new Error(`Unexpected bootstrap dependency: ${id}`);
  };
  const script = new Script(source, { filename: pathToFileURL(await realpath(asset)).href });
  script.runInContext(
    createContext({
      process: processFixture,
      require: controlledRequire,
      module: { exports: {} },
      exports: {},
      __filename: asset,
      __dirname: path.dirname(asset),
      Buffer,
      console,
    })
  );
  return processFixture;
}
const plain = (): string[] => ['--no-config', '--no-editorconfig', '--ignore-path', devNull];

beforeEach(async () => {
  directory = await mkdtemp('/tmp/ff-bootstrap-vm-');
  root = path.join(directory, 'slot');
  cwd = root;
  await mkdir(root);
  entry = path.join(directory, 'tool/cli.cjs');
  await put(entry, '// CLI fixture\n');
  source = await readFile(asset, 'utf8');
  admitted = {
    root,
    nodeExecutable: process.execPath,
    qualityToolsDigest: 'a'.repeat(64),
    sourceId: 'b'.repeat(64),
  };
  env = {
    FIREFORGE_JOB_TOKEN: 'private-capability',
    FIREFORGE_COORDINATOR: directory,
    FIREFORGE_JOB_ID: 'owned-job',
    FIREFORGE_JOB_PHASE: 'phase',
    FIREFORGE_ADAPTER_COMMAND: 'check',
    NODE_OPTIONS: 'existing-hook',
  };
  manifest = { name: 'prettier', version: '1.0.0', bin: 'cli.cjs' };
  reply = undefined;
  calls.length = 0;
  injectedReadError = undefined;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('shipped qualified bootstrap body in an isolated Node VM', () => {
  it('authenticates through stdin, clears child hooks and qualifies the real CLI cache', async () => {
    const before = process.argv.slice();
    const result = await execute([
      ...plain(),
      '--cache',
      '--cache-location=old',
      '--',
      '--cache-location=literal',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe('-e');
    expect(calls[0]?.args.join(' ')).not.toContain('private-capability');
    expect(calls[0]?.options.env['NODE_OPTIONS']).toBe('');
    expect(JSON.parse(calls[0]?.options.input ?? '')).toMatchObject({
      request: { pid: 2468, token: 'private-capability', phase: 'phase', command: 'check' },
    });
    expect(result.argv).toContain(
      path.join(root, '.fireforge/quality-caches', 'a'.repeat(64), 'b'.repeat(64), 'prettier/cache')
    );
    expect(result.argv.at(-1)).toBe('--cache-location=literal');
    expect(result.env['JITI_FS_CACHE']).toBe('false');
    expect(process.argv).toEqual(before);
  });

  it('leaves standalone, unknown-package and non-bin entry points untouched', async () => {
    env['FIREFORGE_JOB_TOKEN'] = '';
    expect((await execute(['--cache'])).argv.slice(2)).toEqual(['--cache']);
    env['FIREFORGE_JOB_TOKEN'] = 'private-capability';
    expect((await execute(['--cache'], 'not-a-validator')).argv.slice(2)).toEqual(['--cache']);
    await put(path.join(directory, 'tool/other.cjs'), '');
    manifest['bin'] = { prettier: 'other.cjs' };
    expect((await execute(['--cache'])).argv.slice(2)).toEqual(['--cache']);
    expect(calls).toEqual([]);
  });

  it('preserves filesystem access failures instead of treating them as absent package metadata', async () => {
    injectedReadError = 'package.json';
    await expect(execute(plain())).rejects.toThrow('fixture read denied');
    expect(calls).toEqual([]);
  });

  it('refuses failed authorization, malformed replies, alternate Node and incomplete identities', async () => {
    reply = { status: 1, stdout: '', stderr: 'denied' };
    await expect(execute(plain())).rejects.toThrow('authorization failed');
    reply = { status: 0, stdout: '{', stderr: '' };
    await expect(execute(plain())).rejects.toThrow();
    reply = undefined;
    admitted['nodeExecutable'] = entry;
    await expect(execute(plain())).rejects.toThrow('Alternate Node runtime');
    admitted['nodeExecutable'] = process.execPath;
    admitted['sourceId'] = '';
    await expect(execute(plain())).rejects.toThrow('no qualified tool/source identity');
  });

  it('requires complete explicit formatter config and ignore selection', async () => {
    await expect(execute([])).rejects.toThrow('requires explicit captured --config or --no-config');
    await expect(execute(['--config'])).rejects.toThrow('Missing explicit tool config');
    await expect(execute(['--config=a', '--config=b'])).rejects.toThrow(
      'requires explicit captured --config or --no-config'
    );
    await expect(execute(['--no-config', '--no-editorconfig'])).rejects.toThrow(
      'requires explicit --ignore-path'
    );
  });

  it('accepts captured config and ignores while refusing external, runtime and objdir inputs', async () => {
    const config = path.join(root, '.prettierrc');
    const ignore = path.join(root, '.prettierignore');
    await put(config, '{}');
    await put(ignore, 'generated/');
    expect(
      (await execute(['--config=' + config, '--ignore-path=' + ignore, '--no-editorconfig'])).env[
        'JITI_FS_CACHE'
      ]
    ).toBe('false');
    for (const file of [
      path.join(directory, 'outside'),
      path.join(root, '.fireforge/config'),
      path.join(root, 'engine/obj-debug/config'),
    ]) {
      await put(file, '{}');
      await expect(
        execute(['--config', file, '--ignore-path', devNull, '--no-editorconfig'])
      ).rejects.toThrow('outside the captured configuration boundary');
    }
  });

  it('walks captured editorconfig parents and refuses missing stop markers or unreadable rules', async () => {
    cwd = path.join(root, 'engine/nested');
    await mkdir(cwd, { recursive: true });
    await put(path.join(root, '.editorconfig'), 'root = true\n[*]\nindent_size=2');
    expect((await execute(['--no-config', '--ignore-path', devNull])).env['JITI_FS_CACHE']).toBe(
      'false'
    );
    await writeFile(path.join(root, '.editorconfig'), '[*]\nindent_size=2');
    await expect(execute(['--no-config', '--ignore-path', devNull])).rejects.toThrow(
      'must stop ancestor lookup'
    );
    injectedReadError = '.editorconfig';
    await expect(execute(['--no-config', '--ignore-path', devNull])).rejects.toThrow(
      'fixture read denied'
    );
  });

  it('accepts a flat ESLint config a project script generated in the temporary directory', async () => {
    const overlay = path.join(await realpath(tmpdir()), `ff-overlay-${process.pid}.config.mjs`);
    await put(overlay, 'export default [];');
    try {
      const result = await execute(['--config', overlay, 'src/a.js'], 'eslint');
      expect(result.argv).toContain(overlay);
    } finally {
      await rm(overlay, { force: true });
    }
    const outside = path.join(path.dirname(root), 'outside.config.mjs');
    await put(outside, 'export default [];');
    await expect(execute(['--config', outside], 'eslint')).rejects.toThrow(
      'outside the captured configuration boundary'
    );
    await expect(execute(['--config', overlay], 'prettier')).rejects.toThrow();
  });

  it('supports explicit legacy ESLint config without sharing a caller cache and refuses implicit lookup', async () => {
    await expect(execute([], 'eslint')).rejects.toThrow(
      'requires explicit no-ancestor config lookup'
    );
    const config = path.join(root, 'eslint.config.cjs');
    await put(config, 'module.exports=[];');
    const result = await execute(
      ['--no-eslintrc', '-c', config, '--cache-location', '/shared'],
      'eslint'
    );
    expect(result.argv).toContain(config);
    expect(result.argv).not.toContain('/shared');
    await expect(execute(['--no-config-lookup', '--cache-location'], 'eslint')).rejects.toThrow(
      'Missing cache location'
    );
  });
});
