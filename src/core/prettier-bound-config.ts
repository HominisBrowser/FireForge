// SPDX-License-Identifier: EUPL-1.2
import { readFile, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { getNodeErrorCode } from '../utils/errors.js';

const CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  '.prettierrc.cts',
  '.prettierrc.mts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
];
async function present(path: string, root: string): Promise<boolean> {
  try {
    const canonical = await realpath(path);
    const boundary = await realpath(root);
    if (canonical !== boundary && !canonical.startsWith(boundary + sep))
      throw new Error(`Formatter config escapes captured root: ${path}`);
    return true;
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
async function localConfig(directory: string, boundary: string): Promise<string | undefined> {
  const files: string[] = [];
  for (const name of CONFIGS)
    if (await present(join(directory, name), boundary)) files.push(join(directory, name));
  if (files.length > 1)
    throw new Error(`Multiple formatter configs require explicit qualification: ${directory}`);
  try {
    const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (value['prettier'] !== undefined)
      throw new Error(
        'Package-embedded prettier config requires a captured explicit config file for coordinated execution'
      );
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  return files[0];
}

/** Preserve supported local rules and forbid implicit home/namespace ancestry configuration. */
export async function boundPrettierConfiguration(
  engine: string,
  project: string,
  files: readonly string[]
): Promise<{ args: string[]; inputs: string[] }> {
  const inputs: string[] = [];
  const config = (await localConfig(engine, project)) ?? (await localConfig(project, project));
  if (config) inputs.push(config);
  for (const file of files) {
    let directory = dirname(resolve(engine, file));
    if (directory !== resolve(engine) && !directory.startsWith(resolve(engine) + sep))
      throw new Error('Formatter file escapes captured engine');
    while (directory !== resolve(engine)) {
      if (
        (await localConfig(directory, project)) ||
        (await present(join(directory, '.editorconfig'), project))
      )
        throw new Error(
          `Nested formatter/editorconfig layout is unsupported until qualified: ${directory}; use an explicit grouped adapter`
        );
      directory = dirname(directory);
    }
  }
  let editor = false;
  let stop = false;
  for (const root of [engine, project]) {
    const path = join(root, '.editorconfig');
    if (!(await present(path, project))) continue;
    editor = true;
    inputs.push(path);
    if (/^\s*root\s*=\s*true\s*$/im.test(await readFile(path, 'utf8'))) {
      stop = true;
      break;
    }
  }
  if (editor && !stop)
    throw new Error('Captured .editorconfig must stop ancestor lookup with root=true');
  const ignore: string[] = [];
  for (const name of ['.gitignore', '.prettierignore'])
    if (await present(join(engine, name), project)) {
      ignore.push(join(engine, name));
      inputs.push(join(engine, name));
    }
  return {
    args: [
      ...(config ? ['--config', config] : ['--no-config']),
      ...(editor ? [] : ['--no-editorconfig']),
      ...(ignore.length
        ? ignore.flatMap((path) => ['--ignore-path', path])
        : ['--ignore-path', devNull]),
    ],
    inputs,
  };
}
