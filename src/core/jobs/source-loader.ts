// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolvedNodeToolIdentity } from '../node-tool-identity.js';

/** Source executors use FireForge's own configuration, never the caller's compiler overrides. */
export function assertSourceLoaderEnvironment(
  packageRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): void {
  const config = join(packageRoot, 'tsconfig.json');
  if (environment['ESBUILD_BINARY_PATH'])
    throw new Error('Unqualified ESBUILD_BINARY_PATH is unsupported for source execution');
  const inherited = environment['TSX_TSCONFIG_PATH'];
  if (inherited && resolve(inherited) !== resolve(config))
    throw new Error("Source execution requires FireForge's own TSX_TSCONFIG_PATH");
}

/**
 * FireForge running from TypeScript keeps tsx's transform cache: it is keyed by
 * content, private to this user, and recompiling on every spawn costs half a
 * second per process. An installed FireForge compiles nothing of its own, so a
 * project tool that brings tsx to a phase gets no cache there.
 */
export const sourceLoaderCacheEnvironment = (fromSource: boolean): Record<string, string> =>
  fromSource ? {} : { TSX_DISABLE_CACHE: '1' };

/** Bind the real development loader, its native transform graph and its closed configuration. */
export async function sourceLoaderIdentity(packageRoot: string, from: string): Promise<string> {
  assertSourceLoaderEnvironment(packageRoot);
  const bytes = await readFile(join(packageRoot, 'tsconfig.json'));
  const config: unknown = JSON.parse(bytes.toString('utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config) || 'extends' in config)
    throw new Error('Qualified source execution requires a self-contained JSON tsconfig');
  const options = 'compilerOptions' in config ? config.compilerOptions : undefined;
  if (
    options &&
    typeof options === 'object' &&
    ['paths', 'baseUrl', 'rootDirs', 'plugins'].some((key) => key in options)
  )
    throw new Error('Custom source-loader resolution requires an explicit qualification contract');
  const loader = await resolvedNodeToolIdentity('tsx', from);
  if (loader === 'absent') throw new Error('Qualified source execution requires installed tsx');
  return createHash('sha256').update(bytes).update(loader).digest('hex');
}
