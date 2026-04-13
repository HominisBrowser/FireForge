// SPDX-License-Identifier: EUPL-1.2
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function listTypescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypescriptFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('process exit boundary', () => {
  it('keeps process.exit out of shared src modules', async () => {
    const srcRoot = join(process.cwd(), 'src');
    const sourceFiles = (await listTypescriptFiles(srcRoot)).filter(
      (filePath) => !filePath.includes(join('src', '__tests__'))
    );
    const offenders: string[] = [];

    for (const filePath of sourceFiles) {
      const content = stripComments(await readFile(filePath, 'utf-8'));
      if (content.includes('process.exit(')) {
        offenders.push(relative(process.cwd(), filePath));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps process.exit confined to the bin entrypoint', async () => {
    const binEntrypoint = join(process.cwd(), 'bin', 'fireforge.ts');
    const content = stripComments(await readFile(binEntrypoint, 'utf-8'));

    // bin/fireforge.ts owns every process.exit in the project. The expected
    // count is the sum of:
    //   1. unhandledRejection handler
    //   2. CommandError exit in main().catch
    //   3. fallback fatal-error exit in main().catch
    //   4. SIGINT/SIGTERM re-entrant force-exit (in installFurnaceSignalHandler)
    //   5. SIGINT/SIGTERM post-rollback exit (in installFurnaceSignalHandler)
    // The signal handler is a single helper invoked once for each signal,
    // so its two process.exit calls show up once in the source even though
    // they apply to both signals.
    expect(content.match(/process\.exit\(/g)).toHaveLength(5);
  });
});
