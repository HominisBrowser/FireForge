// SPDX-License-Identifier: EUPL-1.2
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pathExists } from '../utils/fs.js';

interface EngineFormatter {
  format(content: string, options: Record<string, unknown>): Promise<string>;
  resolveConfig(file: string): Promise<Record<string, unknown> | null>;
}

/** Keep generated JSONC in the engine's own formatter contract, including comments. */
export async function formatGeneratedJsconfig(
  root: string,
  file: string,
  content: string
): Promise<string> {
  const packageFile = join(root, 'engine', 'node_modules', 'prettier', 'package.json');
  if (!(await pathExists(packageFile))) return content;
  const entry = createRequire(packageFile).resolve('prettier');
  const module = (await import(pathToFileURL(entry).href)) as EngineFormatter & {
    default?: EngineFormatter;
  };
  const formatter = module.default ?? module;
  if (typeof formatter.format !== 'function' || typeof formatter.resolveConfig !== 'function')
    throw new Error('Engine Prettier does not expose the required formatting API');
  return formatter.format(content, { ...(await formatter.resolveConfig(file)), filepath: file });
}
