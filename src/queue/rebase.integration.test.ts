// SPDX-License-Identifier: EUPL-1.2
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git } from '../testing/git.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { useTempDir } from '../testing/temp.js';
import {
  importQueue,
  queueStatus,
  readQueue,
  rebaseQueue,
  resolvePatchFromEngine,
} from './index.js';

const dir = useTempDir();
const BROWSER = 'browser/base/content/browser.js';
const MOZBUILD = 'browser/modules/moz.build';
const SERVICE = 'toolkit/components/example/service.sys.mjs';

const CONTEXT = [
  'line-a',
  'line-b',
  'line-c',
  'title = "baseline";',
  'line-d',
  'line-e',
  'line-f',
  '',
].join('\n');

async function stamps(fixture: PatchFixture): Promise<string[]> {
  return (await readQueue(fixture.patches)).patches.map((patch) => patch.firefox.version);
}

async function body(fixture: PatchFixture, filename: string): Promise<string> {
  return readFile(join(fixture.patches, filename), 'utf8');
}

describe('rebaseQueue', () => {
  it('re-applies a clean stack onto the new pin and stamps every patch', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
    await fixture.addPatch('infra-dirs', { [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n' });
    await fixture.pin('141.0esr');
    const result = await rebaseQueue(await fixture.project());
    expect(result.status).toBe('complete');
    expect(result.patches.map((patch) => patch.status)).toEqual(['applied-clean', 'applied-clean']);
    expect(await stamps(fixture)).toEqual(['141.0esr', '141.0esr']);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "patched";\n');
    expect((await queueStatus(await fixture.project())).session).toBeUndefined();
    const manifest = await readFile(join(fixture.patches, 'patches.json'), 'utf8');
    expect(manifest.match(/141\.0esr/g)).toHaveLength(1);
  });

  it('absorbs upstream context drift with reduced context and rewrites the body', async () => {
    const fixture = await createPatchProject(dir(), { files: { [BROWSER]: CONTEXT } });
    await fixture.addPatch('ui-title', { [BROWSER]: CONTEXT.replace('"baseline"', '"patched"') });
    await fixture.upstream({
      [BROWSER]: CONTEXT.replace('line-a', 'line-a-drifted').replace('line-f', 'line-f-drifted'),
    });
    await fixture.pin('141.0esr');
    const result = await rebaseQueue(await fixture.project());
    expect(result.patches).toEqual([
      { patch: '001-ui-title.patch', status: 'applied-fuzz', fuzz: 1 },
    ]);
    const content = await fixture.read(BROWSER);
    expect(content).toContain('"patched"');
    expect(content).toContain('line-a-drifted');
    expect(await body(fixture, '001-ui-title.patch')).toContain(' line-f-drifted');
    expect(await stamps(fixture)).toEqual(['141.0esr']);
    await fixture.resetEngine();
    expect((await importQueue(await fixture.project())).patches[0]?.status).toBe('applied-clean');
  });

  it('pauses on a conflicting patch and finishes with --continue', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
    await fixture.addPatch('infra-dirs', { [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n' });
    await fixture.upstream({ [BROWSER]: 'export const browserTitle = "upstream";\n' });
    await fixture.pin('141.0esr');
    const project = await fixture.project();
    await expect(rebaseQueue(project)).rejects.toMatchObject({
      code: 'patch-failed',
      message: expect.stringContaining('001-ui-title.patch') as string,
    });
    expect((await queueStatus(project)).session).toMatchObject({
      kind: 'rebase',
      current: { patch: '001-ui-title.patch', status: 'failed' },
    });
    expect(await stamps(fixture)).toEqual(['140.9.0esr', '140.9.0esr']);
    await expect(rebaseQueue(project)).rejects.toMatchObject({ code: 'session-active' });
    await expect(resolvePatchFromEngine(project)).rejects.toMatchObject({ code: 'no-session' });

    await fixture.edit({ [BROWSER]: 'export const browserTitle = "patched";\n' });
    const result = await rebaseQueue(project, { continue: true });
    expect(result.patches.map((patch) => patch.status)).toEqual(['resolved', 'applied-clean']);
    expect(await stamps(fixture)).toEqual(['141.0esr', '141.0esr']);
    expect(await body(fixture, '001-ui-title.patch')).toContain(
      '-export const browserTitle = "upstream";'
    );
    expect(await fixture.read(`${BROWSER}.rej`)).toBeUndefined();
    expect((await queueStatus(project)).session).toBeUndefined();
  });

  it('--continue rewrites a failed patch with only its own hunks when another patch shares the file', async () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    const text = (edit: (copy: string[]) => void): string => {
      const copy = [...lines];
      edit(copy);
      return `${copy.join('\n')}\n`;
    };
    const fixture = await createPatchProject(dir(), {
      files: { [BROWSER]: text(() => undefined) },
    });
    await fixture.addPatch('ui-top', { [BROWSER]: text((copy) => (copy[0] = 'top patched')) });
    await fixture.addPatch('ui-bottom', {
      [BROWSER]: text((copy) => {
        copy[0] = 'top patched';
        copy[11] = 'bottom patched';
      }),
    });
    await fixture.upstream({ [BROWSER]: text((copy) => (copy[11] = 'bottom upstream')) });
    await fixture.pin('141.0esr');
    const project = await fixture.project();
    await expect(rebaseQueue(project)).rejects.toMatchObject({ code: 'patch-failed' });
    await fixture.edit({
      [BROWSER]: text((copy) => {
        copy[0] = 'top patched';
        copy[11] = 'bottom resolved';
      }),
    });
    await rebaseQueue(project, { continue: true });
    const bottom = await body(fixture, '002-ui-bottom.patch');
    expect(bottom).toContain('+bottom resolved');
    expect(bottom).not.toContain('top patched');
    expect(await body(fixture, '001-ui-top.patch')).not.toContain('bottom');
  });

  it('--abort resets the engine after a snapshot and leaves the queue untouched', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
    const before = await body(fixture, '001-ui-title.patch');
    await fixture.upstream({ [BROWSER]: 'export const browserTitle = "upstream";\n' });
    await fixture.pin('141.0esr');
    const project = await fixture.project();
    await expect(rebaseQueue(project)).rejects.toMatchObject({ code: 'patch-failed' });
    await fixture.edit({ [BROWSER]: 'half done\n' });
    expect((await rebaseQueue(project, { abort: true })).status).toBe('aborted');
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "upstream";\n');
    expect(await body(fixture, '001-ui-title.patch')).toBe(before);
    expect((await queueStatus(project)).session).toBeUndefined();
    const refs = await git(fixture.engine, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/fireforge/recovery/',
    ]);
    expect(refs).toContain('rebase-abort');
    await expect(rebaseQueue(project, { abort: true })).rejects.toMatchObject({
      code: 'no-session',
    });
  });

  it('does nothing when every patch already carries the pin', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
    expect((await rebaseQueue(await fixture.project())).status).toBe('up-to-date');
  });

  it('recovers from a damaged session instead of wedging', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
    await fixture.pin('141.0esr');
    await writeFile(
      join(fixture.root, '.fireforge/state.json'),
      '{"queueSession": {"kind": "bogus"}}'
    );
    const project = await fixture.project();
    await expect(rebaseQueue(project)).rejects.toMatchObject({ code: 'state-invalid' });
    await expect(rebaseQueue(project, { continue: true })).rejects.toMatchObject({
      code: 'state-invalid',
    });
    expect((await rebaseQueue(project, { abort: true })).status).toBe('aborted');
    expect((await rebaseQueue(project)).status).toBe('complete');
  });

  // Windows does not make a directory read-only through its mode.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retries the rewrite when it failed after every patch applied',
    async () => {
      const fixture = await createPatchProject(dir());
      await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
      await fixture.pin('141.0esr');
      const project = await fixture.project();
      await chmod(fixture.patches, 0o555);
      try {
        await expect(rebaseQueue(project)).rejects.toThrow();
      } finally {
        await chmod(fixture.patches, 0o755);
      }
      expect((await queueStatus(project)).session).toMatchObject({
        kind: 'rebase',
        done: 1,
        total: 1,
      });
      expect((await rebaseQueue(project, { continue: true })).status).toBe('complete');
      expect(await stamps(fixture)).toEqual(['141.0esr']);
    }
  );

  it('--dry-run reports every patch on a private index and changes nothing', async () => {
    const fixture = await createPatchProject(dir(), { files: { [BROWSER]: CONTEXT } });
    await fixture.addPatch('ui-title', { [BROWSER]: CONTEXT.replace('"baseline"', '"patched"') });
    await fixture.addPatch('infra-dirs', { [MOZBUILD]: 'DIRS += ["mine"]\n' });
    await fixture.addPatch('ui-service', { [SERVICE]: 'export const version = 2;\n' });
    await fixture.upstream({
      [BROWSER]: CONTEXT.replace('line-a', 'line-a-drifted').replace('line-f', 'line-f-drifted'),
      [MOZBUILD]: 'DIRS += ["upstream"]\n',
    });
    await fixture.edit({ [SERVICE]: 'dirty\n' });
    await fixture.pin('141.0esr');
    const index = await git(fixture.engine, ['ls-files', '-s']);
    const result = await rebaseQueue(await fixture.project(), { dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.patches.map((patch) => [patch.patch, patch.status])).toEqual([
      ['001-ui-title.patch', 'applied-fuzz'],
      ['002-infra-dirs.patch', 'failed'],
      ['003-ui-service.patch', 'applied-clean'],
    ]);
    expect(await fixture.read(SERVICE)).toBe('dirty\n');
    expect(await fixture.read(BROWSER)).toContain('"baseline"');
    expect(await git(fixture.engine, ['ls-files', '-s'])).toBe(index);
    expect(await stamps(fixture)).toEqual(['140.9.0esr', '140.9.0esr', '140.9.0esr']);
  });
});

describe('a patch that deletes an upstream file', () => {
  it('keeps the deletion through resolve and rebase', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-cleanup', {
      [SERVICE]: null,
      [BROWSER]: 'export const browserTitle = "patched";\n',
    });
    expect(await body(fixture, '001-ui-cleanup.patch')).toContain('deleted file mode');

    await fixture.upstream({ [BROWSER]: 'export const browserTitle = "upstream";\n' });
    await fixture.pin('141.0esr');
    const project = await fixture.project();
    await expect(rebaseQueue(project)).rejects.toMatchObject({ code: 'patch-failed' });
    await fixture.edit({ [BROWSER]: 'export const browserTitle = "patched";\n', [SERVICE]: null });
    await rebaseQueue(project, { continue: true });
    expect(await body(fixture, '001-ui-cleanup.patch')).toContain('deleted file mode');

    await fixture.upstream({ [BROWSER]: 'export const browserTitle = "upstream 2";\n' });
    await expect(importQueue(project)).rejects.toMatchObject({ code: 'patch-failed' });
    await fixture.edit({ [BROWSER]: 'export const browserTitle = "patched";\n', [SERVICE]: null });
    await resolvePatchFromEngine(project);
    expect(await body(fixture, '001-ui-cleanup.patch')).toContain('deleted file mode');
    await importQueue(project, { continue: true });
    expect(await fixture.read(SERVICE)).toBeUndefined();
  });
});

describe('a fresh rebase over engine edits', () => {
  it('refuses edits the queue does not account for, and overwrites them only when forced', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
    await fixture.edit({ [SERVICE]: 'export const version = 99;\n' });
    await fixture.pin('141.0esr');
    const project = await fixture.project();
    await expect(rebaseQueue(project)).rejects.toMatchObject({
      code: 'engine-unexported-edits',
      message: expect.stringContaining(SERVICE) as string,
    });
    expect(await fixture.read(SERVICE)).toBe('export const version = 99;\n');
    expect(await stamps(fixture)).toEqual(['140.9.0esr']);
    const result = await rebaseQueue(project, { force: true });
    expect(result.status).toBe('complete');
    expect(await fixture.read(SERVICE)).toBe('export const version = 1;\n');
    const refs = await git(fixture.engine, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/fireforge/recovery/',
    ]);
    expect(refs).toContain('-rebase-');
  });
});
