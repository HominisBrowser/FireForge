// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureFirefoxIgnorefileCompatibility } from '../firefox-ignorefile.js';

async function writeFixtureFile(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}

describe('ensureFirefoxIgnorefileCompatibility', () => {
  it('copies .gitignore to .hgignore when Firefox ignorefile lint config is present', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-ignorefile-'));

    try {
      const ignoreContent = 'obj-*/\n*.pyc\n';
      await writeFixtureFile(engineDir, 'tools/lint/ignorefile.yml', 'include:\n  - .hgignore\n');
      await writeFixtureFile(engineDir, '.gitignore', ignoreContent);

      await expect(ensureFirefoxIgnorefileCompatibility(engineDir)).resolves.toBe('created');
      await expect(readFile(join(engineDir, '.hgignore'), 'utf8')).resolves.toBe(ignoreContent);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing .hgignore', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-ignorefile-'));

    try {
      await writeFixtureFile(engineDir, 'tools/lint/ignorefile.yml', 'include:\n  - .hgignore\n');
      await writeFixtureFile(engineDir, '.gitignore', 'git\n');
      await writeFixtureFile(engineDir, '.hgignore', 'hg\n');

      await expect(ensureFirefoxIgnorefileCompatibility(engineDir)).resolves.toBe('existing');
      await expect(readFile(join(engineDir, '.hgignore'), 'utf8')).resolves.toBe('hg\n');
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('skips non-Firefox-like trees without ignorefile lint config', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-ignorefile-'));

    try {
      await writeFixtureFile(engineDir, '.gitignore', 'obj-*/\n');

      await expect(ensureFirefoxIgnorefileCompatibility(engineDir)).resolves.toBe('skipped');
      await expect(readFile(join(engineDir, '.hgignore'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });
});
