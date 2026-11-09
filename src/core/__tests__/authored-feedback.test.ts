// SPDX-License-Identifier: EUPL-1.2
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerAuthored } from '../../commands/authored.js';
import { setMachineOutputMode } from '../../utils/logger.js';
import { commitFixture, sourceFixture, writeAt } from '../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../authored/capture.js';
import { sourceGit } from '../authored/git.js';
import {
  authoredGateContext,
  lintAuthoredSource,
  verifyAuthoredSource,
} from '../authored-gates.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setMachineOutputMode(false);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const LICENSED =
  '/* This Source Code Form is subject to the terms of the Mozilla Public\n * License, v. 2.0. If a copy of the MPL was not distributed with this\n * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n\nexport const value = 1;\n';

async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  await writeAt(value.root, 'src/browser/new.js', LICENSED);
  await commitFixture(value.root);
  // No coordinator exists for these checkouts: nothing below may need one.
  vi.stubEnv('FIREFORGE_COORDINATOR', join(dirname(value.root), 'no-namespace'));
  vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
  return value;
}

async function run(root: string, args: string[]): Promise<string> {
  const output: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const argv = process.argv;
  process.argv = ['node', 'fireforge', 'authored', ...args];
  try {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerAuthored(program, {
      getProjectRoot: () => root,
      withErrorHandling: (handler) => handler,
    });
    await program.parseAsync(['authored', ...args], { from: 'user' });
    return output.join('');
  } finally {
    process.argv = argv;
    stdout.mockRestore();
  }
}

describe('off-slot static feedback', () => {
  it('lints a checkout with no slot, job or namespace, and reports what is there', async () => {
    const value = await fixture();
    const clean = await run(value.root, ['lint']);
    expect(clean).toContain('authored lint: 0 error(s)');
    await writeAt(value.root, 'src/browser/bad.js', 'export const unlicensed = 1;\n');
    await expect(run(value.root, ['lint'])).rejects.toThrow('found 1 error(s)');
    const issues = await lintAuthoredSource(value.root);
    expect(issues.some((issue) => issue.check === 'missing-license-header')).toBe(true);
    await expect(lstat(join(dirname(value.root), 'no-namespace'))).rejects.toThrow();
    expect((await sourceGit(value.root, ['for-each-ref', 'refs/fireforge'])).length).toBe(0);
  });

  it('judges a saved handle, not the checkout that has moved on', async () => {
    const value = await fixture();
    const handle = join(value.root, '.fireforge/handle.json');
    await run(value.root, ['capture', '--out', handle]);
    await writeAt(value.root, 'src/browser/bad.js', 'export const unlicensed = 1;\n');
    expect(await run(value.root, ['lint', '--snapshot', handle, '--json'])).toContain(
      '"passed":true'
    );
    await expect(run(value.root, ['lint'])).rejects.toThrow('found 1 error(s)');
  });

  it('scopes reported findings to the named paths', async () => {
    const value = await fixture();
    await writeAt(value.root, 'src/browser/bad.js', 'export const unlicensed = 1;\n');
    expect(await run(value.root, ['lint', 'browser/new.js'])).toContain('0 error(s)');
    await expect(run(value.root, ['lint', 'browser/bad.js'])).rejects.toThrow('found 1 error(s)');
  });

  it('runs verify and typecheck the same way, and says it is not sealed evidence', async () => {
    const value = await fixture();
    expect(await verifyAuthoredSource(value.root)).toEqual([]);
    expect(await run(value.root, ['verify'])).toContain('not sealed job evidence');
    expect(await run(value.root, ['typecheck'])).toContain('authored typecheck: 0 error(s)');
    const document = JSON.parse(await run(value.root, ['verify', '--json'])) as Record<
      string,
      unknown
    >;
    expect(document).toMatchObject({
      check: 'verify',
      verification: 'provisional-no-job',
      passed: true,
    });
  });

  it('names the project pass it does not run when a typecheck project holds a file in scope', async () => {
    const value = await fixture();
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stderr = (): string => spy.mock.calls.map(([chunk]) => String(chunk)).join('');
    await run(value.root, ['typecheck']);
    expect(stderr()).not.toContain('project pass');
    await writeAt(
      value.root,
      'fireforge.json',
      JSON.stringify({ ...value.config, typecheck: { projects: ['engine/browser/jsconfig.json'] } })
    );
    await writeAt(value.root, 'src/browser/jsconfig.json', '{ "include": ["new.js"] }\n');
    await writeAt(value.root, 'src/browser/other.js', LICENSED);
    await commitFixture(value.root);
    await run(value.root, ['typecheck', 'browser/other.js']);
    expect(stderr()).not.toContain('project pass');
    expect(await run(value.root, ['typecheck'])).toContain('authored typecheck: 0 error(s)');
    expect(stderr()).toContain(
      `not the project pass the gate's check runs over engine/browser/jsconfig.json`
    );
    expect(stderr()).toContain('fireforge job run --check');
  });

  it('builds its view only from captured objects, and shapes it like a slot', async () => {
    const value = await fixture();
    await writeAt(value.pristine, '.prettierrc.json', '{"semi":false}\n');
    await commitFixture(value.pristine);
    const commit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
    if (!value.config.sources) throw new Error('Fixture requires source mode');
    value.config.sources.pristineCommit = commit;
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    await commitFixture(value.root);
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: value.root,
      pristineRepository: value.pristine,
    });
    await writeAt(value.root, 'src/browser/new.js', 'export const later = true;\n');
    const context = await authoredGateContext(value.root, { snapshot });
    expect(context.engine).toBe(join(context.projectRoot, 'engine'));
    expect(await readFile(join(context.engine, 'browser/new.js'), 'utf8')).toBe(LICENSED);
    expect(await readFile(join(context.projectRoot, 'src/browser/new.js'), 'utf8')).toBe(LICENSED);
    expect(await readFile(join(context.engine, '.prettierrc.json'), 'utf8')).toContain('semi');
    await expect(lstat(join(context.engine, 'browser/manifest.txt'))).rejects.toThrow();
    const again = await authoredGateContext(value.root, { snapshot });
    expect(again.projectRoot).toBe(context.projectRoot);
  });

  it('prunes retained snapshots from the CLI, keeping one an unfinished job names', async () => {
    const value = await fixture();
    const namespace = join(dirname(value.root), 'namespace');
    vi.stubEnv('FIREFORGE_COORDINATOR', namespace);
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      await writeAt(value.root, 'src/browser/new.js', `${LICENSED}// ${index}\n`);
      const handle = join(value.root, `.fireforge/${index}.json`);
      const [id = ''] = (await run(value.root, ['capture', '--out', handle])).split(' ');
      ids.push(id);
      await new Promise((accept) => setTimeout(accept, 20));
    }
    await writeAt(
      namespace,
      'journal.jsonl',
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'job',
        owner: 'agent',
        state: 'queued',
        request: { sourceId: ids[0] },
      })}\n`
    );
    const result = JSON.parse(await run(value.root, ['prune', '--keep', '1', '--json'])) as {
      removed: string[];
    };
    expect(result.removed).toEqual([ids[1]]);
    await expect(run(value.root, ['prune', '--keep', '-1'])).rejects.toThrow(
      '--keep must be a non-negative whole number'
    );
  });

  it('keeps only a few views', async () => {
    const value = await fixture();
    for (let index = 0; index < 7; index++) {
      await writeAt(value.root, 'src/browser/new.js', `${LICENSED}// ${index}\n`);
      await authoredGateContext(value.root);
    }
    const names = await readdir(join(value.root, '.fireforge/feedback'));
    expect(names.length).toBeLessThanOrEqual(4);
    expect(names.every((name) => /^[a-f0-9]{64}$/.test(name))).toBe(true);
  });
});
