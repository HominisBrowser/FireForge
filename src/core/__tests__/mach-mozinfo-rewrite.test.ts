// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, writeJson } from '../../utils/fs.js';
import { attemptMozinfoRewrite } from '../mach-build-artifacts.js';

describe('attemptMozinfoRewrite', () => {
  let engineDir: string;
  const objDir = 'obj-debug';

  beforeEach(async () => {
    engineDir = await mkdtemp(join(tmpdir(), 'ff-mozinfo-'));
    await ensureDir(join(engineDir, objDir));
  });

  afterEach(async () => {
    await rm(engineDir, { recursive: true, force: true });
  });

  async function writeMozinfo(payload: Record<string, unknown>): Promise<void> {
    await writeJson(join(engineDir, objDir, 'mozinfo.json'), payload);
  }

  async function readMozinfo(): Promise<Record<string, unknown>> {
    const raw = await readFile(join(engineDir, objDir, 'mozinfo.json'), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it('rewrites topsrcdir / topobjdir in place for a pure prefix relocation', async () => {
    const oldSrc = '/Users/dev/project1/engine';
    await writeMozinfo({
      topsrcdir: oldSrc,
      topobjdir: `${oldSrc}/${objDir}`,
      mozconfig: `${oldSrc}/mozconfig`,
      extraField: 'preserved',
    });

    const result = await attemptMozinfoRewrite(engineDir, objDir);
    expect(result.rewritten).toBe(true);
    expect(result.newTopsrcdir).toBe(engineDir);
    expect(result.newTopobjdir).toBe(join(engineDir, objDir));
    expect(result.newMozconfig).toBe(join(engineDir, 'mozconfig'));

    const patched = await readMozinfo();
    expect(patched['topsrcdir']).toBe(engineDir);
    expect(patched['topobjdir']).toBe(join(engineDir, objDir));
    expect(patched['mozconfig']).toBe(join(engineDir, 'mozconfig'));
    expect(patched['extraField']).toBe('preserved');
  });

  it('leaves a mozconfig that lives outside the old topsrcdir untouched', async () => {
    // External mozconfigs (e.g. a shared config in $HOME) survive a
    // relocation unchanged. The rewriter refuses to guess where they
    // should now point.
    const oldSrc = '/Users/dev/project1/engine';
    const sharedMozconfig = '/Users/dev/configs/shared-mozconfig';
    await writeMozinfo({
      topsrcdir: oldSrc,
      topobjdir: `${oldSrc}/${objDir}`,
      mozconfig: sharedMozconfig,
    });

    const result = await attemptMozinfoRewrite(engineDir, objDir);
    expect(result.rewritten).toBe(true);
    expect(result.newMozconfig).toBeUndefined();

    const patched = await readMozinfo();
    expect(patched['mozconfig']).toBe(sharedMozconfig);
  });

  it('refuses when mozinfo.json is absent', async () => {
    const result = await attemptMozinfoRewrite(engineDir, objDir);
    expect(result.rewritten).toBe(false);
    expect(result.reason).toContain('mozinfo.json not found');
  });

  it('refuses when topsrcdir is missing', async () => {
    await writeMozinfo({ topobjdir: '/somewhere/obj' });
    const result = await attemptMozinfoRewrite(engineDir, objDir);
    expect(result.rewritten).toBe(false);
    expect(result.reason).toMatch(/topsrcdir|topobjdir/);
  });

  it('refuses when topobjdir lives outside topsrcdir', async () => {
    // Out-of-tree builds record a topobjdir that does not sit under
    // topsrcdir. A blind prefix rewrite would land it in the wrong place,
    // so the rewriter bails and surfaces the refusal reason.
    await writeMozinfo({
      topsrcdir: '/Users/dev/project1/engine',
      topobjdir: '/Users/dev/objdirs/project1-debug',
    });

    const result = await attemptMozinfoRewrite(engineDir, objDir);
    expect(result.rewritten).toBe(false);
    expect(result.reason).toContain('not inside topsrcdir');
  });

  it('refuses when the objdir name itself changed', async () => {
    // mozinfo recorded `obj-arm64` but we're detecting `obj-debug` on
    // disk. That is not a pure prefix move (the configure shape changed),
    // so the rewrite is unsafe.
    await writeMozinfo({
      topsrcdir: '/Users/dev/project1/engine',
      topobjdir: '/Users/dev/project1/engine/obj-arm64',
    });

    const result = await attemptMozinfoRewrite(engineDir, objDir);
    expect(result.rewritten).toBe(false);
    expect(result.reason).toMatch(/obj directory name|does not match detected objdir/);
  });

  it('refuses when mozinfo.json is not a JSON object', async () => {
    await writeJson(join(engineDir, objDir, 'mozinfo.json'), ['topsrcdir'] as never);
    const result = await attemptMozinfoRewrite(engineDir, objDir);
    expect(result.rewritten).toBe(false);
    expect(result.reason).toContain('JSON object');
  });
});
