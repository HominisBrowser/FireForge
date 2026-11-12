// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge migrate` through the CLI on projects written in the previous
 * format: a source-mode project with its records, waivers, policy decisions
 * and merge driver, and a patch-mode project.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { type HostPaths, hostPaths } from '../project/index.js';
import { type CliResult, runCli } from '../testing/cli.js';
import { MINIMAL_CONFIG } from '../testing/config.js';
import { seedPristine, useMachSandbox } from '../testing/engine.js';
import { SYNTHETIC_FIREFOX_PATHS } from '../testing/firefox.js';
import { commitAll, git, initRepo } from '../testing/git.js';
import { createPatchProject } from '../testing/patch-project.js';
import { useTempDir, writeTree } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

const BROWSER = SYNTHETIC_FIREFOX_PATHS.browserScript;
const SERVICE = SYNTHETIC_FIREFOX_PATHS.serviceModule;
const HEADER = '/* SPDX-License-Identifier: EUPL-1.2 */\n';

const host = (): HostPaths => hostPaths({ FIREFORGE_HOME: join(dir(), 'home') });

const cli = (root: string, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: root, env: { FIREFORGE_HOME: host().root } });

const json = (result: CliResult): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>;

const read = (root: string, path: string): Promise<string> => readFile(join(root, path), 'utf8');

const config = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(await read(root, 'fireforge.json')) as Record<string, unknown>;

/** The scope rule whose digest at index 0 the policy fixture names. */
const SCOPE_RULE = { filenamePattern: '-tests\\.patch$', files: ['**/test/**', '**/tests/**'] };
const SCOPE_RULE_DIGEST = '5c32f4bde0f55a45f130f1ec9a7bad9968f28eb30ef651538aebc1f042c7d7d0';

/** `fireforge.json` as the previous format wrote a source-mode project, laid out by hand. */
function previousConfig(commit: string, overrides: Record<string, unknown> = {}): string {
  const document = {
    ...MINIMAL_CONFIG,
    license: 'EUPL-1.2',
    test: { reapOrphans: 'owned' },
    patchLint: { jsdocClassMethods: 'error', forwardRegistration: 'extended' },
    patchPolicy: { ranges: [{ from: 1, to: 999, category: 'ui' }], scopeRules: [SCOPE_RULE] },
    check: {
      timeout: 600,
      extraSteps: [
        { name: 'audit', command: 'node tools/audit.mjs --quick', footprint: { static: true } },
        { name: 'token-lint', command: './node_modules/.bin/fireforge token lint' },
      ],
    },
    sources: {
      schemaVersion: 1,
      mode: 'authored',
      root: 'src',
      metadataRoot: '.fireforge-sources',
      pristineCommit: commit,
    },
    slots: { dependencyCaches: [{ source: 'engine/node_modules', target: 'engine/node_modules' }] },
    proof: {
      mainBranch: 'main',
      noneRoutes: ['docs/**'],
      gate: {
        build: 'ui',
        mode: 'dev',
        lanes: [{ id: 'unit', files: ['browser/test/unit/test_*.js'], quiet: true }],
        runs: [
          {
            id: 'smoke',
            args: ['--smoke-exit', '30', '--capture-console', '{artifacts}/console.txt'],
          },
        ],
      },
    },
    exportQueue: { groups: [{ name: 'ui-kit', paths: ['browser/base/content/kit/**'] }] },
    ...overrides,
  };
  // One-line arrays, as a hand-kept file has them.
  return `${JSON.stringify(document, null, 2).replace(
    /\[\n\s+"docs\/\*\*"\n\s+\]/,
    '["docs/**"]'
  )}\n`;
}

function previousRecord(path: string, fields: Record<string, unknown>, base: object): string {
  return `${JSON.stringify({ ...fields, base: { ...base, pin: 'ab'.repeat(32) }, path, schemaVersion: 1 })}\n`;
}

/** A committed source-mode project in the previous format, on the seeded pin. */
async function previousSourceProject(overrides: Record<string, unknown> = {}): Promise<string> {
  const commit = await seedPristine(host());
  const pristine = join(host().pristine, 'firefox-esr-140.9.0esr');
  const blob = async (path: string): Promise<string> =>
    (await git(pristine, ['rev-parse', `${commit}:${path}`])).trim();
  const root = join(dir(), 'project');
  const base = async (path: string): Promise<object> => ({
    blob: await blob(path),
    commit,
    mode: '100644',
  });
  await initRepo(root, {
    'fireforge.json': previousConfig(commit, overrides),
    '.gitignore': '.fireforge/\n',
    'configs/common.mozconfig':
      'ac_add_options --enable-application=browser\nmk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-custom\n',
    [`configs/${process.platform}.mozconfig`]: '# platform options\n',
    'src/.gitattributes': '* -text\n* merge=fireforge-authored\n',
    [`src/${BROWSER}`]: 'export const browserTitle = "mine";\n',
    'src/browser/base/content/kit/vendor.js': 'export const vendored = 1;\n',
    'src/browser/base/content/kit/kit.js': `${HEADER}export const kit = 1;\n`,
    [`.fireforge-sources/overrides/${BROWSER}.json`]: previousRecord(
      BROWSER,
      { classification: 'registration', component: '200-ui-title.patch', kind: 'override' },
      await base(BROWSER)
    ),
    [`.fireforge-sources/overrides/${SERVICE}.json`]: previousRecord(
      SERVICE,
      { classification: 'registration', component: '200-ui-title.patch', kind: 'delete' },
      await base(SERVICE)
    ),
    '.fireforge-sources/waivers.json': JSON.stringify({
      schemaVersion: 1,
      exceptions: [
        {
          component: '200-ui-title.patch',
          paths: [BROWSER, SERVICE],
          checks: [{ rule: 'large-patch-files', max: 25, reason: 'One spine.', meta: { n: 15 } }],
          tier: 'branding',
        },
        {
          component: '411-ui-kit-vendor.patch',
          paths: ['browser/base/content/kit/vendor.js'],
          checks: ['missing-license-header'],
        },
      ],
    }),
    '.fireforge-sources/policy.json': JSON.stringify({
      schemaVersion: 1,
      status: 'approved',
      retireCreatedPatchBudgets: true,
      scopeRules: [{ legacyRule: SCOPE_RULE_DIGEST, decision: 'retire', reason: 'No patches.' }],
    }),
    '.fireforge-sources/cutover-map.json': '{"frozen":true,"paths":{}}\n',
    '.fireforge-sources/legacy-manifest.json': '{"version":1,"patches":[]}\n',
  });
  return root;
}

describe('fireforge migrate', () => {
  it('upgrades a source-mode project of the previous format in place, once', async () => {
    const root = await previousSourceProject();

    // Nothing of the previous format loads.
    expect((await cli(root, 'status')).exitCode).toBe(ExitCode.CONFIG_ERROR);

    await writeTree(root, { 'notes.txt': 'uncommitted\n' });
    const dirty = await cli(root, 'migrate');
    expect(dirty.exitCode).toBe(ExitCode.GIT_ERROR);
    expect(dirty.stderr).toContain('error[migrate-needs-clean-tree]');
    expect(await config(root)).toHaveProperty('sources');
    await commitAll(root, 'notes');

    const migrated = await cli(root, 'migrate', '--json');
    expect(migrated.stderr).toBe('');
    expect(migrated.exitCode).toBe(ExitCode.SUCCESS);
    const report = json(migrated);
    expect(report).toMatchObject({
      state: 'upgraded',
      mode: 'source',
      pass: true,
      deleted: [
        '.fireforge-sources/waivers.json',
        '.fireforge-sources/policy.json',
        '.fireforge-sources/cutover-map.json',
        '.fireforge-sources/legacy-manifest.json',
      ],
      manual: [{ key: 'check.extraSteps' }],
    });
    expect(report['rewritten']).toEqual([
      'fireforge.json',
      `.fireforge-sources/overrides/${BROWSER}.json`,
      `.fireforge-sources/overrides/${SERVICE}.json`,
      'src/.gitattributes',
      'configs/common.mozconfig',
    ]);
    const removed = (report['removed'] as { key: string }[]).map((note) => note.key);
    expect(removed).toEqual(
      expect.arrayContaining([
        'slots',
        'test.reapOrphans',
        'check.timeout',
        'check.extraSteps[1]',
        'proof.gate.lanes[0].quiet',
        'patchPolicy.scopeRules[0]',
        'configs/common.mozconfig',
        'waivers.json 200-ui-title.patch checks[0].meta',
      ])
    );

    const next = await config(root);
    expect(next).toMatchObject({
      mode: 'source',
      source: { root: 'src', metadataRoot: '.fireforge-sources' },
      patchLint: {
        rules: { 'jsdoc-class-method': 'error' },
        waivers: [
          { group: '200-ui-title.patch', rule: 'large-patch-files', max: 25, reason: 'One spine.' },
          { group: 'ui-kit-vendor', rule: 'missing-license-header' },
        ],
      },
      check: { extraSteps: [{ name: 'audit', command: ['node', 'tools/audit.mjs', '--quick'] }] },
      gate: {
        build: 'ui',
        documents: ['docs/**'],
        lanes: [{ id: 'unit', files: ['browser/test/unit/test_*.js'] }],
        runs: [{ id: 'smoke', smokeExit: 30 }],
      },
      exportQueue: {
        groups: [
          { name: 'ui-kit-vendor', paths: ['browser/base/content/kit/vendor.js'] },
          { name: 'ui-kit', paths: ['browser/base/content/kit/**'] },
        ],
        componentTiers: { '200-ui-title.patch': 'branding' },
      },
    });
    for (const gone of ['sources', 'proof', 'slots', 'test']) expect(next).not.toHaveProperty(gone);
    expect(next['patchPolicy']).not.toHaveProperty('scopeRules');
    // Untouched values keep their layout.
    expect(await read(root, 'fireforge.json')).toContain('"license": "EUPL-1.2"');

    const record = JSON.parse(
      await read(root, `.fireforge-sources/overrides/${BROWSER}.json`)
    ) as Record<string, unknown>;
    expect(Object.keys(record)).toEqual(['base', 'classification', 'component', 'kind']);
    expect(record['component']).toBe('200-ui-title.patch');
    expect(Object.keys(record['base'] as object)).toEqual(['blob', 'commit', 'mode']);
    expect(await read(root, 'src/.gitattributes')).toBe('* -text\n* merge=fireforge\n');
    expect(await read(root, 'configs/common.mozconfig')).toBe(
      'ac_add_options --enable-application=browser\n'
    );
    expect(await exists(join(root, '.fireforge-sources/waivers.json'))).toBe(false);
    expect(await git(root, ['config', '--get', 'merge.fireforge.driver'])).toContain(
      'merge-driver run'
    );
    expect(await exists(join(root, '.fireforge/migrate.journal'))).toBe(false);

    // The upgraded project works, and its groups are listed by the IDs the configuration names.
    expect((await cli(root, 'verify')).exitCode).toBe(ExitCode.SUCCESS);
    const groups = await cli(root, 'status', '--check', '--groups');
    expect(groups.exitCode).toBe(ExitCode.SUCCESS);
    expect(groups.stdout).toBe(
      '4 owned path(s) in 3 group(s)\n' +
        '  200-ui-title.patch  component  2 path(s)\n' +
        '  ui-kit  created  1 path(s)\n' +
        '  ui-kit-vendor  created  1 path(s)\n' +
        'Nothing is unaccounted for.\n'
    );
    const lint = await cli(root, 'lint');
    expect(lint.stdout).not.toContain('missing-license-header');

    // A second run finds nothing to do, committed or not.
    const again = await cli(root, 'migrate', '--json');
    expect(again.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(again)).toMatchObject({ state: 'current', rewritten: [], deleted: [], pass: true });
    expect((await git(root, ['status', '--porcelain'])).trim().split('\n')).toHaveLength(9);
  }, 120_000);

  it('writes nothing while anything needs a decision, and names every such thing', async () => {
    const root = await previousSourceProject({
      proof: { gate: { runs: [{ id: 'smoke', args: ['--smoke-exit', '30', '--profile', 'p'] }] } },
      check: { extraSteps: [{ name: 'audit', command: 'node audit.mjs', cwd: 'tools' }] },
    });
    const blocked = await cli(root, 'migrate');
    expect(blocked.exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(blocked.stderr).toContain('error[migrate-blocked]: 2 thing(s)');
    expect(blocked.stderr).toContain('proof.gate.runs[0].args[2]: "--profile"');
    expect(blocked.stderr).toContain('check.extraSteps[0].cwd:');
    expect(blocked.stderr).toContain('hint: Nothing was written.');
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  }, 60_000);

  it('undoes everything when a waiver cannot be placed', async () => {
    const root = await previousSourceProject();
    await writeTree(root, {
      '.fireforge-sources/waivers.json': JSON.stringify({
        schemaVersion: 1,
        exceptions: [{ component: '200-ui-title.patch', paths: [BROWSER], checks: ['jsdoc'] }],
      }),
    });
    await commitAll(root, 'a waiver over part of a component');
    const blocked = await cli(root, 'migrate');
    expect(blocked.exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(blocked.stderr).toContain(
      'waivers.json 200-ui-title.patch checks[0]: covers some upstream paths'
    );
    expect(await git(root, ['status', '--porcelain'])).toBe('');
    expect(await config(root)).toHaveProperty('sources');
  }, 60_000);

  it('upgrades a patch-mode project: its configuration, and nothing in the queue', async () => {
    await seedPristine(host());
    const fixture = await createPatchProject(join(dir(), 'patches-project'));
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "mine";\n' });
    const previous = {
      ...(await config(fixture.root)),
      proof: { gate: { build: 'full', check: { quiet: true } }, consumerLimit: 3 },
      check: { timeouts: { lint: 60 }, status: { failOn: ['unmanaged'], failOnUnknown: true } },
      patchPolicy: {
        ranges: [{ from: 1, to: 999, category: 'ui' }],
        scopeRules: [{ category: 'ui', files: ['browser/**'] }],
      },
    };
    await writeTree(fixture.root, { 'fireforge.json': `${JSON.stringify(previous, null, 2)}\n` });
    await initRepo(fixture.root, { '.gitignore': 'engine/\n.fireforge/\n' });

    const migrated = await cli(fixture.root, 'migrate', '--json');
    expect(migrated.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(migrated)).toMatchObject({ state: 'upgraded', mode: 'patches', pass: true });
    const next = await config(fixture.root);
    expect(next).toMatchObject({
      license: 'MPL-2.0',
      gate: { build: 'full' },
      check: { status: { failOn: ['unmanaged'] } },
      patchPolicy: { scopeRules: [{ group: '^\\d+-ui-', files: ['browser/**'] }] },
    });
    expect(next).not.toHaveProperty('mode');
    expect(next).not.toHaveProperty('proof');
    expect((await cli(fixture.root, 'migrate', '--json')).stdout).toContain('"state":"current"');
  }, 60_000);
});
