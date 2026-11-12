// SPDX-License-Identifier: EUPL-1.2
/**
 * `gate` through the CLI over the stand-in mach, in each mode: what it
 * refuses, what a pass and a red record, when the verified ref moves, the
 * decisions people record, documents-only commits and feedback runs.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_LICENSE } from '../config/index.js';
import { ExitCode } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { type HostPaths, hostPaths, licenseHeader } from '../project/index.js';
import { type CliResult, runCli } from '../testing/cli.js';
import {
  makeEngineProject,
  makeSourceProject,
  seedPristine,
  useMachSandbox,
} from '../testing/engine.js';
import { type MachScript, readMachLog } from '../testing/firefox.js';
import { commitAll, git, initRepo } from '../testing/git.js';
import {
  harnessScript,
  TEST_ENGINE_FILES,
  TEST_PATHS,
  writeScriptMutation,
} from '../testing/harness.js';
import { useTempDir, writeTree } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

const { browserA: A, browserB: B } = TEST_PATHS;
const REF = 'refs/fireforge/verified';
const HEADER = `${licenseHeader(DEFAULT_LICENSE, 'js')}\n`;
const LANE_A = { id: 'a', files: [A] };
const LANE_B = { id: 'b', files: [B] };

const host = (): HostPaths => hostPaths({ FIREFORGE_HOME: join(dir(), 'home') });

const cli = (project: { root: string }, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: project.root, env: { FIREFORGE_HOME: host().root } });

const json = (result: CliResult): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>;

const verdict = (result: CliResult): string => result.stdout.trimEnd().split('\n').at(-1) ?? '';

const refAt = async (project: { root: string }): Promise<string> =>
  (await git(project.root, ['rev-parse', '--verify', '--quiet', REF]).catch(() => '')).trim();

const head = async (project: { root: string }): Promise<string> =>
  (await git(project.root, ['rev-parse', 'HEAD'])).trim();

/** Each test file passes unless `reds` names the assertion it fails at. */
const harness = (reds: Readonly<Record<string, string>> = {}): MachScript => ({
  byArg: { [A]: harnessScript([A], reds), [B]: harnessScript([B], reds) },
});

/** Seeds the pin with the test files, a harness and a browser that stays up for a smoke start. */
async function seed(script: MachScript = harness()): Promise<void> {
  await seedPristine(host(), {
    ...TEST_ENGINE_FILES,
    '.mach-state/script-mochitest.json': JSON.stringify(script),
    '.mach-state/script-run.json': JSON.stringify({ stdout: ['console.log: started'], sleep: 60 }),
  });
}

/** A committed patch-mode project on the downloaded pin. */
async function patchProject(
  gate: Record<string, unknown>,
  config: Record<string, unknown> = {},
  script?: MachScript
): Promise<{ root: string; engine: string }> {
  await seed(script);
  const project = await makeEngineProject(dir(), {
    config: { test: { mochitestPorts: 'auto' }, gate, ...config },
    files: { '.gitignore': 'engine/\n.fireforge/\n' },
  });
  expect((await cli(project, 'download')).exitCode).toBe(ExitCode.SUCCESS);
  await initRepo(project.root);
  return { root: project.root, engine: join(project.root, 'engine') };
}

const tests = async (engine: string): Promise<string[]> =>
  (await readMachLog(engine)).flatMap((call) =>
    (call.args[0] === 'mochitest' ? [A, B] : []).filter((file) => call.args.includes(file))
  );

describe('fireforge gate in patch mode', () => {
  it('refuses a dirty tree, then verifies the commit and records the run', async () => {
    const project = await patchProject({ lanes: [LANE_A, LANE_B] });
    expect((await cli(project, 'gate', 'status')).stdout).toContain('No commit is verified yet');

    await writeTree(project.root, { 'notes.txt': 'uncommitted\n' });
    const dirty = await cli(project, 'gate');
    expect(dirty.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(dirty.stderr).toContain('notes.txt');
    expect(verdict(dirty)).toBe('FIREFORGE-VERDICT: FAIL reason=gate-dirty-tree');
    expect(await readMachLog(project.engine)).toEqual([]);
    const commit = await commitAll(project.root, 'notes');

    const passed = await cli(project, 'gate');
    expect(passed.stderr).not.toContain('Error');
    expect(passed.exitCode).toBe(ExitCode.SUCCESS);
    expect(passed.stdout).toMatch(/^check +pass/m);
    expect(passed.stdout).toMatch(/^build +pass .*(ui|full) build$/m);
    expect(passed.stdout).toMatch(/^lane:a +pass .*1 test file\(s\)$/m);
    expect(passed.stdout).toContain(`Gate passed: ${REF} is now at ${commit.slice(0, 12)}.`);
    expect(verdict(passed)).toBe(`FIREFORGE-VERDICT: PASS result=verified commit=${commit}`);
    expect(await refAt(project)).toBe(commit);
    expect((await readMachLog(project.engine)).map((call) => call.args[0])).toEqual([
      'build',
      'mochitest',
      'mochitest',
    ]);

    const run = join(project.root, '.fireforge', 'gate', commit);
    const result = JSON.parse(await readFile(join(run, 'result.json'), 'utf8')) as unknown;
    expect(result).toMatchObject({
      commit,
      pass: true,
      entries: [
        { id: 'check' },
        { id: 'build' },
        { id: 'lane:a', artifacts: 'lane-a' },
        { id: 'lane:b' },
      ],
    });
    expect(await readFile(join(run, 'lane-a', 'output.log'), 'utf8')).toContain(`TEST_START: ${A}`);
    expect(await exists(join(run, 'lane-b', 'results.json'))).toBe(true);

    const again = await cli(project, 'gate', '--json');
    expect(json(again)).toMatchObject({ outcome: 'verified', basis: 'already-verified' });
    const status = await cli(project, 'gate', 'status', '--json');
    expect(json(status)).toMatchObject({
      relation: 'verified',
      verified: commit,
      clean: true,
      result: { pass: true },
    });
  }, 120_000);

  it('reports every lane of a red run with exit code 5 and leaves the ref', async () => {
    const project = await patchProject({ lanes: [LANE_A, LANE_B] }, {}, harness({ [A]: 'boom' }));
    const red = await cli(project, 'gate', '--json');
    expect(red.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(json(red)).toMatchObject({
      outcome: 'failed',
      pass: false,
      entries: [
        { id: 'check', status: 'pass' },
        { id: 'build', status: 'pass' },
        { id: 'lane:a', status: 'fail', detail: '1 test file(s), reason=test-failures' },
        { id: 'lane:b', status: 'pass' },
      ],
    });
    expect(await refAt(project)).toBe('');
    const human = await cli(project, 'gate');
    expect(verdict(human)).toMatch(
      /^FIREFORGE-VERDICT: FAIL result=failed reason=gate-failed failed=lane:a commit=/
    );
    expect(json(await cli(project, 'gate', 'status', '--json'))).toMatchObject({
      relation: 'unverified',
      result: { pass: false },
    });
  }, 120_000);

  it('exits 1 when only the check is red, and skips every entry after a red build', async () => {
    const project = await patchProject(
      { lanes: [LANE_A] },
      {
        check: {
          extraSteps: [{ name: 'policy', command: [process.execPath, '-e', 'process.exit(1)'] }],
        },
      }
    );
    const checkRed = await cli(project, 'gate', '--json');
    expect(checkRed.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(json(checkRed)).toMatchObject({
      entries: [
        { id: 'check', status: 'fail', detail: 'failed: policy' },
        { id: 'build' },
        { id: 'lane:a', status: 'pass' },
      ],
    });

    await writeTree(project.engine, { '.mach-state/fail-build': '' });
    const buildRed = await cli(project, 'gate', '--json');
    expect(buildRed.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(json(buildRed)).toMatchObject({
      entries: [
        { id: 'check' },
        { id: 'build', status: 'fail' },
        { id: 'lane:a', status: 'skipped', detail: 'the build failed' },
      ],
    });
  }, 120_000);

  // A smoke start ends the browser through its process group, which Windows does not have.
  it.skipIf(process.platform === 'win32')(
    'runs stress entries, negative controls and smoke starts with their artifacts',
    async () => {
      const project = await patchProject({
        stress: [{ ...LANE_A, repeat: 2, uploadDir: true, env: { OUT_DIR: '{artifacts}/out' } }],
        controls: [
          { id: 'guard', diff: 'tools/guard.diff', test: A, assertions: ['the guard holds'] },
        ],
        runs: [
          {
            id: 'smoke',
            smokeExit: 1,
            headless: true,
            validate: { command: ['node', 'tools/judge.mjs', '{artifacts}/console.txt'] },
          },
        ],
      });
      await writeTree(project.root, {
        'tools/judge.mjs':
          'import { readFileSync } from "node:fs";\n' +
          'process.exit(readFileSync(process.argv[2], "utf8").includes("started") ? 0 : 1);\n',
      });
      await writeScriptMutation(
        project.engine,
        'mochitest',
        harness({ [A]: 'the guard holds' }),
        join(project.root, 'tools/guard.diff')
      );
      const commit = await commitAll(project.root, 'tools');
      const passed = await cli(project, 'gate', '--json');
      expect(passed.stderr).not.toContain('Error');
      expect(json(passed)).toMatchObject({
        outcome: 'verified',
        entries: [
          { id: 'check' },
          { id: 'build' },
          { id: 'stress:a', status: 'pass', detail: '1 test file(s) x 2' },
          { id: 'control:guard', status: 'pass', detail: 'caught' },
          { id: 'run:smoke', status: 'pass' },
        ],
      });
      const run = join(project.root, '.fireforge', 'gate', commit);
      expect(await readFile(join(run, 'run-smoke', 'console.txt'), 'utf8')).toContain('started');
      expect(await exists(join(run, 'stress-a', 'upload'))).toBe(true);
      expect(await exists(join(run, 'control-guard', 'results.json'))).toBe(true);
    },
    120_000
  );

  it('needs only the check for a documents-only commit, and moves the ref fast-forward only', async () => {
    const project = await patchProject({ lanes: [LANE_A], documents: ['docs/**', '*.md'] });
    expect((await cli(project, 'gate')).exitCode).toBe(ExitCode.SUCCESS);
    const first = await head(project);
    const calls = (await readMachLog(project.engine)).length;

    await writeTree(project.root, {
      'docs/guide/intro.txt': 'words\n',
      'tools/NOTES.md': 'more\n',
    });
    const documents = await commitAll(project.root, 'documents');
    const light = await cli(project, 'gate', '--json');
    expect(json(light)).toMatchObject({
      outcome: 'verified',
      basis: 'documents',
      entries: [{ id: 'check', status: 'pass' }],
    });
    expect(await refAt(project)).toBe(documents);
    expect(await readMachLog(project.engine)).toHaveLength(calls);

    await writeTree(project.root, { 'tools/script.mjs': 'export {};\n' });
    await commitAll(project.root, 'a tool');
    const ahead = json(await cli(project, 'gate', 'status', '--json'));
    expect(ahead).toMatchObject({ relation: 'ahead', ahead: 1, verified: documents });
    expect(json(await cli(project, 'gate', '--json'))).toMatchObject({ basis: 'run' });
    expect(await tests(project.engine)).toEqual([A, A]);

    await git(project.root, ['checkout', '--quiet', '-b', 'side', first]);
    await writeTree(project.root, { 'tools/other.mjs': 'export {};\n' });
    const side = await commitAll(project.root, 'another line of work');
    const refused = await cli(project, 'gate');
    expect(refused.exitCode).toBe(ExitCode.GIT_ERROR);
    expect(refused.stderr).toContain('--allow-rewrite');
    expect(json(await cli(project, 'gate', 'status', '--json'))).toMatchObject({
      relation: 'diverged',
    });
    expect((await cli(project, 'gate', '--allow-rewrite')).exitCode).toBe(ExitCode.SUCCESS);
    expect(await refAt(project)).toBe(side);
  }, 120_000);

  it('leaves the ref where a concurrent gate put it', async () => {
    const project = await patchProject(
      { lanes: [LANE_A] },
      {
        check: {
          extraSteps: [
            {
              name: 'another-gate',
              command: ['git', 'update-ref', REF, 'HEAD~1'],
            },
          ],
        },
      }
    );
    const first = await head(project);
    await writeTree(project.root, { 'tools/script.mjs': 'export {};\n' });
    await commitAll(project.root, 'a tool');
    const raced = await cli(project, 'gate');
    expect(raced.exitCode).toBe(ExitCode.GIT_ERROR);
    expect(raced.stderr).toContain('moved while the gate ran');
    expect(verdict(raced)).toBe('FIREFORGE-VERDICT: FAIL reason=gate-ref-moved');
    expect(await refAt(project)).toBe(first);
  }, 120_000);

  it('says in its help that --lane is feedback only', async () => {
    const help = (await runCli(['gate', '--help'], { cwd: dir() })).stdout.replace(/\s+/g, ' ');
    expect(help).toContain(
      '--lane is feedback only: it runs the named entries plus the build on the working tree as it is, ' +
        `committed or not, runs no check, records nothing and never moves ${REF}.`
    );
    expect(help).toContain(
      '--lane <id> Feedback only: run this declared entry (an ID, or kind:id) and the build on the ' +
        'working tree as it is, with no check, no record and no move of the verified ref'
    );
  });

  it('fails a control that goes red at other assertions as wrong-red, not as inconclusive', async () => {
    const project = await patchProject({
      controls: [{ id: 'guard', diff: 'tools/guard.diff', test: A, assertions: ['elsewhere'] }],
    });
    await writeTree(project.root, { 'tools/.keep': '' });
    await writeScriptMutation(
      project.engine,
      'mochitest',
      harness({ [A]: 'the guard holds' }),
      join(project.root, 'tools/guard.diff')
    );
    const wrong = await cli(project, 'gate', '--lane', 'control:guard', '--json');
    expect(wrong.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(json(wrong)).toMatchObject({
      entries: [
        { id: 'build' },
        {
          id: 'control:guard',
          status: 'fail',
          detail: 'wrong-red: expected "elsewhere"; the run was red at "the guard holds"',
        },
      ],
    });
    expect(wrong.stdout + wrong.stderr).not.toContain('inconclusive');
  }, 120_000);

  it('runs a named subset on the working tree for feedback and records nothing', async () => {
    const project = await patchProject({ lanes: [LANE_A, LANE_B] }, {}, harness({ [B]: 'boom' }));
    await writeTree(project.root, { 'notes.txt': 'uncommitted\n' });
    const green = await cli(project, 'gate', '--lane', 'a');
    expect(green.exitCode).toBe(ExitCode.SUCCESS);
    expect(verdict(green)).toBe('FIREFORGE-VERDICT: PASS result=feedback');
    expect(green.stdout).not.toMatch(/^check /m);
    const red = await cli(project, 'gate', '--lane', 'lane:b', '--json');
    expect(red.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(json(red)).toMatchObject({
      outcome: 'feedback',
      entries: [{ id: 'build' }, { id: 'lane:b', status: 'fail' }],
    });
    expect(await refAt(project)).toBe('');
    expect(await exists(join(project.root, '.fireforge', 'gate', await head(project)))).toBe(false);
    const unknown = await cli(project, 'gate', '--lane', 'nope');
    expect(unknown.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(unknown.stderr).toContain('Declared: lane:a, lane:b.');
  }, 120_000);
});

describe('fireforge gate in source mode', () => {
  it('stays pending until a person accepts, then verifies from the recorded pass', async () => {
    await seed();
    const project = await makeSourceProject(dir(), {
      files: { 'src/browser/base/content/panel.mjs': `${HEADER}export const panel = 1;\n` },
      config: {
        test: { mochitestPorts: 'auto' },
        gate: {
          lanes: [LANE_A],
          acceptance: [
            { id: 'visual', reason: 'A person looks at the scenes.', evidence: ['lane:a'] },
            { id: 'wording', reason: 'A person reads the strings.' },
          ],
        },
      },
    });
    const commit = await head(project);
    const engine = join(host().workspaces, 'w1', 'engine');

    const early = await cli(project, 'gate', 'accept', 'visual', '--note', 'looks right');
    expect(early.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(early.stderr).toContain('lane:a, which has no recorded pass for this commit');
    const undeclared = await cli(project, 'gate', 'accept', 'nope', '--note', 'x');
    expect(undeclared.exitCode).toBe(ExitCode.INVALID_ARGUMENT);

    const pending = await cli(project, 'gate');
    expect(pending.exitCode).toBe(ExitCode.SUCCESS);
    expect(pending.stdout).toContain('fireforge gate accept visual --note');
    expect(verdict(pending)).toBe(
      `FIREFORGE-VERDICT: PASS result=pending commit=${commit} accept=visual,wording`
    );
    expect(await refAt(project)).toBe('');
    expect(await tests(engine)).toEqual([A]);

    const accepted = await cli(
      project,
      'gate',
      'accept',
      'visual',
      '--note',
      'looks right',
      '--json'
    );
    expect(json(accepted)).toMatchObject({
      id: 'visual',
      commit,
      acceptance: { by: 'FireForge Tests', note: 'looks right' },
      pending: ['wording'],
    });
    expect(json(await cli(project, 'gate', '--json'))).toMatchObject({
      outcome: 'pending',
      basis: 'recorded',
      pending: ['wording'],
    });
    await cli(project, 'gate', 'accept', 'wording', '--note', 'reads well', '--by', 'An Editor');
    const status = json(await cli(project, 'gate', 'status', '--json'));
    expect(status).toMatchObject({
      relation: 'unverified',
      pending: [],
      accepted: { visual: { by: 'FireForge Tests' }, wording: { by: 'An Editor' } },
    });

    const verified = await cli(project, 'gate', '--json');
    expect(json(verified)).toMatchObject({ outcome: 'verified', basis: 'recorded' });
    expect(await refAt(project)).toBe(commit);
    // The recorded pass stood: nothing ran a second time.
    expect(await tests(engine)).toEqual([A]);
  }, 120_000);
});
