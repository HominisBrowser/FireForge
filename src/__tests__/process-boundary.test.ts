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

    // bin/fireforge.ts owns every process.exit in the project. Only two
    // direct call sites remain:
    //   1. inside exitAfterStdioFlush — the drain-then-exit helper every
    //      delayed exit (unhandledRejection, both main().catch branches,
    //      the SIGINT/SIGTERM post-rollback exit) routes through, so a
    //      piped stdout is flushed before termination
    //   2. the SIGINT/SIGTERM re-entrant force-exit (a second Ctrl+C means
    //      "out NOW" and must not wait on a full pipe)
    expect(content.match(/process\.exit\(/g)).toHaveLength(2);

    // The helper's definition plus its four delayed-exit call sites; a new
    // direct process.exit would silently reintroduce the 64 KiB pipe
    // truncation this guards against.
    expect(content.match(/exitAfterStdioFlush\(/g)).toHaveLength(5);
  });
});
