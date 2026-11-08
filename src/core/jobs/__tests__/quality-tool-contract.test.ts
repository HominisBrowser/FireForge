// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../../test-utils/index.js';
import type { PatchMetadata } from '../../../types/commands/index.js';
import { loadedNodeToolIdentity, resolvedNodeToolIdentity } from '../../node-tool-identity.js';
import {
  buildPerPatchLintCacheKey,
  getCachedPerPatchLintIssues,
  LINT_CACHE_SCHEMA_VERSION,
  type PerPatchLintCacheFile,
  setCachedPerPatchLintIssues,
} from '../../patch-lint-cache.js';
import { resolvePatchLintPrettier } from '../../patch-lint-prettier.js';
import { boundPrettierConfiguration } from '../../prettier-bound-config.js';
import { readAdmittedSnapshot } from '../guard.js';
import { cacheQualityIdentity, qualityToolIdentity, qualityToolsOnce } from '../quality-tools.js';

const fixture = vi.hoisted(() => ({ packageRoot: '', consumer: '' }));
vi.mock('../../../utils/package-root.js', async (original) => ({
  ...(await original<typeof import('../../../utils/package-root.js')>()),
  getPackageRoot: () => fixture.packageRoot,
}));
vi.mock('../evidence.js', async (original) => ({
  ...(await original<typeof import('../evidence.js')>()),
  executorFingerprint: () => Promise.resolve('executor-fixture'),
}));
vi.mock('../git-tools.js', () => ({
  gitToolIdentity: () => Promise.resolve({ digest: 'git-fixture' }),
}));
vi.mock('../guard.js', async (original) => ({
  ...(await original<typeof import('../guard.js')>()),
  readAdmittedSnapshot: vi.fn(),
}));
vi.mock('../../node-tool-identity.js', async (original) => {
  const actual = await original<typeof import('../../node-tool-identity.js')>();
  return {
    ...actual,
    resolvedNodeToolIdentity: (name: string, from: string) =>
      actual.resolvedNodeToolIdentity(
        name,
        from.endsWith('/core/typecheck.js') ? fixture.consumer : from
      ),
  };
});

let directory: string;
let project: string;
let engine: string;
async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}
async function packageAt(root: string, name: string): Promise<string> {
  const path = join(root, 'node_modules', name);
  await put(
    join(path, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.js', bin: 'cli.cjs' })
  );
  await put(join(path, 'index.js'), 'module.exports = "same-version-A";\n');
  await put(join(path, 'cli.cjs'), 'process.stdout.write("formatter");\n');
  await put(join(path, 'assets', 'rules.json'), '{"rule":"A"}\n');
  return path;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ff-quality-contract-'));
  project = join(directory, 'project');
  engine = join(project, 'engine');
  fixture.packageRoot = join(directory, 'runner');
  fixture.consumer = join(fixture.packageRoot, 'src', 'typecheck.js');
  await mkdir(engine, { recursive: true });
  for (const name of ['typescript', 'eslint', 'prettier'])
    await packageAt(fixture.packageRoot, name);
  await packageAt(project, 'prettier');
  await put(join(project, 'node_modules', '.bin', 'prettier'), 'project-bin\n');
  vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('an installed tree', () => {
  /** Firefox's own tree holds packages whose manifest has no name. */
  it('identifies a package with no name by its path and bytes', async () => {
    const lib = join(project, 'node_modules', '@typescript', 'lib-dom');
    await put(join(lib, 'package.json'), '{"version":"1.0.0"}\n');
    await put(join(lib, 'index.d.ts'), 'export {};\n');
    const first = await qualityToolIdentity(project);
    await writeFile(join(lib, 'index.d.ts'), 'export const changed = 1;\n');
    expect(await qualityToolIdentity(project)).not.toBe(first);
    await expect(cacheQualityIdentity(project)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it('reads no bytes while its stat signature stands, and every byte when asked', async () => {
    const asset = join(project, 'node_modules', 'prettier', 'assets', 'rules.json');
    const stamp = new Date('2026-01-02T03:04:05Z');
    await utimes(asset, stamp, stamp);
    const first = await qualityToolIdentity(project);
    const recorded = await readFile(join(project, '.fireforge', 'quality-inventory.json'), 'utf8');
    expect(recorded).toContain(join(project, 'node_modules'));
    // Same size, same mtime: only a full read can tell. That is what a final gate is for.
    await writeFile(asset, '{"rule":"B"}\n');
    await utimes(asset, stamp, stamp);
    expect(await qualityToolIdentity(project)).toBe(first);
    const full = await qualityToolIdentity(project, undefined, { full: true });
    expect(full).not.toBe(first);
    // The full read records what it found, so the next signature check agrees with it.
    expect(await qualityToolIdentity(project)).toBe(full);
  });

  it('notices a changed file through its stat signature', async () => {
    const first = await qualityToolIdentity(project);
    await writeFile(
      join(project, 'node_modules', 'prettier', 'assets', 'rules.json'),
      '{"rule":"changed"}\n'
    );
    expect(await qualityToolIdentity(project)).not.toBe(first);
  });

  it('reads a declared dependency tree whose .bin links to a package beside it', async () => {
    const tree = join(project, 'tools', 'vendor', 'kit', 'node_modules');
    await put(join(tree, 'resolve', 'bin', 'resolve'), 'A\n');
    await mkdir(join(tree, '.bin'), { recursive: true });
    await symlink('../resolve/bin/resolve', join(tree, '.bin', 'resolve'));
    await put(
      join(project, 'fireforge.json'),
      JSON.stringify({
        slots: {
          dependencyCaches: [
            { source: 'tools/vendor/kit/node_modules', target: 'tools/vendor/kit/node_modules' },
          ],
        },
      })
    );
    const first = await qualityToolIdentity(project);
    await writeFile(join(tree, 'resolve', 'bin', 'resolve'), 'changed\n');
    expect(await qualityToolIdentity(project)).not.toBe(first);
  });

  it('notices a change behind a link, which a linked workspace package is', async () => {
    await put(join(engine, 'tools', 'lint', 'plugin', 'index.js'), 'A\n');
    await put(join(engine, 'node_modules', 'other', 'index.js'), 'A\n');
    await symlink('../tools/lint/plugin', join(engine, 'node_modules', 'eslint-plugin-mozilla'));
    const first = await qualityToolIdentity(project);
    await writeFile(join(engine, 'tools', 'lint', 'plugin', 'index.js'), 'changed\n');
    expect(await qualityToolIdentity(project)).not.toBe(first);
  });
});

describe('actual quality-tool byte identities', () => {
  it('walks from a nested runtime entry to its owning package and refuses unauthenticated metadata', async () => {
    const nested = await packageAt(fixture.packageRoot, 'nested-compiler');
    await writeFile(
      join(nested, 'package.json'),
      JSON.stringify({ name: 'nested-compiler', version: '1.0.0', main: 'dist/entry.js' })
    );
    await put(join(nested, 'dist/entry.js'), 'module.exports=true;');
    expect(await resolvedNodeToolIdentity('nested-compiler', fixture.consumer)).toMatch(
      /^[a-f0-9]{64}$/
    );
    const mismatch = await packageAt(fixture.packageRoot, 'mismatched-compiler');
    await writeFile(
      join(mismatch, 'package.json'),
      JSON.stringify({ name: 'unrelated-package', main: 'index.js' })
    );
    await expect(resolvedNodeToolIdentity('mismatched-compiler', fixture.consumer)).rejects.toThrow(
      'not authenticated'
    );
    const malformed = await packageAt(fixture.packageRoot, 'broken-compiler');
    await writeFile(join(malformed, 'package.json'), '{');
    await expect(resolvedNodeToolIdentity('broken-compiler', fixture.consumer)).rejects.toThrow();
  });

  it('measures source-only editor roots without inventing an engine or installed tools there', async () => {
    await rm(engine, { recursive: true });
    expect(await qualityToolIdentity(project)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps one loaded implementation per process while fresh phase measurements see changed bytes', async () => {
    const loaded = await loadedNodeToolIdentity('typescript', fixture.consumer);
    const qualified = await qualityToolsOnce(project);
    await writeFile(
      join(fixture.packageRoot, 'node_modules/typescript/index.js'),
      'module.exports="fresh-phase";'
    );
    expect(await loadedNodeToolIdentity('typescript', fixture.consumer)).toBe(loaded);
    expect(await resolvedNodeToolIdentity('typescript', fixture.consumer)).not.toBe(loaded);
    expect(await qualityToolsOnce(project)).toBe(qualified);
    expect(await cacheQualityIdentity(project)).toBe(qualified);
    expect(await qualityToolIdentity(project)).not.toBe(qualified);
  });

  it('resolves the compiler from the consumer and invalidates a same-version implementation edit', async () => {
    const metadata = join(fixture.packageRoot, 'node_modules/typescript/package.json');
    const manifest = await readFile(metadata, 'utf8');
    const before = await resolvedNodeToolIdentity('typescript', fixture.consumer);
    const qualified = await qualityToolIdentity(project);
    await writeFile(
      join(fixture.packageRoot, 'node_modules/typescript/index.js'),
      'module.exports = "same-version-B";\n'
    );
    expect(await readFile(metadata, 'utf8')).toBe(manifest);
    expect(await resolvedNodeToolIdentity('typescript', fixture.consumer)).not.toBe(before);
    expect(await qualityToolIdentity(project)).not.toBe(qualified);
    expect(await resolvedNodeToolIdentity('not-installed-fixture', fixture.consumer)).toBe(
      'absent'
    );
  });

  it('binds actual formatter resolution plus plugin assets without changing package versions', async () => {
    const projectFormatter = await resolvePatchLintPrettier(engine, project);
    expect(projectFormatter?.command).toBe(join(project, 'node_modules/.bin/prettier'));
    const before = await qualityToolIdentity(project);
    await packageAt(engine, 'prettier');
    await put(join(engine, 'node_modules/.bin/prettier'), 'engine-bin\n');
    expect((await resolvePatchLintPrettier(engine, project))?.command).toBe(
      join(engine, 'node_modules/.bin/prettier')
    );
    const engineIdentity = await qualityToolIdentity(project);
    expect(engineIdentity).not.toBe(before);
    await writeFile(join(engine, 'node_modules/prettier/assets/rules.json'), '{"rule":"B"}\n');
    expect(await qualityToolIdentity(project)).not.toBe(engineIdentity);
  });

  it('invalidates qualified formatting identity when captured config or ignore bytes change', async () => {
    await put(join(project, '.prettierrc'), '{"printWidth":80}');
    await put(join(engine, '.prettierignore'), 'generated/\n');
    const before = await qualityToolIdentity(project);
    await writeFile(join(project, '.prettierrc'), '{"printWidth":81}');
    const configChanged = await qualityToolIdentity(project);
    expect(configChanged).not.toBe(before);
    await writeFile(join(engine, '.prettierignore'), 'generated/\nother/\n');
    expect(await qualityToolIdentity(project)).not.toBe(configChanged);
  });

  it('misses a previously green lint cache when the admitted tool digest changes', async () => {
    const first = await qualityToolIdentity(project);
    await writeFile(
      join(project, 'node_modules/prettier/index.js'),
      'module.exports = "changed";\n'
    );
    const second = await qualityToolIdentity(project);
    expect(second).not.toBe(first);
    vi.stubEnv('FIREFORGE_JOB_TOKEN', 'live-fixture');
    const patch: PatchMetadata = {
      filename: '001-ui-a.patch',
      order: 1,
      category: 'ui',
      name: 'a',
      description: 'a',
      createdAt: '2026-01-01T00:00:00Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['a.js'],
    };
    await put(join(project, 'patches', patch.filename), 'diff fixture\n');
    await put(join(engine, 'a.js'), 'const a = 1;\n');
    const key = async (qualityToolsDigest: string): Promise<string> => {
      vi.mocked(readAdmittedSnapshot).mockResolvedValue({ qualityToolsDigest } as never);
      return buildPerPatchLintCacheKey({
        projectRoot: project,
        engineDir: engine,
        patchesDir: join(project, 'patches'),
        patch,
        existingFiles: ['a.js'],
        config: DEFAULT_CONFIG,
        queueContext: { entries: [] },
        engineHeadSha: 'fixed',
        packageVersion: '1.0.0',
      });
    };
    const a = await key(first),
      b = await key(second);
    expect(a).not.toBe(b);
    const cache: PerPatchLintCacheFile = { schemaVersion: LINT_CACHE_SCHEMA_VERSION, entries: {} };
    setCachedPerPatchLintIssues({
      cache,
      patchFilename: patch.filename,
      key: a,
      issues: [],
      suppressed: [],
      lineCount: 1,
    });
    expect(getCachedPerPatchLintIssues(cache, patch.filename, a)).toBeDefined();
    expect(getCachedPerPatchLintIssues(cache, patch.filename, b)).toBeUndefined();
    vi.mocked(readAdmittedSnapshot).mockResolvedValue({} as never);
    await expect(cacheQualityIdentity(project)).rejects.toThrow(
      'no qualified quality-tool identity'
    );
  });
});

describe('bounded formatter configuration and ancestry', () => {
  it('disables ancestor config/editorconfig and implicit ignore lookup when captured roots have none', async () => {
    await put(join(directory, '.prettierrc'), '{"printWidth":1}');
    await put(join(directory, '.editorconfig'), 'root=true\n[*]\nindent_size=19');
    const bounded = await boundPrettierConfiguration(engine, project, ['a.js']);
    expect(bounded).toEqual({
      args: ['--no-config', '--no-editorconfig', '--ignore-path', devNull],
      inputs: [],
    });
  });

  it('uses exact local config, root-stopping editorconfig and both captured engine ignore files', async () => {
    for (const [name, text] of [
      ['.prettierrc', '{}'],
      ['.editorconfig', 'root=true\n'],
      ['.gitignore', 'obj-*/\n'],
      ['.prettierignore', 'generated/\n'],
    ] as const)
      await put(join(engine, name), text);
    const bounded = await boundPrettierConfiguration(engine, project, ['a.js']);
    expect(bounded.args).toEqual([
      '--config',
      join(engine, '.prettierrc'),
      '--ignore-path',
      join(engine, '.gitignore'),
      '--ignore-path',
      join(engine, '.prettierignore'),
    ]);
    expect(bounded.inputs).toEqual(
      ['.prettierrc', '.editorconfig', '.gitignore', '.prettierignore'].map((name) =>
        join(engine, name)
      )
    );
  });

  it.each(['.prettierrc', '.editorconfig'])(
    'refuses nested unqualified %s instead of silently changing formatting scope',
    async (name) => {
      await put(join(engine, 'nested', name), name === '.editorconfig' ? 'root=true' : '{}');
      await expect(boundPrettierConfiguration(engine, project, ['nested/a.js'])).rejects.toThrow(
        'Nested formatter/editorconfig'
      );
    }
  );

  it('refuses ancestor-leaking editorconfig, embedded config, ambiguity, escaped files and external aliases', async () => {
    await put(join(engine, '.editorconfig'), '[*]\nindent_size=2');
    await expect(boundPrettierConfiguration(engine, project, [])).rejects.toThrow('root=true');
    await rm(join(engine, '.editorconfig'));
    await put(join(project, 'package.json'), '{"prettier":{}}');
    await expect(boundPrettierConfiguration(engine, project, [])).rejects.toThrow(
      'Package-embedded'
    );
    await rm(join(project, 'package.json'));
    await put(join(engine, '.prettierrc'), '{}');
    await put(join(engine, 'prettier.config.js'), 'module.exports={}');
    await expect(boundPrettierConfiguration(engine, project, [])).rejects.toThrow(
      'Multiple formatter configs'
    );
    await rm(join(engine, 'prettier.config.js'));
    await expect(boundPrettierConfiguration(engine, project, ['../outside.js'])).rejects.toThrow(
      'escapes captured engine'
    );
    await rm(join(engine, '.prettierrc'));
    await put(join(directory, 'outside-config'), '{}');
    await symlink(join(directory, 'outside-config'), join(engine, '.prettierrc'));
    await expect(boundPrettierConfiguration(engine, project, [])).rejects.toThrow(
      'escapes captured root'
    );
  });
});
