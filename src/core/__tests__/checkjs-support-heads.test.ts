// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findUnownedSupportHeads,
  formatUnownedSupportHeadNotice,
} from '../checkjs-support-heads.js';

const DIR = 'browser/base/content/test/world';

describe('findUnownedSupportHeads', () => {
  let engine: string;

  beforeEach(async () => {
    engine = await mkdtemp(join(tmpdir(), 'ff-support-heads-'));
  });

  afterEach(async () => {
    await rm(engine, { recursive: true, force: true });
  });

  async function write(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(engine, path)), { recursive: true });
      await writeFile(join(engine, path), content);
    }
  }

  it('finds loadSubScript and support-files heads, skipping owned and unreferenced ones', async () => {
    await write({
      [`${DIR}/browser_page.js`]:
        'Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_world_page.js", this);\n',
      [`${DIR}/head_world_page.js`]: 'function a() {}\n',
      [`${DIR}/head_world_callers.js`]: 'function b() {}\n',
      [`${DIR}/head_owned.js`]: 'function c() {}\n',
      [`${DIR}/head_unused.js`]: 'function d() {}\n',
      [`${DIR}/browser.toml`]:
        '[DEFAULT]\nsupport-files = [\n  "head_world_callers.js",\n  "head_owned.js",\n]\n',
    });
    const heads = await findUnownedSupportHeads(
      engine,
      [`${DIR}/browser_page.js`, `${DIR}/browser_missing.js`],
      new Set([`${DIR}/head_owned.js`])
    );
    expect(heads).toEqual([
      {
        file: `${DIR}/head_world_callers.js`,
        reason: `${DIR}/browser.toml lists it in support-files`,
      },
      {
        file: `${DIR}/head_world_page.js`,
        reason: `${DIR}/browser_page.js loads it with loadSubScript`,
      },
    ]);
  });

  it('skips a directory that cannot be listed', async () => {
    expect(await findUnownedSupportHeads(engine, ['nowhere/browser_x.js'], new Set())).toEqual([]);
  });

  it('names the head, the reason and the adoption command in the notice', () => {
    const notice = formatUnownedSupportHeadNotice({
      file: `${DIR}/head_world_page.js`,
      reason: `${DIR}/browser_page.js loads it with loadSubScript`,
    });
    expect(notice).toContain(`${DIR}/head_world_page.js is in no patch yet`);
    expect(notice).toContain(`--scan-file ${DIR}/head_world_page.js`);
    expect(notice).toContain('Do NOT add its globals to the test shim');
  });
});
