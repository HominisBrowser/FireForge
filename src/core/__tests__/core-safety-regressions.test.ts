// SPDX-License-Identifier: EUPL-1.2
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getBuildBaselinePath, readBuildBaseline } from '../build-baseline.js';
import { validateAllComponents } from '../furnace-validate.js';
import { assertBuildArtifacts, hasBuildArtifacts } from '../mach-build-artifacts.js';
import { assertLocalObjdir, pruneDanglingTestLinks } from '../objdir-maintenance.js';
import { stampPerfHost } from '../test-host-state.js';
import { checkStaleBuildForTest, findUncoveredRequestPaths } from '../test-stale-check.js';
import {
  categoryHeaderExists,
  findCategorySection,
  findTokenDeclarationInRoot,
} from '../token-category.js';
import { collectTokenInventory } from '../token-inventory.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fireforge-core-safety-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('composition validation boundary', () => {
  it.each(['missing-widget', 'my-widget'])(
    'rejects an invalid composition %s through the actual config loader',
    async (composes) => {
      await writeFile(
        join(root, 'furnace.json'),
        JSON.stringify({
          version: 1,
          componentPrefix: 'my-',
          stock: [],
          overrides: {},
          custom: {
            'my-widget': {
              description: 'Widget',
              targetPath: 'browser/widgets',
              register: false,
              localized: false,
              composes: [composes],
            },
          },
        })
      );
      await expect(validateAllComponents(root)).rejects.toThrow(
        composes === 'my-widget' ? 'circular composes' : 'unknown component'
      );
    }
  );
});

describe('category interpretation', () => {
  it('uses the first banner name consistently for inventory and insertion', () => {
    const lines = ':root {\n/* ===\n * First\n * Second\n */\n--value: 1px;\n}'.split('\n');
    expect(collectTokenInventory(lines).map((group) => group.category)).toEqual(['First']);
    expect(categoryHeaderExists(lines, 'First')).toBe(true);
    expect(categoryHeaderExists(lines, 'Second')).toBe(false);
    expect(findCategorySection(lines, 'First', 'tokens.css')).toEqual({
      categoryLine: 1,
      sectionEnd: 6,
    });
    expect(() => findCategorySection(lines, 'Second', 'tokens.css')).toThrow('not found');
  });

  it('keeps nested rule closing braces inside a section and excludes variant-only banners', () => {
    const lines =
      ':root {\n/* = First = */\n@media screen {\n--value: 1px;\n}\n/* = Last = */\n--last: 2px;\n}\n:root[dark] {\n/* = Variant = */\n}'.split(
        '\n'
      );
    expect(findCategorySection(lines, 'First', 'tokens.css').sectionEnd).toBe(5);
    expect(categoryHeaderExists(lines, 'Variant')).toBe(false);
    expect(() => findCategorySection(lines, 'Variant', 'tokens.css')).toThrow('not found');
  });

  it('keeps the trailing decorative divider with its named header', () => {
    const lines =
      ':root {\n/* === */\n/* = First = */\n/* === */\n--first: 1px;\n/* === */\n/* = Last = */\n--last: 2px;\n}'.split(
        '\n'
      );
    expect(findCategorySection(lines, 'First', 'tokens.css')).toEqual({
      categoryLine: 2,
      sectionEnd: 5,
    });
  });

  it('uses the same section end for inventory, insertion and duplicate attribution', () => {
    const lines =
      '/* = Outside = */\n:root {\n/* = First = */\n--first: 1px;\n/* ======== */\n--loose: 2px;\n}'.split(
        '\n'
      );
    expect(findCategorySection(lines, 'First', 'tokens.css').sectionEnd).toBe(4);
    expect(collectTokenInventory(lines)).toEqual([
      { category: 'First', tokens: [{ name: '--first', line: 4, value: '1px' }] },
      { category: null, tokens: [{ name: '--loose', line: 6, value: '2px' }] },
    ]);
    expect(findTokenDeclarationInRoot(lines, '--first')).toEqual({ line: 4, category: 'First' });
    expect(findTokenDeclarationInRoot(lines, '--loose')).toEqual({ line: 6 });
    const uncategorized = ['/* = Outside = */', ':root {', '--loose: 2px;', '}'];
    expect(findTokenDeclarationInRoot(uncategorized, '--loose')).toEqual({ line: 3 });
  });
});

describe('coverage boundaries', () => {
  it('covers dotted directories exactly without admitting siblings', () => {
    expect(findUncoveredRequestPaths(['browser/tests/a.v1'], ['browser/tests/b.v2'])).toEqual([
      'browser/tests/b.v2',
    ]);
    expect(
      findUncoveredRequestPaths(['browser/tests/a.v1'], ['browser/tests/a.v1/test.js'])
    ).toEqual([]);
  });

  it('does not infer manifest ownership from the directory of a file claim', () => {
    expect(
      findUncoveredRequestPaths(['browser/tests/test_a.js'], ['browser/tests/test_b.js'])
    ).toEqual(['browser/tests/test_b.js']);
    expect(findUncoveredRequestPaths(['browser/tests/test_a.js'], ['browser/tests'])).toEqual([
      'browser/tests',
    ]);
  });
});

describe('persisted baseline validation', () => {
  const legacy = {
    engineHeadSha: 'abc123',
    builtAt: '2026-10-04T00:00:00.000Z',
    binaryName: 'firefox',
  };

  it.each([
    null,
    [],
    {},
    { ...legacy, builtAt: 'not a date' },
    { ...legacy, testPackagingCoverage: 'scoped' },
    { ...legacy, testPackagingCoverage: [null] },
    { ...legacy, testPackagingCoverage: ['../escape'] },
    { ...legacy, testInputFingerprints: null },
    { ...legacy, packageableFingerprints: { 'browser/file.js': 42 } },
    { ...legacy, buildInputFingerprints: { '../file': 'ab'.repeat(32) } },
    { ...legacy, staticComponentsBaseline: { engineHeadSha: 'abc123', fingerprints: [] } },
    { ...legacy, mozconfigHash: 42 },
  ])('ignores malformed data during rebuild but refuses test dispatch: %j', async (baseline) => {
    await mkdir(join(root, '.fireforge'));
    await writeFile(getBuildBaselinePath(root), JSON.stringify(baseline));
    await expect(readBuildBaseline(root)).resolves.toBeUndefined();
    await expect(checkStaleBuildForTest(root, join(root, 'engine'))).rejects.toThrow(
      'Build baseline'
    );
  });

  it('preserves valid legacy records and modern deletion fingerprints', async () => {
    await mkdir(join(root, '.fireforge'));
    await writeFile(getBuildBaselinePath(root), JSON.stringify(legacy));
    await expect(readBuildBaseline(root, 'refuse')).resolves.toEqual(legacy);
    const modern = {
      ...legacy,
      testPackagingCoverage: [],
      testInputFingerprints: { 'browser/deleted.js': '<deleted>' },
      mozconfigHash: 'ab'.repeat(32),
    };
    await writeFile(getBuildBaselinePath(root), JSON.stringify(modern));
    await expect(readBuildBaseline(root, 'refuse')).resolves.toEqual(modern);
  });
});

describe('objdir maintenance ownership', () => {
  it('refuses aliased peer mutations after the normal artifact gate accepts its dist tree', async () => {
    const engine = join(root, 'engine');
    const peer = join(root, 'peer/obj-debug');
    const target = join(root, 'missing');
    await mkdir(engine);
    await mkdir(join(peer, '_tests'), { recursive: true });
    await mkdir(join(peer, 'dist'));
    await symlink(target, join(peer, '_tests/dangling'));
    await symlink(peer, join(engine, 'obj-debug'));
    const artifacts = await hasBuildArtifacts(engine);
    expect(artifacts).toEqual({ exists: true, objDir: 'obj-debug' });
    assertBuildArtifacts(engine, artifacts, {
      label: 'Tests',
      requirement: 'Tests require a build.',
      remediation: 'Build again.',
    });
    await expect(pruneDanglingTestLinks(engine, 'obj-debug')).rejects.toThrow('outside its local');
    expect(await readlink(join(peer, '_tests/dangling'))).toBe(target);
    await expect(assertLocalObjdir(engine, '../peer/obj-debug')).rejects.toThrow(
      'local directory name'
    );
  });
});

describe('optional perf annotation', () => {
  it('annotates all valid artifacts despite producer corruption, retaining power transition evidence', async () => {
    const broken = join(root, 'broken.json');
    const valid = join(root, 'valid.json');
    const second = join(root, 'second.json');
    await writeFile(broken, '{');
    await writeFile(valid, '{"metric":42}');
    await writeFile(second, '{"metric":12}');
    const changed = await stampPerfHost(
      { A_PERF_SAMPLE_JSON: broken, B_PERF_SAMPLE_JSON: valid, C_PERF_SAMPLE_JSON: second },
      { load: 1, power: 'ac' },
      { load: 2, power: 'battery' }
    );
    expect(changed).toBe(true);
    for (const artifact of [valid, second]) {
      expect(JSON.parse(await readFile(artifact, 'utf8'))).toMatchObject({
        fireforgeHost: { powerSourceChanged: true },
      });
    }
    expect(await readFile(broken, 'utf8')).toBe('{');
  });
});
