// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for the tar extraction preflight: entry names and link targets are
 * validated from the archive listing before anything is written to disk.
 * Pure validator tests cover the parsing. Real-tar fixture tests drive
 * extractTarXz end-to-end against benign and malicious archives.
 */
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { exec } from '../../utils/process.js';
import {
  extractTarXz,
  findUnsafeArchiveEntryName,
  findUnsafeArchiveLink,
} from '../firefox-extract.js';

describe('findUnsafeArchiveEntryName', () => {
  it('accepts ordinary relative member names', () => {
    expect(
      findUnsafeArchiveEntryName([
        'firefox-140.0/',
        'firefox-140.0/browser/config/version.txt',
        'firefox-140.0/some..file/with..dots.txt',
        '',
      ])
    ).toBeUndefined();
  });

  it('rejects absolute POSIX names', () => {
    expect(findUnsafeArchiveEntryName(['ok.txt', '/etc/cron.d/evil'])).toBe('/etc/cron.d/evil');
  });

  it('rejects Windows drive-rooted and backslash-rooted names', () => {
    expect(findUnsafeArchiveEntryName(['C:\\Windows\\evil.dll'])).toBe('C:\\Windows\\evil.dll');
    expect(findUnsafeArchiveEntryName(['C:/Windows/evil.dll'])).toBe('C:/Windows/evil.dll');
    expect(findUnsafeArchiveEntryName(['\\\\server\\share\\evil'])).toBe('\\\\server\\share\\evil');
  });

  it('rejects .. traversal segments in either separator style', () => {
    expect(findUnsafeArchiveEntryName(['dir/../../evil.txt'])).toBe('dir/../../evil.txt');
    expect(findUnsafeArchiveEntryName(['dir\\..\\evil.txt'])).toBe('dir\\..\\evil.txt');
    expect(findUnsafeArchiveEntryName(['..'])).toBe('..');
  });

  it('rejects .git members at any depth, in either separator style', () => {
    expect(findUnsafeArchiveEntryName(['.git/config'])).toBe('.git/config');
    expect(findUnsafeArchiveEntryName(['firefox-140.0/.git/hooks/pre-commit'])).toBe(
      'firefox-140.0/.git/hooks/pre-commit'
    );
    expect(findUnsafeArchiveEntryName(['firefox-140.0/.git'])).toBe('firefox-140.0/.git');
    expect(findUnsafeArchiveEntryName(['firefox-140.0\\.GIT\\config'])).toBe(
      'firefox-140.0\\.GIT\\config'
    );
  });

  it('keeps legitimate upstream dotfiles such as .gitmodules and .gitignore', () => {
    expect(
      findUnsafeArchiveEntryName([
        'firefox-140.0/.gitmodules',
        'firefox-140.0/.gitignore',
        'firefox-140.0/.gitattributes',
        'firefox-140.0/tools/.github/workflows/x.yml',
        'firefox-140.0/mygit/config',
      ])
    ).toBeUndefined();
  });
});

describe('findUnsafeArchiveLink', () => {
  it('accepts regular files and inside-tree links', () => {
    expect(
      findUnsafeArchiveLink([
        '-rw-r--r--  0 user group 12 Jan  1  2026 dir/file.txt',
        'lrwxr-xr-x  0 user group  0 Jan  1  2026 dir/link -> file.txt',
        'lrwxr-xr-x  0 user group  0 Jan  1  2026 dir/deep -> sub/other.txt',
        'hrw-r--r--  0 user group  0 Jan  1  2026 dir/hard link to dir/file.txt',
      ])
    ).toBeUndefined();
  });

  it('rejects absolute symlink targets', () => {
    expect(
      findUnsafeArchiveLink(['lrwxr-xr-x  0 user group 0 Jan  1  2026 dir/link -> /etc/passwd'])
    ).toBe('symlink target: /etc/passwd');
  });

  it('rejects .. symlink targets and takes the LAST arrow as separator', () => {
    expect(
      findUnsafeArchiveLink(['lrwxr-xr-x  0 user group 0 Jan  1  2026 dir/a -> b -> ../../escape'])
    ).toBe('symlink target: ../../escape');
  });

  it('rejects escaping hardlink targets (GNU and bsdtar shapes)', () => {
    expect(
      findUnsafeArchiveLink(['-rw-r--r-- user/group 0 2026-01-01 00:00 dir/h link to /etc/passwd'])
    ).toBe('hardlink target: /etc/passwd');
    expect(
      findUnsafeArchiveLink(['hrw-r--r--  0 user group 0 Jan  1  2026 dir/h link to ../outside'])
    ).toBe('hardlink target: ../outside');
  });
});

/**
 * Builds a single-member tar buffer by hand so malicious member names can be
 * produced portably. `tar -cf` normalizes `..` and absolute names away on
 * most platforms unless invoked with non-portable flags.
 */
function buildTarWithMemberName(name: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf-8');
  header.write('0000644', 100, 8, 'utf-8'); // mode
  header.write('0000000', 108, 8, 'utf-8'); // uid
  header.write('0000000', 116, 8, 'utf-8'); // gid
  header.write(content.length.toString(8).padStart(11, '0'), 124, 12, 'utf-8'); // size
  header.write('00000000000', 136, 12, 'utf-8'); // mtime
  header.write('        ', 148, 8, 'utf-8'); // chksum placeholder (spaces)
  header.write('0', 156, 1, 'utf-8'); // typeflag: regular file
  header.write('ustar', 257, 6, 'utf-8'); // magic
  header.write('00', 263, 2, 'utf-8'); // version

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf-8');

  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content, 0, 'utf-8');
  return Buffer.concat([header, body, Buffer.alloc(1024)]);
}

/** Awaits a rejection and returns the message of its Error cause. */
async function causeMessageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error && error.cause instanceof Error) return error.cause.message;
    throw new Error('expected an Error carrying an Error cause', { cause: error });
  }
  throw new Error('expected promise to reject');
}

describe('extractTarXz preflight (real tar)', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await createTempProject('ff-extract-preflight-');
  });
  afterEach(async () => {
    await removeTempProject(tempRoot);
  });

  it('extracts a benign archive', async () => {
    const srcDir = join(tempRoot, 'src', 'firefox-140.0');
    await mkdir(join(srcDir, 'browser'), { recursive: true });
    await writeFile(join(srcDir, 'browser', 'ok.txt'), 'hello');

    const archivePath = join(tempRoot, 'benign.tar');
    const create = await exec('tar', ['-cf', archivePath, '-C', join(tempRoot, 'src'), '.']);
    expect(create.exitCode).toBe(0);

    const destDir = join(tempRoot, 'out');
    await extractTarXz(archivePath, destDir);
    expect(await readFile(join(destDir, 'firefox-140.0', 'browser', 'ok.txt'), 'utf-8')).toBe(
      'hello'
    );
  });

  it('rejects a member name with .. traversal before extracting anything', async () => {
    const archivePath = join(tempRoot, 'traversal.tar');
    await writeFile(archivePath, buildTarWithMemberName('dir/../../evil.txt', 'pwned'));

    const destDir = join(tempRoot, 'out');
    expect(await causeMessageOf(extractTarXz(archivePath, destDir))).toContain(
      'dir/../../evil.txt'
    );
    expect(await pathExists(join(tempRoot, 'evil.txt'))).toBe(false);
  });

  it('rejects a member that would seed .git before extracting anything', async () => {
    const archivePath = join(tempRoot, 'git-seed.tar');
    await writeFile(
      archivePath,
      buildTarWithMemberName('firefox-140.0/.git/hooks/post-checkout', '#!/bin/sh\necho pwned')
    );

    const destDir = join(tempRoot, 'out');
    expect(await causeMessageOf(extractTarXz(archivePath, destDir))).toContain(
      'firefox-140.0/.git/hooks/post-checkout'
    );
    expect(await pathExists(join(destDir, 'firefox-140.0', '.git'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink whose target is absolute',
    async () => {
      const srcDir = join(tempRoot, 'src');
      await mkdir(srcDir, { recursive: true });
      await symlink('/etc/passwd', join(srcDir, 'evil-link'));

      const archivePath = join(tempRoot, 'symlink.tar');
      const create = await exec('tar', ['-cf', archivePath, '-C', srcDir, 'evil-link']);
      expect(create.exitCode).toBe(0);

      expect(await causeMessageOf(extractTarXz(archivePath, join(tempRoot, 'out')))).toContain(
        'symlink target: /etc/passwd'
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink whose target escapes via ..',
    async () => {
      const srcDir = join(tempRoot, 'src');
      await mkdir(srcDir, { recursive: true });
      await symlink('../../outside.txt', join(srcDir, 'escape-link'));

      const archivePath = join(tempRoot, 'symlink-up.tar');
      const create = await exec('tar', ['-cf', archivePath, '-C', srcDir, 'escape-link']);
      expect(create.exitCode).toBe(0);

      expect(await causeMessageOf(extractTarXz(archivePath, join(tempRoot, 'out')))).toContain(
        'symlink target: ../../outside.txt'
      );
    }
  );

  it.skipIf(process.platform === 'win32')('accepts a safe relative symlink', async () => {
    const srcDir = join(tempRoot, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'real.txt'), 'real');
    await symlink('real.txt', join(srcDir, 'safe-link'));

    const archivePath = join(tempRoot, 'safe-symlink.tar');
    const create = await exec('tar', ['-cf', archivePath, '-C', srcDir, 'real.txt', 'safe-link']);
    expect(create.exitCode).toBe(0);

    const destDir = join(tempRoot, 'out');
    await extractTarXz(archivePath, destDir);
    expect(await readFile(join(destDir, 'real.txt'), 'utf-8')).toBe('real');
  });
});
