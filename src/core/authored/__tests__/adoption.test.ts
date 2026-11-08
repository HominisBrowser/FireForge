// SPDX-License-Identifier: EUPL-1.2
/**
 * What a real migration runs into first: upstream overrides under strict typing,
 * ADR file lists carried from legacy patches, real `node_modules` links, a donor
 * that must reproduce on another host, and a queue that replays byte-exactly.
 */
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { importCommand } from '../../../commands/import.js';
import { lintCommand } from '../../../commands/lint.js';
import { setupCommand } from '../../../commands/setup.js';
import { typecheckCommand } from '../../../commands/typecheck.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../../test-utils/firefox-workflow-fixtures.js';
import { initCommittedRepo, setInteractiveMode } from '../../../test-utils/index.js';
import { writeRealShapedNodeModules } from '../../../test-utils/real-node-modules.js';
import type { FireForgeConfig } from '../../../types/config.js';
import { notice } from '../../../utils/logger.js';
import {
  authoredGateContext,
  checkAuthoredTypes,
  verifyAuthoredSource,
} from '../../authored-gates.js';
import { downloadFirefoxSource } from '../../firefox.js';
import { loadPerPatchLintCache } from '../../patch-lint-cache.js';
import { evaluateAuthoredUpstreamPolicy } from '../../patch-policy-content.js';
import { captureAuthoredSnapshot } from '../capture.js';
import { resolveStaticDonor } from '../donor.js';
import { exportAuthoredQueue } from '../export-queue.js';
import { sourceGit } from '../git.js';
import { migrateLegacyQueue } from '../migrate.js';
import { fetchPristineDonor } from '../pristine.js';
import type { UpstreamDelta } from '../types.js';
import { declareAuthoredOverride } from '../writer.js';
import { commitFixture, readCaptured, sourceFixture, writeAt } from './fixtures.js';

vi.mock('../../firefox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../firefox.js')>()),
  downloadFirefoxSource: vi.fn(),
}));
vi.mock('../../../utils/logger.js', async () =>
  (await import('../../../test-utils/module-mocks.js')).createLoggerMock()
);

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  return value;
}

describe('strict typing in source mode', () => {
  it('leaves an untyped upstream override alone and still fires on a created file', async () => {
    const value = await fixture();
    const upstream = 'browser/modules/Upstream.sys.mjs';
    await writeAt(
      value.pristine,
      upstream,
      '/** @type {number} */\nexport const fromUpstream = "not a number";\n'
    );
    await commitFixture(value.pristine);
    const commit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString().trim();
    const config: FireForgeConfig = {
      ...value.config,
      patchLint: { checkJs: true },
      sources: {
        ...(value.config.sources as NonNullable<FireForgeConfig['sources']>),
        pristineCommit: commit,
      },
    };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(config));
    await commitFixture(value.root);
    await declareAuthoredOverride(value.root, upstream, {
      component: 'infra-registration',
      classification: 'registration',
      pristineRepository: value.pristine,
    });
    await writeAt(
      value.root,
      `src/${upstream}`,
      '/** @type {number} */\nexport const fromUpstream = "still not a number";\n'
    );
    await writeAt(
      value.root,
      'src/browser/modules/Ours.sys.mjs',
      '/** @type {number} */\nexport const ours = "not a number either";\n'
    );
    await commitFixture(value.root);
    const context = await authoredGateContext(value.root, { pristineRepository: value.pristine });
    const issues = await checkAuthoredTypes(context);
    const files = issues.map((issue) => issue.file);
    expect(files.some((file) => file.includes('Ours.sys.mjs'))).toBe(true);
    expect(files.some((file) => file.includes('Upstream.sys.mjs'))).toBe(false);
  });
});

describe('static feedback on a real node_modules', () => {
  it('reaches a result through the view, whose node_modules links to the checkout', async () => {
    const value = await fixture();
    await writeRealShapedNodeModules(value.root);
    await expect(
      verifyAuthoredSource(value.root, { pristineRepository: value.pristine })
    ).resolves.toBeInstanceOf(Array);
    const context = await authoredGateContext(value.root, { pristineRepository: value.pristine });
    const config = {
      ...context.snapshot,
      config: { ...context.snapshot.config, patchLint: { checkJs: true } },
    };
    await expect(checkAuthoredTypes({ ...context, snapshot: config })).resolves.toBeInstanceOf(
      Array
    );
  });
});

describe('an exception ADR file list', () => {
  const delta = (path: string): UpstreamDelta =>
    ({
      path,
      diff: '',
      declaration: {
        component: 'ui-sidebar',
        classification: 'exception',
        adr: 'ADR-1',
        kind: 'override',
      },
    }) as UpstreamDelta;
  const config = (files: string[]): FireForgeConfig =>
    ({
      patchPolicy: {
        reservedRanges: [{ allowed: [{ filename: 'ui-sidebar', adr: 'ADR-1', files }] }],
      },
    }) as unknown as FireForgeConfig;
  const judge = (
    files: string[],
    deltas: UpstreamDelta[],
    created: string[]
  ): Promise<readonly { code: string }[]> =>
    evaluateAuthoredUpstreamPolicy(config(files), '/nonexistent', deltas, new Set(created));

  it('accepts a list that mixes the upstream paths with files the component created', async () => {
    await expect(judge(['a.js', 'made.js'], [delta('a.js')], ['made.js'])).resolves.toEqual([]);
  });

  it('refuses an upstream change the list does not name', async () => {
    const issues = await judge(['a.js'], [delta('a.js'), delta('b.js')], []);
    expect(issues.map((issue) => issue.code)).toContain('upstream-allowlist');
  });

  it('refuses a listed path that is neither changed nor created', async () => {
    const issues = await judge(['a.js', 'gone.js'], [delta('a.js')], ['made.js']);
    expect(issues.map((issue) => issue.code)).toContain('upstream-allowlist');
  });
});

describe('a pristine donor from the archive', () => {
  const archive = (extra?: (dest: string) => Promise<void>): void => {
    vi.mocked(downloadFirefoxSource).mockImplementation(async ({ destDir }) => {
      await writeAt(destDir, 'browser/manifest.txt', 'first\nsecond\nthird\nfourth\nfifth\n');
      await writeAt(destDir, '.gitignore', 'hidden.txt\nignored-dir/\n');
      await writeAt(destDir, 'third_party/hidden.txt', 'upstream ships this\n');
      await writeAt(destDir, 'ignored-dir/also.txt', 'and this\n');
      await extra?.(destDir);
    });
  };

  it('holds what the archive holds, including what its own .gitignore hides', async () => {
    const value = await fixture();
    archive();
    const donor = await fetchPristineDonor({
      projectRoot: value.root,
      destination: join(dirname(value.root), 'donor'),
      pin: { firefox: value.config.firefox },
    });
    const tree = (await sourceGit(donor.repository, ['ls-tree', '-r', '--name-only', donor.commit]))
      .toString()
      .split('\n');
    expect(tree).toEqual(
      expect.arrayContaining(['third_party/hidden.txt', 'ignored-dir/also.txt'])
    );
  });

  it('keeps a legacy repository from indexing what its .gitignore hides', async () => {
    const value = await fixture();
    const dir = join(dirname(value.root), 'legacy-engine');
    await mkdir(dir);
    await writeAt(dir, '.gitignore', 'hidden.txt\n');
    await writeAt(dir, 'hidden.txt', 'stays out\n');
    await writeAt(dir, 'kept.txt', 'stays in\n');
    const { initRepository } = await import('../../git.js');
    await initRepository(dir);
    const tree = (await sourceGit(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])).toString();
    expect(tree).toContain('kept.txt');
    expect(tree).not.toContain('hidden.txt\n');
  });

  it('round-trips: migrate pins the archive commit, and a clean host reproduces it', async () => {
    const value = await fixture();
    archive();
    // A donor fetched by naming the candidate is still this checksum's archive.
    const legacy = { ...value.config };
    delete legacy.sources;
    await writeAt(value.root, 'fireforge.json', JSON.stringify(legacy));
    await writeAt(
      value.root,
      '.fireforge/state.json',
      JSON.stringify({ baseCommit: value.commit })
    );
    await writeAt(value.root, 'patches/patches.json', JSON.stringify({ version: 1, patches: [] }));
    await commitFixture(value.root);
    // A project still on a queue can make the donor it will migrate against.
    const donor = await fetchPristineDonor({
      projectRoot: value.root,
      destination: join(dirname(value.root), 'first-host-donor'),
    });
    const migrated = await migrateLegacyQueue({
      projectRoot: value.root,
      destination: join(dirname(value.root), 'overlay'),
      pristineRepository: donor.repository,
    });
    expect(migrated).toMatchObject({
      pinSource: 'archive-donor',
      pinReproducible: true,
      sources: { pristineCommit: donor.commit },
    });
    await writeAt(
      value.root,
      'fireforge.json',
      JSON.stringify({ ...legacy, sources: migrated.sources, test: { reapOrphans: 'owned' } })
    );
    const clean = await fetchPristineDonor({
      projectRoot: value.root,
      destination: join(dirname(value.root), 'clean-host-donor'),
    });
    expect(clean.commit).toBe(donor.commit);
  });

  it('says when a recorded-base pin only this engine can reproduce', async () => {
    const value = await fixture();
    const legacy = { ...value.config };
    delete legacy.sources;
    await writeAt(value.root, 'fireforge.json', JSON.stringify(legacy));
    await writeAt(
      value.root,
      '.fireforge/state.json',
      JSON.stringify({ baseCommit: value.commit })
    );
    await writeAt(value.root, 'patches/patches.json', JSON.stringify({ version: 1, patches: [] }));
    await expect(
      migrateLegacyQueue({
        projectRoot: value.root,
        destination: join(dirname(value.root), 'overlay'),
        pristineRepository: value.pristine,
      })
    ).resolves.toMatchObject({ pinSource: 'recorded-base', pinReproducible: false });
  });
});

describe('the static donor', () => {
  it('finds the template this host keeps for the pin when engine/ is gone', async () => {
    const value = await fixture();
    const namespace = await mkdtemp(join(tmpdir(), 'fireforge-namespace-'));
    directories.push(namespace);
    const directory = join(namespace, 'templates', value.commit);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'template.json'), JSON.stringify({ sourceBytes: 1 }));
    vi.stubEnv('FIREFORGE_COORDINATOR', namespace);
    vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', undefined);
    try {
      await expect(resolveStaticDonor(value.root)).resolves.toBe(join(directory, 'engine.git'));
      await expect(resolveStaticDonor(value.root, value.pristine)).resolves.toBe(value.pristine);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('export-queue', () => {
  it('writes a queue that fireforge import replays byte-exactly', async () => {
    const value = await fixture();
    const restoreTTY = setInteractiveMode(false);
    try {
      // Pristine: an override target, a file to delete, a binary and an executable.
      await writeAt(value.pristine, 'browser/deleted.txt', 'going away\n');
      await writeAt(value.pristine, 'browser/run.sh', '#!/bin/sh\nexit 0\n', true);
      await writeAt(value.pristine, 'browser/blob.dat', Buffer.from([0, 1, 2, 3]));
      await commitFixture(value.pristine);
      const commit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString().trim();
      const sources = {
        ...(value.config.sources as NonNullable<FireForgeConfig['sources']>),
        pristineCommit: commit,
      };
      await writeAt(value.root, 'fireforge.json', JSON.stringify({ ...value.config, sources }));
      await commitFixture(value.root);

      for (const [path, component] of [
        ['browser/manifest.txt', '012-ui-sidebar.patch'],
        ['browser/blob.dat', 'infra-registration'],
        ['browser/run.sh', 'infra-registration'],
      ] as const) {
        await declareAuthoredOverride(value.root, path, {
          component,
          classification: 'registration',
          pristineRepository: value.pristine,
        });
      }
      await writeAt(value.root, 'src/browser/manifest.txt', 'first\nlocal\nthird\nfourth\nfifth\n');
      await writeAt(value.root, 'src/browser/blob.dat', Buffer.from([9, 0, 255]));
      await writeAt(value.root, 'src/browser/run.sh', '#!/bin/sh\nexit 1\n', true);
      await writeAt(value.root, 'src/browser/crlf.txt', Buffer.from('a\r\nb\r\n'));
      await declareAuthoredOverride(value.root, 'browser/deleted.txt', {
        component: 'infra-registration',
        classification: 'registration',
        delete: true,
        pristineRepository: value.pristine,
      });
      await commitFixture(value.root);
      const snapshot = await captureAuthoredSnapshot({
        projectRoot: value.root,
        pristineRepository: value.pristine,
      });

      const out = join(dirname(value.root), 'public-patches');
      const first = await exportAuthoredQueue({
        snapshot,
        destination: out,
        pristineRepository: value.pristine,
      });
      expect(first.patches).toBe(3);
      const manifestBytes = await readFile(join(out, 'patches.json'));
      const again = join(dirname(value.root), 'public-patches-2');
      await exportAuthoredQueue({
        snapshot,
        destination: again,
        pristineRepository: value.pristine,
      });
      expect(await readFile(join(again, 'patches.json'))).toEqual(manifestBytes);

      // A legacy project at the same pin imports it.
      const consumer = join(dirname(value.root), 'consumer');
      await mkdir(consumer);
      await setupCommand(consumer, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
      const engine = join(consumer, 'engine');
      await initCommittedRepo(engine, {
        'browser/manifest.txt': 'first\nsecond\nthird\nfourth\nfifth\n',
        'browser/deleted.txt': 'going away\n',
      });
      await writeAt(engine, 'browser/run.sh', '#!/bin/sh\nexit 0\n', true);
      await writeAt(engine, 'browser/blob.dat', Buffer.from([0, 1, 2, 3]));
      execFileSync('git', ['add', '-A'], { cwd: engine });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base'], {
        cwd: engine,
      });
      const patches = join(consumer, 'patches');
      await rm(patches, { recursive: true, force: true });
      const { cp } = await import('node:fs/promises');
      await cp(out, patches, { recursive: true });
      await importCommand(consumer, { force: true });

      for (const file of snapshot.files) {
        const live = await readFile(join(engine, file.path)).catch(() => undefined);
        const captured = await readCaptured(snapshot, file.path);
        expect(live?.toString('hex'), file.path).toBe(captured?.toString('hex'));
        if (captured !== undefined) {
          const executable = ((await lstat(join(engine, file.path))).mode & 0o111) !== 0;
          expect(executable, file.path).toBe(file.mode === '100755');
        }
      }
    } finally {
      restoreTTY();
    }
  });

  it('groups created files by named group and directory, and one edit changes one patch', async () => {
    const value = await fixture();
    const restoreTTY = setInteractiveMode(false);
    try {
      const config = {
        ...value.config,
        exportQueue: {
          groups: [{ name: 'ui-tiles', paths: ['browser/tiles/**'] }],
          maxGroupBytes: 600,
        },
      };
      await writeAt(value.root, 'fireforge.json', JSON.stringify(config));
      await commitFixture(value.root);
      await declareAuthoredOverride(value.root, 'browser/manifest.txt', {
        component: '012-ui-sidebar.patch',
        classification: 'registration',
        pristineRepository: value.pristine,
      });
      const module = (name: string, tag: string): string =>
        `/** ${name} */\nexport const ${name} = ${JSON.stringify(tag.repeat(200))};\n`;
      await writeAt(value.root, 'src/browser/manifest.txt', 'first\nlocal\nthird\nfourth\nfifth\n');
      await writeAt(value.root, 'src/browser/tiles/a.js', 'export const a = 1;\n');
      await writeAt(value.root, 'src/browser/tiles/deep/b.js', 'export const b = 1;\n');
      await writeAt(value.root, 'src/browser/modules/One.sys.mjs', module('one', 'x'));
      await writeAt(value.root, 'src/browser/modules/Two.sys.mjs', module('two', 'y'));
      await writeAt(value.root, 'src/browser/modules/test/test_one.js', 'add_task(() => {});\n');
      await writeAt(value.root, 'src/toolkit/widgets/w.mjs', 'export class W {}\n');
      await commitFixture(value.root);

      const exportAt = async (name: string): Promise<{ dir: string; id: string }> => {
        const snapshot = await captureAuthoredSnapshot({
          projectRoot: value.root,
          pristineRepository: value.pristine,
        });
        const dir = join(dirname(value.root), name);
        await exportAuthoredQueue({
          snapshot,
          destination: dir,
          pristineRepository: value.pristine,
        });
        return { dir, id: snapshot.id };
      };
      const listing = async (dir: string): Promise<Map<string, string>> => {
        const { readdir } = await import('node:fs/promises');
        const names = (await readdir(dir)).filter((name) => name.endsWith('.patch')).sort();
        return new Map(
          await Promise.all(
            names.map(async (name) => [name, await readFile(join(dir, name), 'utf8')] as const)
          )
        );
      };

      const first = await exportAt('queue-1');
      const firstPatches = await listing(first.dir);
      expect([...firstPatches.keys()]).toEqual([
        '001-ui-sidebar.patch',
        '002-created-browser-modules-test.patch',
        '002-created-browser-modules.patch',
        '002-created-browser.patch',
        '002-created-toolkit.patch',
        '002-ui-tiles.patch',
      ]);
      const manifest = JSON.parse(await readFile(join(first.dir, 'patches.json'), 'utf8')) as {
        source: { snapshot: string };
        patches: { filename: string; description: string; filesAffected: string[] }[];
      };
      expect(Object.keys(manifest)).toEqual(['version', 'source', 'patches']);
      expect(manifest.source).toEqual({ snapshot: first.id });
      expect(manifest.patches.some((row) => row.description.includes(first.id))).toBe(false);
      expect(manifest.patches.map((row) => [row.filename, row.filesAffected])).toContainEqual([
        '002-ui-tiles.patch',
        ['browser/tiles/a.js', 'browser/tiles/deep/b.js'],
      ]);

      // An edit to one file changes that file's patch and the snapshot id, nothing else.
      await writeAt(value.root, 'src/browser/modules/One.sys.mjs', module('one', 'z'));
      await commitFixture(value.root);
      const second = await exportAt('queue-2');
      const secondPatches = await listing(second.dir);
      expect([...secondPatches.keys()]).toEqual([...firstPatches.keys()]);
      expect(
        [...secondPatches].filter(([name, body]) => firstPatches.get(name) !== body).map(([n]) => n)
      ).toEqual(['002-created-browser-modules.patch']);
      expect(
        (await readFile(join(second.dir, 'patches.json'), 'utf8')).replace(second.id, first.id)
      ).toBe(await readFile(join(first.dir, 'patches.json'), 'utf8'));

      // A new directory adds one patch and renames nothing.
      await writeAt(value.root, 'src/browser/extra/x.js', 'export const x = 1;\n');
      await commitFixture(value.root);
      const third = await exportAt('queue-3');
      const thirdPatches = await listing(third.dir);
      expect([...thirdPatches.keys()].filter((name) => !secondPatches.has(name))).toEqual([
        '002-created-browser-extra.patch',
      ]);
      for (const [name, body] of secondPatches) expect(thirdPatches.get(name), name).toBe(body);

      // A legacy project at the same pin imports it byte for byte.
      const consumer = join(dirname(value.root), 'consumer');
      await mkdir(consumer);
      await setupCommand(consumer, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
      const engine = join(consumer, 'engine');
      await initCommittedRepo(engine, {
        'browser/manifest.txt': 'first\nsecond\nthird\nfourth\nfifth\n',
      });
      const patches = join(consumer, 'patches');
      await rm(patches, { recursive: true, force: true });
      const { cp } = await import('node:fs/promises');
      await cp(third.dir, patches, { recursive: true });
      await importCommand(consumer, { force: true });
      const snapshot = await captureAuthoredSnapshot({
        projectRoot: value.root,
        pristineRepository: value.pristine,
      });
      for (const file of snapshot.files) {
        const live = await readFile(join(engine, file.path)).catch(() => undefined);
        const captured = await readCaptured(snapshot, file.path);
        expect(live?.toString('hex'), file.path).toBe(captured?.toString('hex'));
      }
    } finally {
      restoreTTY();
    }
  });

  it('refuses a destination that is not empty', async () => {
    const value = await fixture();
    await writeAt(value.root, 'src/browser/more.js', 'export const more = 1;\n');
    await commitFixture(value.root);
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: value.root,
      pristineRepository: value.pristine,
    });
    const out = join(dirname(value.root), 'occupied');
    await writeAt(out, 'keep.txt', 'mine\n');
    await expect(
      exportAuthoredQueue({ snapshot, destination: out, pristineRepository: value.pristine })
    ).rejects.toThrow('authored-export-queue-destination-not-empty');
  });
});

describe('lint on a real-shaped node_modules', () => {
  it('per-patch lint reaches a result with the cache on', async () => {
    const restoreTTY = setInteractiveMode(false);
    const project = await mkdtemp(join(tmpdir(), 'fireforge-real-modules-'));
    directories.push(project);
    try {
      await setupCommand(project, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
      await initCommittedRepo(join(project, 'engine'), { 'browser/a.js': 'one\n' });
      await writeFile(join(project, 'engine', 'browser', 'a.js'), 'two\n');
      await writeRealShapedNodeModules(project);
      await writeRealShapedNodeModules(join(project, 'engine'));
      await writeAt(
        join(project, 'patches'),
        '001-infra-one.patch',
        'diff --git a/browser/a.js b/browser/a.js\n--- a/browser/a.js\n+++ b/browser/a.js\n@@ -1 +1 @@\n-one\n+two\n'
      );
      await writeAt(
        join(project, 'patches'),
        'patches.json',
        JSON.stringify({
          version: 1,
          patches: [
            {
              filename: '001-infra-one.patch',
              order: 1,
              category: 'infra',
              name: 'one',
              description: 'd',
              createdAt: '2000-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.0.0esr',
              filesAffected: ['browser/a.js'],
            },
          ],
        })
      );
      // A patch was linted, so its cache key was built over these trees.
      await expect(lintCommand(project, [], { perPatch: true })).resolves.toBeUndefined();
      const cache = await loadPerPatchLintCache(project);
      expect(Object.keys(cache.entries)).toHaveLength(1);
    } finally {
      restoreTTY();
    }
  });
});

describe('top-level typecheck in an editing checkout', () => {
  it('judges a private view, leaves engine-bound projects to a job, and says so', async () => {
    const value = await fixture();
    const restoreTTY = setInteractiveMode(false);
    try {
      const config = {
        ...value.config,
        patchLint: { checkJs: true },
        typecheck: { projects: ['engine/browser/jsconfig.json'] },
      };
      await writeAt(value.root, 'fireforge.json', JSON.stringify(config));
      await writeAt(
        value.root,
        'src/browser/modules/Ours.sys.mjs',
        '/** @type {number} */\nexport const ours = "not a number";\n'
      );
      await commitFixture(value.root);
      vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
      await expect(typecheckCommand(value.root, {})).rejects.toThrow('Typecheck found 1 error');
      expect(notice).toHaveBeenCalledWith(expect.stringContaining('fireforge job run --check'));
      await writeAt(value.root, 'src/browser/modules/Ours.sys.mjs', 'export const ours = 1;\n');
      await commitFixture(value.root);
      await expect(typecheckCommand(value.root, {})).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      restoreTTY();
    }
  });

  it('runs a project named with --project on the view, with its generated jsconfig', async () => {
    const value = await fixture();
    const restoreTTY = setInteractiveMode(false);
    try {
      await writeAt(
        value.root,
        'furnace.json',
        JSON.stringify({
          version: 1,
          componentPrefix: 'moz-',
          stock: [],
          overrides: {},
          custom: {},
          typecheckJsconfig: 'tools/jsconfig.json',
        })
      );
      await writeAt(
        value.root,
        'tools/jsconfig.json',
        JSON.stringify({
          compilerOptions: { checkJs: true, allowJs: true, noEmit: true, strict: false },
          files: ['checked.js'],
        })
      );
      await writeAt(
        value.root,
        'tools/checked.js',
        '/** @type {number} */\nexport const n = "x";\n'
      );
      await commitFixture(value.root);
      vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
      await expect(
        typecheckCommand(value.root, { project: 'tools/jsconfig.json' })
      ).rejects.toThrow('Typecheck found 1 error');
    } finally {
      vi.unstubAllEnvs();
      restoreTTY();
    }
  });
});
