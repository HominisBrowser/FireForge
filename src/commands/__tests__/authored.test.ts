// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commitFixture, sourceFixture, writeAt } from '../../core/authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../core/authored/capture.js';
import { generateAuthoredDelta } from '../../core/authored/generate.js';
import { sourceGit } from '../../core/authored/git.js';
import { exportPristineTree } from '../../core/authored/materialize.js';
import { authenticateAuthoredSnapshot } from '../../core/authored/provider.js';
import { setMachineOutputMode } from '../../utils/logger.js';
import { registerAuthored } from '../authored.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setMachineOutputMode(false);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
  return value;
}

/** The results these tests parse as documents; every other command is read as text. */
const DOCUMENT_COMMANDS = new Set(['status', 'override', 'materialize', 'migrate', 'refresh']);

async function run(root: string, args: string[]): Promise<string> {
  const output: string[] = [];
  const argv = process.argv;
  const full = DOCUMENT_COMMANDS.has(args[0] ?? '') ? [...args, '--json'] : args;
  process.argv = ['node', 'fireforge', 'authored', ...full];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  try {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerAuthored(program, {
      getProjectRoot: () => root,
      withErrorHandling: (handler) => handler,
    });
    await program.parseAsync(['authored', ...full], { from: 'user' });
    return output.join('');
  } finally {
    stdout.mockRestore();
    process.argv = argv;
  }
}

describe('authored source command contracts', () => {
  it('captures repeated intended inputs, validates their handle and exports frozen bytes after editor saves', async () => {
    const value = await fixture();
    await writeAt(value.root, 'docs/intended.md', 'Captured dirty root input.\n');
    const head = await sourceGit(value.root, ['rev-parse', 'HEAD']);
    const index = await readFile(join(value.root, '.git/index'));
    const handle = join(value.root, '.fireforge/snapshots/current.json');
    const output = await run(value.root, [
      'capture',
      '--path',
      'src',
      '--path',
      'docs/intended.md',
      '--out',
      handle,
      '--pristine-repository',
      value.pristine,
    ]);
    const snapshot = await authenticateAuthoredSnapshot(
      JSON.parse(await readFile(handle, 'utf8')) as unknown,
      value.pristine
    );
    expect(output).toBe(`${snapshot.id} ${snapshot.tree}\n`);
    expect(snapshot.inputs.some((entry) => entry.path === 'docs/intended.md')).toBe(true);
    expect(await run(value.root, ['validate', '--snapshot', handle])).toBe(`${snapshot.id}\n`);
    expect(
      await run(value.root, [
        'validate',
        '--snapshot',
        handle,
        '--pristine-repository',
        value.pristine,
      ])
    ).toBe(`${snapshot.id}\n`);
    await writeAt(value.root, 'src/browser/new.js', 'export const value = 900;\n');
    const delta = await run(value.root, ['delta', '--snapshot', handle]);
    expect(delta).toContain('+export const value = 1;');
    expect(delta).not.toContain('900');
    expect(JSON.parse(await run(value.root, ['status']))).toMatchObject({
      files: { created: 1, override: 0, delete: 0, generated: 0 },
    });
    expect(await sourceGit(value.root, ['rev-parse', 'HEAD'])).toEqual(head);
    expect(await readFile(join(value.root, '.git/index'))).toEqual(index);
  });

  it('declares an override, materializes its immutable bytes and restores upstream with the default ledger', async () => {
    const value = await fixture();
    const path = 'browser/manifest.txt';
    await expect(
      run(value.root, [
        'override',
        path,
        '--component',
        'fixture',
        '--classification',
        'unapproved',
      ])
    ).rejects.toThrow('authored-invalid-classification');
    await expect(
      run(value.root, ['override', path, '--component', 'fixture', '--classification', 'exception'])
    ).rejects.toThrow('adr-required');
    expect(
      JSON.parse(
        await run(value.root, [
          'override',
          path,
          '--component',
          'fixture',
          '--classification',
          'registration',
          '--pristine-repository',
          value.pristine,
        ])
      )
    ).toMatchObject({ path, classification: 'registration', kind: 'override' });
    await writeAt(value.root, `src/${path}`, 'first\nlocal registration\nthird\nfourth\nfifth\n');
    expect(
      JSON.parse(await run(value.root, ['status', '--pristine-repository', value.pristine]))
    ).toMatchObject({ files: { override: 1 } });
    const handle = join(value.root, '.fireforge/snapshots/override.json');
    await run(value.root, ['capture', '--path', 'src', '--out', handle]);
    const diff = await run(value.root, [
      'delta',
      '--snapshot',
      handle,
      '--upstream',
      '--pristine-repository',
      value.pristine,
    ]);
    expect(diff).toContain('+local registration');
    expect(diff).not.toContain('browser/new.js');
    const engine = join(dirname(value.root), 'isolated-runtime');
    await exportPristineTree(value.pristine, value.commit, engine);
    const ledger = `${engine}.authored-materialization.json`;
    expect(
      JSON.parse(
        await run(value.root, [
          'materialize',
          '--snapshot',
          handle,
          '--engine',
          engine,
          '--ledger',
          ledger,
          '--pristine-repository',
          value.pristine,
        ])
      )
    ).toHaveProperty('changed');
    expect(await readFile(join(engine, path), 'utf8')).toContain('local registration');
    await expect(run(value.root, ['restore-upstream', path])).rejects.toThrow(
      'authored-postimage-uncommitted'
    );
    await run(value.root, ['restore-upstream', path, '--discard']);
    await run(value.root, ['capture', '--path', 'src', '--out', handle]);
    expect(
      JSON.parse(await run(value.root, ['materialize', '--snapshot', handle, '--engine', engine]))
    ).toMatchObject({ restored: [path] });
    expect(await readFile(join(engine, path), 'utf8')).toBe(
      'first\nsecond\nthird\nfourth\nfifth\n'
    );
    await expect(readFile(join(value.root, 'engine', path))).rejects.toThrow();
  });

  it('distinguishes an explicit ADR-backed tombstone from removing that declaration', async () => {
    const value = await fixture();
    const path = 'browser/manifest.txt';
    await writeAt(value.root, 'docs/removal.md', 'Reviewed fixture removal.\n');
    const result = await run(value.root, [
      'override',
      path,
      '--component',
      'fixture-removal',
      '--classification',
      'exception',
      '--adr',
      'docs/removal.md',
      '--delete',
    ]);
    expect(JSON.parse(result)).toMatchObject({ kind: 'delete', adr: 'docs/removal.md' });
    await expect(run(value.root, ['status'])).rejects.toThrow('authored-adr-missing');
    await commitFixture(value.root);
    expect(JSON.parse(await run(value.root, ['status']))).toMatchObject({ files: { delete: 1 } });
    await expect(readFile(join(value.root, 'src', path))).rejects.toThrow();
    await run(value.root, ['restore-upstream', path]);
    expect(JSON.parse(await run(value.root, ['status']))).toMatchObject({ files: { delete: 0 } });
  });

  it('migrates actual recorded queue bytes into an external proposal without adopting it', async () => {
    const value = await fixture();
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: value.root,
      intendedPaths: ['src'],
      pristineRepository: value.pristine,
    });
    const body = await generateAuthoredDelta(snapshot, { pristineRepository: value.pristine });
    const legacy = { ...value.config };
    delete legacy.sources;
    await writeAt(value.root, 'fireforge.json', JSON.stringify(legacy));
    await writeAt(value.root, 'patches/001-infra-fixture.patch', body);
    await writeAt(
      value.root,
      'patches/patches.json',
      JSON.stringify({
        version: 1,
        patches: [
          {
            filename: '001-infra-fixture.patch',
            order: 1,
            category: 'infra',
            name: 'fixture',
            description: 'Recorded source fixture',
            createdAt: '2026-11-05T00:00:00.000Z',
            sourceEsrVersion: legacy.firefox.version,
            filesAffected: snapshot.files.map((file) => file.path),
          },
        ],
      })
    );
    const destination = join(dirname(value.root), 'migration');
    expect(
      JSON.parse(
        await run(value.root, [
          'migrate',
          '--out',
          destination,
          '--pristine-repository',
          value.pristine,
          '--pristine-commit',
          value.commit,
        ])
      )
    ).toMatchObject({ paths: 1, overrides: 0 });
    expect(await readFile(join(destination, 'src/browser/new.js'), 'utf8')).toBe(
      'export const value = 1;\n'
    );
    expect(
      JSON.parse(await readFile(join(value.root, 'fireforge.json'), 'utf8'))
    ).not.toHaveProperty('sources');
    expect(
      await run(value.root, ['migrate', '--out', join(dirname(value.root), 'default-migration')])
    ).toContain('"paths":1');
  });

  it('validates pin input and prepares an external proposal without adopting it', async () => {
    const value = await fixture();
    const handle = join(value.root, '.fireforge/old.json');
    await run(value.root, ['capture', '--path', 'src', '--out', handle]);
    const pinPath = join(dirname(value.root), 'new-pin.json');
    const destination = join(dirname(value.root), 'refresh');
    const args = [
      'refresh',
      '--snapshot',
      handle,
      '--new-pin',
      pinPath,
      '--new-pristine-repository',
      value.pristine,
      '--out',
      destination,
    ];
    for (const invalid of [
      null,
      { firefox: 'invalid', commit: value.commit },
      { firefox: value.config.firefox },
    ]) {
      await writeAt(dirname(pinPath), 'new-pin.json', JSON.stringify(invalid));
      await expect(run(value.root, args)).rejects.toThrow('authored-refresh-invalid-new-pin');
    }
    await writeAt(value.pristine, 'browser/new-pristine.txt', 'New upstream fixture.\n');
    await commitFixture(value.pristine);
    const commit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
    await writeAt(
      dirname(pinPath),
      'new-pin.json',
      JSON.stringify({ firefox: { ...value.config.firefox, version: '153.7.0esr' }, commit })
    );
    const proposal: unknown = JSON.parse(
      await run(value.root, [...args, '--pristine-repository', value.pristine])
    );
    expect(proposal).toMatchObject({ conflicts: 0, reviewRequired: true, newPin: { commit } });
    expect(JSON.parse(await readFile(join(destination, 'fireforge.json'), 'utf8'))).toMatchObject({
      sources: { pristineCommit: commit },
    });
    expect(JSON.parse(await readFile(join(value.root, 'fireforge.json'), 'utf8'))).toMatchObject({
      sources: { pristineCommit: value.commit },
    });
    await run(value.root, [...args.slice(0, -1), join(dirname(value.root), 'default-refresh')]);
  });

  it('refuses a tampered snapshot without changing the requested destination', async () => {
    const value = await fixture();
    const handle = join(value.root, '.fireforge/tampered.json');
    await run(value.root, ['capture', '--path', 'src', '--out', handle]);
    const snapshot = await authenticateAuthoredSnapshot(
      JSON.parse(await readFile(handle, 'utf8')) as unknown,
      value.pristine
    );
    await writeAt(
      value.root,
      '.fireforge/tampered.json',
      JSON.stringify({ ...snapshot, id: 'f'.repeat(64) })
    );
    await expect(run(value.root, ['validate', '--snapshot', handle])).rejects.toThrow(
      'snapshot-mismatch'
    );
    const destination = join(dirname(value.root), 'untouched');
    await expect(
      run(value.root, ['materialize', '--snapshot', handle, '--engine', destination])
    ).rejects.toThrow('snapshot-mismatch');
    await expect(readFile(join(destination, 'browser/new.js'))).rejects.toThrow();
  });
});
