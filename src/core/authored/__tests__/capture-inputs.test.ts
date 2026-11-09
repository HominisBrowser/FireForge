// SPDX-License-Identifier: EUPL-1.2
import { mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { captureAuthoredSnapshot } from '../capture.js';
import { generateAuthoredDelta } from '../generate.js';
import * as gitTransport from '../git.js';
import { sourceGit } from '../git.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  return value;
}

async function capture(
  root: string,
  pristine: string,
  extra: Partial<Parameters<typeof captureAuthoredSnapshot>[0]> = {}
): Promise<Awaited<ReturnType<typeof captureAuthoredSnapshot>>> {
  return captureAuthoredSnapshot({ projectRoot: root, pristineRepository: pristine, ...extra });
}

it('ignores what Git ignores outside the source roots, so checkouts of one commit agree', async () => {
  const { root, pristine } = await fixture();
  await writeAt(root, '.gitignore', 'engine/\n.fireforge/\ndist/\nnode_modules\n.DS_Store\n');
  await writeAt(root, 'components/kit/index.mjs', 'export const kit = 1;\n');
  await commitFixture(root);
  const clean = await capture(root, pristine);
  await writeAt(root, 'components/kit/dist/bundle.js', 'built output\n');
  await writeAt(root, 'src/browser/.DS_Store', 'finder noise\n');
  await mkdir(join(root, 'components/kit/tailwind'), { recursive: true });
  await symlink('/nonexistent', join(root, 'components/kit/tailwind/node_modules'));
  const built = await capture(root, pristine);
  expect(built.tree).toBe(clean.tree);
  const worktree = join(dirname(root), 'linked');
  await sourceGit(root, ['worktree', 'add', '-q', worktree]);
  expect((await capture(worktree, pristine)).tree).toBe(clean.tree);
});

it('refuses a source file Git would leave out of the commit, naming it', async () => {
  const { root, pristine } = await fixture();
  await writeAt(root, '.gitignore', 'engine/\n.fireforge/\ndist/\n');
  await commitFixture(root);
  await writeAt(root, 'src/browser/dist/helper.mjs', 'export {};\n');
  await expect(capture(root, pristine)).rejects.toThrow(
    'authored-ignored-source: src/browser/dist/helper.mjs'
  );
});

it('includes an ignored file named individually, with a notice', async () => {
  const { root, pristine } = await fixture();
  await writeAt(root, '.gitignore', 'engine/\n.fireforge/\n*.local\n');
  await commitFixture(root);
  await writeAt(root, 'tools/settings.local', 'chosen\n');
  const notices: string[] = [];
  const snapshot = await capture(root, pristine, {
    intendedPaths: ['tools/settings.local'],
    onNotice: (message) => notices.push(message),
  });
  expect(snapshot.inputs.map((input) => input.path)).toContain('tools/settings.local');
  expect(notices.join('\n')).toContain('tools/settings.local');
});

it('refuses dirty tracked inputs it would otherwise omit, unless told to prove committed bytes', async () => {
  const { root, pristine } = await fixture();
  await writeAt(root, 'tools/run.mjs', 'committed\n');
  await commitFixture(root);
  await writeAt(root, 'tools/run.mjs', 'edited\n');
  await expect(capture(root, pristine)).rejects.toThrow('authored-dirty-input: tools/run.mjs');
  const notices: string[] = [];
  const left = await capture(root, pristine, {
    allowDirtyRoot: true,
    onNotice: (message) => notices.push(message),
  });
  expect(notices.join('\n')).toContain('tools/run.mjs');
  const bytes = await gitTransport.readSourceBlob(
    root,
    left.inputs.find((input) => input.path === 'tools/run.mjs')?.blob ?? ''
  );
  expect(bytes.toString()).toBe('committed\n');
  const named = await capture(root, pristine, { intendedPaths: ['tools/run.mjs'] });
  const edited = await gitTransport.readSourceBlob(
    root,
    named.inputs.find((input) => input.path === 'tools/run.mjs')?.blob ?? ''
  );
  expect(edited.toString()).toBe('edited\n');
});

it('refuses a source file whose committed bytes attributes could change, and accepts -text', async () => {
  const { root, pristine } = await fixture();
  await writeAt(root, '.gitattributes', '* text=auto\n');
  await commitFixture(root);
  await expect(capture(root, pristine)).rejects.toThrow('authored-source-filtered');
  await writeAt(root, 'src/.gitattributes', '* -text\n');
  await writeAt(root, 'src/browser/crlf.txt', Buffer.from('a\r\nb\r\n'));
  const snapshot = await capture(root, pristine);
  const delta = await generateAuthoredDelta(snapshot, { pristineRepository: pristine });
  expect(delta).toContain('+a\r\n');
  await commitFixture(root);
  const worktree = join(dirname(root), 'fresh-checkout');
  await sourceGit(root, ['worktree', 'add', '-q', worktree]);
  const fresh = await capture(worktree, pristine);
  expect(fresh.tree).toBe(snapshot.tree);
  expect(await generateAuthoredDelta(fresh, { pristineRepository: pristine })).toBe(delta);
});

it('applies reserved names to the first segment only, at capture rather than slot preparation', async () => {
  const { root, pristine } = await fixture();
  await writeAt(root, '.gitignore', '/engine/\n.fireforge/\n');
  await writeAt(root, 'docs/secrets/note.md', 'fine\n');
  await writeAt(root, 'src/toolkit/engine/x.js', 'export {};\n');
  await commitFixture(root);
  const snapshot = await capture(root, pristine);
  expect(snapshot.inputs.map((input) => input.path)).toContain('docs/secrets/note.md');
  await writeAt(root, 'secrets/key.txt', 'never\n');
  await commitFixture(root);
  await expect(capture(root, pristine)).rejects.toThrow('authored-reserved-input: secrets/key.txt');
});

it('keeps its cost out of the donor: only path-limited reads, never a whole-tree listing', async () => {
  const { root, pristine } = await fixture();
  const original = gitTransport.sourceGit;
  const donorCalls: string[][] = [];
  vi.spyOn(gitTransport, 'sourceGit').mockImplementation(async (...args) => {
    if (args[0] === pristine) donorCalls.push([...args[1]]);
    return original(...args);
  });
  await capture(root, pristine);
  expect(donorCalls.length).toBeLessThanOrEqual(3);
  expect(donorCalls.filter((call) => call[0] === 'ls-tree' && call.includes('-r'))).toEqual([]);
});

it('leaves no refs with retain false, and gives one source one id across checkouts and hosts', async () => {
  const { root, pristine } = await fixture();
  const handle = await capture(root, pristine, { retain: false });
  expect((await sourceGit(root, ['for-each-ref', 'refs/fireforge'])).toString('utf8').trim()).toBe(
    ''
  );
  expect(JSON.stringify(handle)).not.toContain('gitVersion');
  const retained = await capture(root, pristine);
  expect(retained.id).toBe(handle.id);
  expect((await sourceGit(root, ['for-each-ref', 'refs/fireforge'])).toString('utf8')).toContain(
    `refs/fireforge/snapshots/${handle.id}`
  );
});

it('names the fix when a linked worktree has no donor, and finds the main checkout donor', async () => {
  const { root, pristine } = await fixture();
  const worktree = join(dirname(root), 'wt');
  await sourceGit(root, ['worktree', 'add', '-q', worktree]);
  await expect(captureAuthoredSnapshot({ projectRoot: worktree })).rejects.toThrow(
    'authored-repository-missing'
  );
  await mkdir(join(root, 'engine'));
  await expect(captureAuthoredSnapshot({ projectRoot: root })).rejects.toThrow(
    'authored-repository-missing'
  );
  await rm(join(root, 'engine'), { recursive: true });
  await symlink(pristine, join(root, 'engine'));
  const snapshot = await captureAuthoredSnapshot({ projectRoot: worktree });
  expect(snapshot.repository).toBe(worktree);
});
