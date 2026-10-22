// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applicationIniPath, readBuildId, readLinkedAt } from '../launchable-build.js';

let engineDir: string;

async function write(path: string, content: string, seconds?: number): Promise<void> {
  await mkdir(dirname(join(engineDir, path)), { recursive: true });
  await writeFile(join(engineDir, path), content);
  if (seconds !== undefined) await utimes(join(engineDir, path), seconds, seconds);
}

beforeEach(async () => {
  engineDir = await mkdtemp(join(tmpdir(), 'ff-launchable-'));
});

afterEach(async () => {
  await rm(engineDir, { recursive: true, force: true });
});

describe('applicationIniPath', () => {
  it('uses Contents/Resources inside a macOS bundle and the binary directory elsewhere', () => {
    expect(applicationIniPath('/o/dist/Nightly.app/Contents/MacOS/firefox')).toBe(
      '/o/dist/Nightly.app/Contents/Resources/application.ini'
    );
    expect(applicationIniPath('/o/dist/bin/firefox')).toBe('/o/dist/bin/application.ini');
  });
});

describe('readBuildId', () => {
  it('reads BuildID from the bundle application.ini', async () => {
    await write('obj/dist/My.app/Contents/MacOS/mybrowser', '');
    await write(
      'obj/dist/My.app/Contents/Resources/application.ini',
      '[App]\nVendor=Mozilla\nBuildID=20261020142934\nName=My\n'
    );
    await expect(readBuildId(engineDir, 'obj/dist/My.app/Contents/MacOS/mybrowser')).resolves.toBe(
      '20261020142934'
    );
  });

  it('is undefined without the file or the key', async () => {
    await expect(readBuildId(engineDir, 'obj/dist/bin/mybrowser')).resolves.toBeUndefined();
    await write('obj/dist/bin/application.ini', '[App]\nName=My\n');
    await expect(readBuildId(engineDir, 'obj/dist/bin/mybrowser')).resolves.toBeUndefined();
  });
});

describe('readLinkedAt', () => {
  it('takes the newer of the binary and the libxul beside it', async () => {
    await write('obj/dist/bin/mybrowser', '', 1_000);
    await write('obj/dist/bin/libxul.so', '', 5_000);
    await expect(readLinkedAt(engineDir, 'obj/dist/bin/mybrowser')).resolves.toEqual({
      mtimeMs: 5_000_000,
      path: join(engineDir, 'obj/dist/bin/libxul.so'),
    });
  });

  it('is undefined when nothing can be read', async () => {
    await expect(readLinkedAt(engineDir, 'obj/dist/bin/mybrowser')).resolves.toBeUndefined();
  });
});
