// SPDX-License-Identifier: EUPL-1.2
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useTempDir, writeTree } from '../testing/temp.js';
import { checkMachArgument, planDispatches, planTests, resolveTests, shuffled } from './plan.js';

const dir = useTempDir();
const FORK = 'browser/base/content/test/fork';

/** An engine with browser-chrome, xpcshell and reftest manifests, and a prefix-named sibling. */
async function engine(): Promise<string> {
  await writeTree(dir(), {
    [`${FORK}/browser.toml`]: [
      '[DEFAULT]',
      'support-files = ["head.js", "data/**"]',
      '',
      '["browser_a.js"]',
      '',
      '["browser_b.js"]',
      'support-files = ["helper_b.js"]',
      '',
    ].join('\n'),
    [`${FORK}/browser_a.js`]: '',
    [`${FORK}/browser_b.js`]: '',
    [`${FORK}/head.js`]: '',
    [`${FORK}/helper_b.js`]: '',
    [`${FORK}/browser_unlisted.js`]: '',
    [`${FORK}/data/fixture.json`]: '{}',
    [`${FORK}-two/browser.toml`]: '["browser_c.js"]\n',
    [`${FORK}-two/browser_c.js`]: '',
    'browser/modules/test/unit/xpcshell.toml':
      '[DEFAULT]\nhead = "head.js"\n\n["test_x.js"]\n["test_y.js"]\n',
    'browser/modules/test/unit/test_x.js': '',
    'browser/modules/test/unit/test_y.js': '',
    'browser/modules/test/unit/head.js': '',
    'layout/reftests/fork/reftest.list': '== a.html a-ref.html\n',
    'obj-fireforge/_tests/browser.toml': '["browser_built.js"]\n',
  });
  return dir();
}

describe('resolveTests', () => {
  it('resolves files, directories, manifests and globs to listed tests with their suite', async () => {
    const root = await engine();
    expect(await resolveTests(root, [`${FORK}/browser_a.js`])).toEqual([
      { path: `${FORK}/browser_a.js`, suite: 'mochitest' },
    ]);
    expect(await resolveTests(root, [FORK])).toEqual([
      { path: `${FORK}/browser_a.js`, suite: 'mochitest' },
      { path: `${FORK}/browser_b.js`, suite: 'mochitest' },
    ]);
    expect(await resolveTests(root, ['browser/modules/test/unit/xpcshell.toml'])).toEqual([
      { path: 'browser/modules/test/unit/test_x.js', suite: 'xpcshell' },
      { path: 'browser/modules/test/unit/test_y.js', suite: 'xpcshell' },
    ]);
    expect(
      (await resolveTests(root, ['browser/base/content/test/fork*/browser_*.js'])).map(
        (test) => test.path
      )
    ).toEqual([`${FORK}-two/browser_c.js`, `${FORK}/browser_a.js`, `${FORK}/browser_b.js`]);
    expect(await resolveTests(root, ['layout/reftests/fork'])).toEqual([
      { path: 'layout/reftests/fork/reftest.list', suite: 'generic' },
    ]);
  });

  it('never sweeps in a prefix-named sibling or a build output directory', async () => {
    const root = await engine();
    expect((await resolveTests(root, ['browser'])).map((test) => test.path)).toEqual([
      `${FORK}-two/browser_c.js`,
      `${FORK}/browser_a.js`,
      `${FORK}/browser_b.js`,
      'browser/modules/test/unit/test_x.js',
      'browser/modules/test/unit/test_y.js',
    ]);
  });

  it('refuses a support file naming the tests that read it, and an unlisted file', async () => {
    const root = await engine();
    await expect(resolveTests(root, [`${FORK}/head.js`])).rejects.toMatchObject({
      code: 'not-a-test',
      message: expect.stringContaining(
        `lists it for ${FORK}/browser_a.js, ${FORK}/browser_b.js`
      ) as string,
    });
    await expect(resolveTests(root, [`${FORK}/helper_b.js`])).rejects.toMatchObject({
      message: expect.stringContaining(`lists it for ${FORK}/browser_b.js.`) as string,
    });
    await expect(resolveTests(root, [`${FORK}/data/fixture.json`])).rejects.toMatchObject({
      code: 'not-a-test',
    });
    await expect(resolveTests(root, [`${FORK}/browser_unlisted.js`])).rejects.toMatchObject({
      code: 'not-a-test',
      message: expect.stringContaining('no test manifest beside it lists it') as string,
    });
  });

  it('refuses a missing path, a path outside the engine, and a selection that is empty', async () => {
    const root = await engine();
    await expect(resolveTests(root, ['browser/absent.js'])).rejects.toMatchObject({
      code: 'test-path-missing',
    });
    await expect(resolveTests(root, ['../outside'])).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(resolveTests(root, [`${FORK}/data`])).rejects.toMatchObject({ code: 'no-tests' });
    await expect(resolveTests(root, ['browser/**/browser_zzz*.js'])).rejects.toMatchObject({
      code: 'no-tests',
    });
    await expect(resolveTests(root, [FORK], [`${FORK}/browser_*.js`])).rejects.toMatchObject({
      code: 'no-tests',
    });
  });

  it('fails on a manifest that is there and cannot be read, instead of resolving without it', async () => {
    const prefs = 'browser/components/preferences';
    await writeTree(dir(), {
      [`${prefs}/tests/eval.toml`]: '["browser_eval.js"]\n',
      [`${prefs}/tests/browser_eval.js`]: '',
    });
    // Only the moz.build above it can say that eval.toml is a test manifest.
    await mkdir(join(dir(), prefs, 'moz.build'));
    await expect(resolveTests(dir(), [`${prefs}/tests/browser_eval.js`])).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('accepts an engine/ prefix and leaves out excluded paths and globs', async () => {
    const root = await engine();
    expect(
      (
        await resolveTests(
          root,
          [`engine/${FORK}/`, 'browser/modules/test/unit'],
          [`${FORK}/browser_b.js`, '**/test_y.js']
        )
      ).map((test) => test.path)
    ).toEqual([`${FORK}/browser_a.js`, 'browser/modules/test/unit/test_x.js']);
  });

  it('knows a manifest by a suffixed name or by the moz.build that lists it, and its suite by flavour', async () => {
    const prefs = 'browser/components/preferences';
    await writeTree(dir(), {
      [`${prefs}/moz.build`]:
        'BROWSER_CHROME_MANIFESTS += [\n    "tests/browser-srd.toml",\n    "tests/eval.toml",\n]\n',
      [`${prefs}/tests/browser-srd.toml`]: '["browser_srd.js"]\n',
      [`${prefs}/tests/browser_srd.js`]: '',
      [`${prefs}/tests/eval.toml`]: '["browser_eval.js"]\n',
      [`${prefs}/tests/browser_eval.js`]: '',
      [`${prefs}/tests/Cargo.toml`]: '["browser_cargo.js"]\n',
      [`${prefs}/tests/browser_cargo.js`]: '',
      'netwerk/test/unit/xpcshell-remote.toml': '["test_remote.js"]\n',
      'netwerk/test/unit/test_remote.js': '',
    });
    expect(await resolveTests(dir(), [`${prefs}/tests/browser-srd.toml`])).toEqual([
      { path: `${prefs}/tests/browser_srd.js`, suite: 'mochitest' },
    ]);
    expect((await resolveTests(dir(), [prefs])).map((test) => test.path)).toEqual([
      `${prefs}/tests/browser_eval.js`,
      `${prefs}/tests/browser_srd.js`,
    ]);
    expect(await resolveTests(dir(), [`${prefs}/tests/browser_eval.js`])).toEqual([
      { path: `${prefs}/tests/browser_eval.js`, suite: 'mochitest' },
    ]);
    await expect(resolveTests(dir(), [`${prefs}/tests/browser_cargo.js`])).rejects.toMatchObject({
      code: 'not-a-test',
    });
    expect(await resolveTests(dir(), ['netwerk/test/unit'])).toEqual([
      { path: 'netwerk/test/unit/test_remote.js', suite: 'xpcshell' },
    ]);
  });
});

describe('planDispatches', () => {
  const tests = [
    { path: 'a/browser_1.js', suite: 'mochitest' as const },
    { path: 'a/browser_2.js', suite: 'mochitest' as const },
    { path: 'b/test_1.js', suite: 'xpcshell' as const },
    { path: 'b/test_2.js', suite: 'xpcshell' as const },
  ];

  it('gives each mochitest file a browser of its own and xpcshell one invocation', () => {
    expect(planDispatches(tests, 'shards')).toEqual([
      { suite: 'mochitest', paths: ['a/browser_1.js'], restart: false },
      { suite: 'mochitest', paths: ['a/browser_2.js'], restart: false },
      { suite: 'xpcshell', paths: ['b/test_1.js', 'b/test_2.js'], restart: false },
    ]);
  });

  it('puts mochitest files in one browser, or one invocation restarting between them', () => {
    expect(planDispatches(tests, 'one-browser')[0]).toEqual({
      suite: 'mochitest',
      paths: ['a/browser_1.js', 'a/browser_2.js'],
      restart: false,
    });
    expect(planDispatches(tests, 'standalone')[0]?.restart).toBe(true);
    expect(planDispatches(tests, 'standalone')).toHaveLength(2);
  });
});

describe('shuffled', () => {
  it('permutes deterministically by seed without changing its input', () => {
    const items = Array.from({ length: 12 }, (_, index) => index);
    expect(shuffled(items, 7)).toEqual(shuffled(items, 7));
    expect(shuffled(items, 7)).not.toEqual(items);
    expect(shuffled(items, 8)).not.toEqual(shuffled(items, 7));
    expect([...shuffled(items, 7)].sort((a, b) => a - b)).toEqual(items);
    expect(items[0]).toBe(0);
  });
});

describe('checkMachArgument', () => {
  it.each([
    '--setpref=focusmanager.testmode=true',
    '--setpref=layout.css.dpi=96',
    '--timeout=600',
    '--app-path=/abs/dist/bin/browser',
  ])('accepts %s', (arg) => {
    expect(() => {
      checkMachArgument(arg);
    }).not.toThrow();
  });

  it.each([
    '--setpref=marionette.port=2829',
    '--setpref=browser.download.dir=/tmp/x',
    '--log-raw=/tmp/x.jsonl',
    '--headless',
    '--restart-between-tests',
    '--app-path=relative/dir',
    '--profile=/tmp/p',
  ])('refuses %s', (arg) => {
    expect(() => {
      checkMachArgument(arg);
    }).toThrow(expect.objectContaining({ code: 'invalid-argument' }) as Error);
  });
});

describe('planTests', () => {
  it('builds the plan with its defaults', async () => {
    const root = await engine();
    const plan = await planTests(root, { paths: [FORK, 'browser/modules/test/unit'] });
    expect(plan).toMatchObject({ repeat: 1, headed: false });
    expect(plan.tests).toHaveLength(4);
    expect(plan.dispatches.map((entry) => entry.suite)).toEqual([
      'mochitest',
      'mochitest',
      'xpcshell',
    ]);
  });

  it.each([
    [{ paths: [] }, 'at least one test path'],
    [{ paths: [FORK], env: { FIREFORGE_TEST_RUN: 'x' } }, 'cannot set FIREFORGE_TEST_RUN'],
    [{ paths: [FORK], env: { 'BAD-NAME': 'x' } }, 'cannot set BAD-NAME'],
    [{ paths: ['browser/modules/test/unit'], shuffle: 3 }, 'selects none'],
    [
      { paths: ['layout/reftests/fork'], coverageDir: '/tmp/cov' },
      'reftest manifests have no coverage',
    ],
    [{ paths: [FORK], machArgs: ['--headless'] }, 'is not accepted'],
  ])('refuses %j', async (request, message) => {
    const root = await engine();
    await expect(planTests(root, request)).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining(message) as string,
    });
  });
});
