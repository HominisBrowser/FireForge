// SPDX-License-Identifier: EUPL-1.2
/**
 * `gate` through the CLI over the stand-in mach, in each mode: what it
 * refuses, what a pass and a red record, when the verified ref moves, the
 * decisions people record, documents-only commits and feedback runs.
 */
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_LICENSE } from '../config/index.js';
import { ExitCode } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { acquireLock } from '../kernel/lock.js';
import { type HostPaths, hostPaths, licenseHeader } from '../project/index.js';
import { type CliResult, runCli } from '../testing/cli.js';
import {
  makeEngineProject,
  makeSourceProject,
  seedPristine,
  useMachSandbox,
} from '../testing/engine.js';
import { type MachScript, readMachLog, SYNTHETIC_FIREFOX_PATHS } from '../testing/firefox.js';
import { commitAll, git, initRepo } from '../testing/git.js';
import {
  harnessScript,
  TEST_ENGINE_FILES,
  TEST_PATHS,
  writeScriptMutation,
} from '../testing/harness.js';
import { useTempDir, writeTree } from '../testing/temp.js';

// A loaded host, whatever this one is doing: the note on a red entry is then deterministic.
vi.mock('../check/hostLoad.js', () => ({
  sampleLoad: () => ({ load: 60, cpus: 4 }),
  busiestOutsider: () => Promise.resolve({ pid: 4242, name: 'clang', cpu: 310 }),
}));

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
    '.mach-state/script-run.json': JSON.stringify({
      stdout: [' 0:00.10 /obj/dist/bin/testbrowser -profile /tmp/p', 'console.log: started'],
      sleep: 60,
    }),
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

/** A control's diff: the harness script as `script` says, and the front-end file as `title` says. */
async function writeControl(
  project: { root: string; engine: string },
  path: string,
  script: MachScript,
  title?: string
): Promise<void> {
  await writeScriptMutation(project.engine, 'mochitest', script, join(project.root, path));
  if (title === undefined) return;
  await appendFile(
    join(project.root, path),
    [
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js',
      '--- a/browser/base/content/browser.js',
      '+++ b/browser/base/content/browser.js',
      '@@ -1 +1 @@',
      '-export const browserTitle = "baseline";',
      `+export const browserTitle = "${title}";`,
      '',
    ].join('\n')
  );
}

const buildCalls = async (engine: string): Promise<number> =>
  (await readMachLog(engine)).filter((call) => call.args[0] === 'build').length;

const guard = (id: string, test: string, assertion: string): Record<string, unknown> => ({
  id,
  diff: `tools/${id}.diff`,
  test,
  assertions: [assertion],
});

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

  it('judges a control on an engine file the change does not touch, however wide the change is', async () => {
    const scratch = join(dir(), 'scratch');
    await writeTree(scratch, { '.mach-state/script-mochitest.json': JSON.stringify(harness()) });
    await writeScriptMutation(
      scratch,
      'mochitest',
      harness({ [A]: 'the guard holds' }),
      join(dir(), 'guard.diff')
    );
    await seed();
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `src/browser/base/content/wide-${index}.mjs`,
        `${HEADER}export const wide = ${index};\n`,
      ])
    );
    const project = await makeSourceProject(dir(), {
      files: { ...wide, 'tools/guard.diff': await readFile(join(dir(), 'guard.diff'), 'utf8') },
      config: {
        test: { mochitestPorts: 'auto' },
        gate: {
          controls: [
            { id: 'guard', diff: 'tools/guard.diff', test: A, assertions: ['the guard holds'] },
          ],
        },
      },
    });
    const full = await cli(project, 'gate', '--json');
    expect(full.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(full)).toMatchObject({
      outcome: 'verified',
      entries: [{ id: 'check' }, { id: 'build' }, { id: 'control:guard', detail: 'caught' }],
    });
    const adHoc = await cli(
      project,
      'test',
      A,
      '--control',
      'tools/guard.diff',
      '--expect',
      'the guard holds'
    );
    expect(adHoc.exitCode).toBe(ExitCode.SUCCESS);
    expect(verdict(adHoc)).toMatch(/ control=caught/);
  }, 120_000);
});

describe('fireforge gate and its checkout', () => {
  const STRAY = [
    process.execPath,
    '-e',
    "if (require('fs').existsSync('.fireforge/arm')) require('fs').writeFileSync('stray.txt', 'x')",
  ];

  it('refuses the result of a documents-only gate whose check moved the checkout', async () => {
    const project = await patchProject(
      { lanes: [LANE_A], documents: ['docs/**'] },
      { check: { extraSteps: [{ name: 'stray', command: STRAY }] } }
    );
    expect((await cli(project, 'gate')).exitCode).toBe(ExitCode.SUCCESS);
    const verified = await refAt(project);

    await writeTree(project.root, { 'docs/intro.txt': 'words\n', '.fireforge/arm': '' });
    await commitAll(project.root, 'documents');
    const moved = await cli(project, 'gate');
    expect(moved.exitCode).toBe(ExitCode.INCONCLUSIVE);
    expect(moved.stderr).toContain('gate-tree-moved');
    expect(verdict(moved)).toBe('FIREFORGE-VERDICT: FAIL reason=gate-tree-moved');
    expect(await refAt(project)).toBe(verified);
  }, 120_000);

  it('reuses nothing of a run whose checkout moved under it', async () => {
    const project = await patchProject(
      { lanes: [LANE_A] },
      { check: { extraSteps: [{ name: 'stray', command: STRAY }] } }
    );
    await writeTree(project.root, { '.fireforge/arm': '' });
    const moved = await cli(project, 'gate');
    expect(moved.exitCode).toBe(ExitCode.INCONCLUSIVE);
    expect(moved.stderr).toContain('gate-tree-moved');

    await rm(join(project.root, 'stray.txt'));
    await rm(join(project.root, '.fireforge', 'arm'));
    const again = await cli(project, 'gate', '--resume', '--json');
    expect(again.exitCode).toBe(ExitCode.SUCCESS);
    const report = JSON.parse(again.stdout) as { resume?: { reused: string[] } };
    expect(report.resume?.reused).toEqual([]);
  }, 120_000);

  it('ends with the lock-timeout exit code, not as a bad commit, when a lock inside an entry does not come free', async () => {
    const project = await patchProject({
      lanes: [{ id: 'shown', files: [A], headed: true }, LANE_B],
    });
    const display = await acquireLock(join(host().locks, 'display'), { label: 'display' });
    let blocked: CliResult;
    try {
      blocked = await cli(project, 'gate', '--wait-lock', '1', '--json');
    } finally {
      await display.release();
    }
    expect(blocked.exitCode).toBe(ExitCode.LOCK_TIMEOUT);
    expect(json(blocked)).toMatchObject({
      outcome: 'failed',
      entries: [
        { id: 'check', status: 'pass' },
        { id: 'build', status: 'pass' },
        { id: 'lane:shown', status: 'fail', blocked: 'lock-timeout' },
        { id: 'lane:b', status: 'pass' },
      ],
    });
    expect(blocked.stderr).toContain('error[lock-timeout]');
    const human = await cli(project, 'gate', '--wait-lock', '1');
    expect(human.exitCode).toBe(ExitCode.SUCCESS);
    expect(await refAt(project)).toBe(await head(project));
  }, 120_000);

  it('reports blocked entries on the verdict line', async () => {
    const project = await patchProject({ lanes: [{ id: 'shown', files: [A], headed: true }] });
    const display = await acquireLock(join(host().locks, 'display'), { label: 'display' });
    let blocked: CliResult;
    try {
      blocked = await cli(project, 'gate', '--wait-lock', '1');
    } finally {
      await display.release();
    }
    expect(blocked.exitCode).toBe(ExitCode.LOCK_TIMEOUT);
    expect(blocked.stdout).toMatch(/^lane:shown +blocked /m);
    expect(verdict(blocked)).toMatch(
      /^FIREFORGE-VERDICT: FAIL result=failed reason=lock-timeout failed=lane:shown blocked=lane:shown commit=/
    );
  }, 120_000);
});

describe('fireforge gate and negative controls', () => {
  /** A project declaring controls on the front-end file and the harness, committed with their diffs. */
  async function controlProject(
    gate: Record<string, unknown>,
    config: Record<string, unknown> = {}
  ): Promise<{ root: string; engine: string }> {
    const project = await patchProject({ documents: ['docs/**'], ...gate }, config, harness());
    await writeTree(project.root, { 'tools/.keep': '' });
    await writeControl(project, 'tools/one.diff', harness({ [A]: 'one holds' }), 'one');
    await writeControl(project, 'tools/two.diff', harness({ [B]: 'two holds' }), 'two');
    await writeControl(project, 'tools/three.diff', harness({ [A]: 'three holds' }), 'three');
    await commitAll(project.root, 'controls');
    return project;
  }

  const ONE = guard('one', A, 'one holds');
  const TWO = guard('two', B, 'two holds');
  const THREE = guard('three', A, 'three holds');
  const entry = (result: CliResult, id: string): Record<string, unknown> | undefined =>
    (json(result)['entries'] as Record<string, unknown>[]).find(
      (candidate) => candidate['id'] === id
    );

  it('runs every control of a kind in one workspace, one verdict each, and builds the restored engine once', async () => {
    const project = await controlProject({
      controls: [ONE, TWO, { ...THREE, assertions: ['elsewhere'] }],
    });
    const before = await buildCalls(project.engine);
    const ran = await cli(project, 'gate', '--lane', 'control:*', '--json');
    expect(ran.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(json(ran)).toMatchObject({ outcome: 'feedback', pass: false });
    expect(entry(ran, 'control:one')).toMatchObject({ status: 'pass', control: 'caught' });
    expect(entry(ran, 'control:two')).toMatchObject({ status: 'pass', control: 'caught' });
    expect(entry(ran, 'control:three')).toMatchObject({
      status: 'fail',
      control: 'wrong-red',
      detail: 'wrong-red: expected "elsewhere"; the run was red at "three holds"',
    });
    expect((json(ran)['entries'] as unknown[]).length).toBe(4);

    // The gate's build, one build per mutation, and one for the restored engine
    // (not one after each control).
    expect((await buildCalls(project.engine)) - before).toBe(1 + 3 + 1);
    // One and three test the same file on the same engine state: its green run is not repeated.
    expect((await tests(project.engine)).length).toBe(5);
    expect(
      await readFile(join(project.engine, SYNTHETIC_FIREFOX_PATHS.browserScript), 'utf8')
    ).toBe('export const browserTitle = "baseline";\n');
    // The workspace holds no mutated build: a test run needs no build first.
    expect((await cli(project, 'test', A)).exitCode).toBe(ExitCode.SUCCESS);

    const lanes = await cli(project, 'gate', '--lane', 'lane:*');
    expect(lanes.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(lanes.stderr).toContain('The gate declares no "lane:*"');
  }, 120_000);

  it('judges a control on an engine file the change does not touch, however wide the change is', async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`tools/wide/file-${index}.mjs`, `export {};\n`])
    );
    const project = await controlProject({ controls: [ONE], lanes: [LANE_A] });
    await writeTree(project.root, wide);
    await commitAll(project.root, 'a wide change');
    const feedback = await cli(project, 'gate', '--lane', 'control:one', '--json');
    expect(entry(feedback, 'control:one')).toMatchObject({ status: 'pass', control: 'caught' });
    const full = await cli(project, 'gate', '--json');
    expect(full.exitCode).toBe(ExitCode.SUCCESS);
    expect(entry(full, 'control:one')).toMatchObject({ status: 'pass', control: 'caught' });
    const adHoc = await cli(
      project,
      'test',
      A,
      '--control',
      join(project.root, 'tools/one.diff'),
      '--expect',
      'one holds'
    );
    expect(adHoc.exitCode).toBe(ExitCode.SUCCESS);
    expect(verdict(adHoc)).toMatch(/ control=caught /);
  }, 120_000);

  it('remembers what was seen red and lists the controls still owed, each with its reason', async () => {
    const project = await controlProject({ controls: [ONE, TWO, THREE], lanes: [LANE_A] });
    const status = async (): Promise<Record<string, string>> =>
      Object.fromEntries(
        (
          json(await cli(project, 'gate', 'status', '--json'))['controls'] as {
            id: string;
            reason: string;
          }[]
        ).map((owed) => [owed.id, owed.reason])
      );
    expect(await status()).toEqual({ one: 'never-run', two: 'never-run', three: 'never-run' });
    const human = await cli(project, 'gate', 'status');
    expect(human.stdout).toContain('Controls owed a run (3):');
    expect(human.stdout).toContain('control:one  never-run');

    // A feedback run on the committed tree is seen, and so is an ad hoc run of a declaration.
    await cli(project, 'gate', '--lane', 'control:one');
    await cli(project, 'test', B, '--control', 'tools/two.diff', '--expect', 'two holds');
    expect(await status()).toEqual({ three: 'never-run' });
    const recorded = JSON.parse(
      await readFile(join(project.root, '.fireforge', 'gate', 'controls.json'), 'utf8')
    ) as { runs: Record<string, unknown>[] };
    expect(recorded.runs).toMatchObject([
      { source: 'feedback', id: 'one', outcome: 'caught', red: ['one holds'], unexpected: [] },
      { source: 'test', outcome: 'caught', tests: [B], expect: ['two holds'] },
    ]);
    expect(recorded.runs[0]).toMatchObject({
      diff: { path: 'tools/one.diff' },
      against: { commit: await head(project) },
    });

    // Informs, never blocks: a green feedback run still passes while a control is owed.
    const green = await cli(project, 'gate', '--lane', 'lane:a');
    expect(green.exitCode).toBe(ExitCode.SUCCESS);
    expect(green.stdout).toContain('control:three  never-run');
    expect(verdict(green)).toBe('FIREFORGE-VERDICT: PASS result=feedback controls-owed=three');

    // Green with the mutation (missed), and red beyond the expectation (wrong-red).
    await writeControl(project, 'tools/three.diff', harness(), undefined);
    await writeControl(project, 'tools/one.diff', harness({ [A]: 'something else' }), 'one');
    await commitAll(project.root, 'two controls that do not hold');
    expect(await status()).toEqual({ one: 'changed', three: 'never-run' });
    const red = await cli(project, 'gate', '--lane', 'control:*');
    expect(red.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(await status()).toEqual({ one: 'wrong-red', three: 'missed' });
    const after = await cli(project, 'gate', 'status', '--json');
    expect(json(after)['controls']).toMatchObject([
      {
        id: 'one',
        reason: 'wrong-red',
        detail: expect.stringContaining('"something else"') as string,
      },
      { id: 'three', reason: 'missed' },
    ]);
  }, 180_000);

  it('keeps the proof of the product code when only a control diff changed, and runs that control', async () => {
    const project = await controlProject({ controls: [ONE, TWO], lanes: [LANE_A] });
    const first = await cli(project, 'gate', '--json');
    expect(json(first)).toMatchObject({ outcome: 'verified', basis: 'run' });
    const laneRuns = (await tests(project.engine)).length;

    // Only the diff of `one` changed: check, the build and `one` run; the lane and `two` do not.
    await writeControl(
      project,
      'tools/one.diff',
      { ...harness({ [A]: 'one holds' }), sleep: 0 },
      'one'
    );
    const edited = await commitAll(project.root, 'edit a control');
    const light = await cli(project, 'gate', '--json');
    expect(light.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(light)).toMatchObject({
      outcome: 'verified',
      basis: 'controls',
      pending: [],
      entries: [
        { id: 'check', status: 'pass' },
        { id: 'build', status: 'pass' },
        { id: 'control:one', status: 'pass', control: 'caught' },
      ],
    });
    expect(await refAt(project)).toBe(edited);
    expect((await tests(project.engine)).length - laneRuns).toBeLessThanOrEqual(2);
    const run = join(project.root, '.fireforge', 'gate', edited);
    expect(await exists(join(run, 'control-one', 'results.json'))).toBe(true);
    // A partial run stands for nothing but itself: no recorded result for the commit.
    expect(await exists(join(run, 'result.json'))).toBe(false);
    expect(json(await cli(project, 'gate', 'status', '--json'))['controls']).toEqual([]);

    // A control added by fireforge.json alone runs, and nothing else does.
    await writeControl(project, 'tools/three.diff', harness({ [A]: 'three holds' }), 'three');
    const raw = JSON.parse(await readFile(join(project.root, 'fireforge.json'), 'utf8')) as {
      gate: { controls: unknown[] };
    };
    raw.gate.controls.push(THREE);
    await writeTree(project.root, { 'fireforge.json': JSON.stringify(raw) });
    const added = await commitAll(project.root, 'declare a third control');
    const third = await cli(project, 'gate', '--json');
    expect(json(third)).toMatchObject({
      outcome: 'verified',
      basis: 'controls',
      entries: [{ id: 'check' }, { id: 'build' }, { id: 'control:three', status: 'pass' }],
    });
    expect(await refAt(project)).toBe(added);

    // A red control keeps the ref where it was.
    await writeControl(project, 'tools/two.diff', harness(), 'two');
    await commitAll(project.root, 'a control that misses');
    const missed = await cli(project, 'gate');
    expect(missed.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(missed.stdout).toMatch(/^control:two +fail .*missed/m);
    expect(await refAt(project)).toBe(added);
    expect(verdict(missed)).toMatch(
      /^FIREFORGE-VERDICT: FAIL result=failed reason=gate-failed failed=control:two commit=\w+ controls-owed=two$/
    );

    // Product code in the change takes the full run.
    await writeTree(project.root, { 'tools/script.mjs': 'export {};\n' });
    await writeControl(project, 'tools/two.diff', harness({ [B]: 'two holds' }), 'two');
    await commitAll(project.root, 'product and control');
    expect(json(await cli(project, 'gate', '--json'))).toMatchObject({ basis: 'run' });
  }, 240_000);

  it('takes the full run when a person accepted on the output of the control that changed', async () => {
    const project = await controlProject({
      controls: [ONE],
      lanes: [LANE_A],
      acceptance: [{ id: 'visual', reason: 'Looked at it', evidence: ['control:one'] }],
    });
    expect(json(await cli(project, 'gate', '--json'))).toMatchObject({ outcome: 'pending' });
    await cli(project, 'gate', 'accept', 'visual', '--note', 'fine');
    expect(json(await cli(project, 'gate', '--json'))).toMatchObject({ outcome: 'verified' });
    await writeControl(
      project,
      'tools/one.diff',
      { ...harness({ [A]: 'one holds' }), sleep: 0 },
      'one'
    );
    await commitAll(project.root, 'edit the control');
    expect(json(await cli(project, 'gate', '--json'))).toMatchObject({
      basis: 'run',
      outcome: 'pending',
      pending: ['visual'],
    });
  }, 240_000);

  it('keeps the proof when only the commit message of the verified commit changed', async () => {
    const project = await patchProject({ lanes: [LANE_A] });
    expect((await cli(project, 'gate')).exitCode).toBe(ExitCode.SUCCESS);
    const verifiedTree = (await git(project.root, ['rev-parse', `${REF}^{tree}`])).trim();
    const calls = (await readMachLog(project.engine)).length;

    await git(project.root, ['commit', '--amend', '--quiet', '-m', 'A better message']);
    expect((await git(project.root, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe(verifiedTree);
    const refused = await cli(project, 'gate');
    expect(refused.exitCode).toBe(ExitCode.GIT_ERROR);
    expect(refused.stderr).toContain('--allow-rewrite');

    const reworded = await cli(project, 'gate', '--allow-rewrite', '--json');
    expect(json(reworded)).toMatchObject({ outcome: 'verified', basis: 'documents' });
    expect(await refAt(project)).toBe(await head(project));
    expect(await readMachLog(project.engine)).toHaveLength(calls);
  }, 120_000);
});

describe('fireforge gate that outlives its caller', () => {
  const HOLD =
    'import { existsSync, writeFileSync } from "node:fs";\n' +
    'const [, , ready, go] = process.argv;\n' +
    'writeFileSync(ready, "ready");\n' +
    'const until = Date.now() + 90000;\n' +
    'while (!existsSync(go) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));\n';

  const until = async (done: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('shows the running gate, its entry, and makes a second gate on the commit wait instead of duplicating', async () => {
    const hold = {
      ...LANE_A,
      validate: { command: ['node', 'tools/hold.mjs', '{artifacts}/ready', '{artifacts}/go'] },
    };
    const project = await patchProject({ lanes: [hold, LANE_B] });
    await writeTree(project.root, { 'tools/hold.mjs': HOLD });
    const commit = await commitAll(project.root, 'a lane that waits');
    const lane = join(project.root, '.fireforge', 'gate', commit, 'lane-a');

    const first = cli(project, 'gate', '--json');
    await until(() => exists(join(lane, 'ready')));

    const status = json(await cli(project, 'gate', 'status', '--json'));
    expect(status['running']).toMatchObject([
      {
        pid: process.pid,
        kind: 'full',
        commit,
        onHead: true,
        entry: { id: 'lane:a', position: 3, total: 4 },
      },
    ]);
    const human = await cli(project, 'gate', 'status');
    expect(human.stdout).toMatch(
      new RegExp(
        `A gate of HEAD \\(${commit.slice(0, 12)}\\) is running in this checkout: PID ${process.pid}, since \\S+, on lane:a \\(entry 3 of 4, since \\S+\\)\\.`
      )
    );

    const buildsBefore = await buildCalls(project.engine);
    const second = await cli(project, 'gate', '--wait-lock', '0');
    expect(second.exitCode).toBe(ExitCode.LOCK_TIMEOUT);
    expect(second.stderr).toContain('A gate of this commit is already running');
    expect(second.stderr).toContain('same commit');
    expect(await buildCalls(project.engine)).toBe(buildsBefore);

    await writeFile(join(lane, 'go'), '');
    const done = await first;
    expect(done.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(done)).toMatchObject({ outcome: 'verified' });
    expect(json(await cli(project, 'gate', 'status', '--json'))['running']).toEqual([]);
    expect(await exists(join(project.root, '.fireforge', 'gate', commit, 'progress.json'))).toBe(
      false
    );
  }, 120_000);
});

describe('fireforge gate --resume', () => {
  const entriesOf = (result: CliResult): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      (json(result)['entries'] as Record<string, unknown>[]).map((entry) => [
        String(entry['id']),
        entry,
      ])
    );

  /** A lane that is red while its flag file `.fireforge/<name>` exists, so a test can mend it without a new commit. */
  const flaky = (id: string, file: string, name: string): Record<string, unknown> => ({
    id,
    files: [file],
    validate: { command: ['node', 'tools/judge.mjs', `.fireforge/${name}`] },
  });

  async function flakyProject(
    names: readonly ('a' | 'b')[],
    gate: Record<string, unknown> = {}
  ): Promise<{ root: string; engine: string }> {
    const project = await patchProject({
      lanes: [
        names.includes('a') ? flaky('a', A, 'flaky-a') : LANE_A,
        names.includes('b') ? flaky('b', B, 'flaky-b') : LANE_B,
      ],
      ...gate,
    });
    await writeTree(project.root, {
      'tools/judge.mjs':
        'import { existsSync } from "node:fs";\nprocess.exit(existsSync(process.argv[2]) ? 1 : 0);\n',
    });
    await commitAll(project.root, 'a judge');
    await writeTree(
      project.root,
      Object.fromEntries(names.map((name) => [`.fireforge/flaky-${name}`, '']))
    );
    return project;
  }

  const mend = (project: { root: string }, name: string): Promise<void> =>
    rm(join(project.root, '.fireforge', `flaky-${name}`));

  it('runs again only what was red, keeps the artifacts and marks what it reused', async () => {
    const project = await flakyProject(['a'], {
      acceptance: [{ id: 'visual', reason: 'Look at lane b', evidence: ['lane:b'] }],
    });
    const red = await cli(project, 'gate');
    expect(red.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(red.stdout).toMatch(/^lane:a +fail .*host load 60 at the start/m);
    const commit = await head(project);
    expect(await tests(project.engine)).toEqual([A, B]);
    await mend(project, 'a');

    const resumed = await cli(project, 'gate', '--resume');
    expect(resumed.exitCode).toBe(ExitCode.SUCCESS);
    expect(resumed.stderr).toContain('Resuming the finished run of');
    expect(resumed.stdout).toMatch(/^lane:b +pass .*\[reused: it ran \d{4}-/m);
    expect(resumed.stdout).toMatch(/^lane:a +pass +\S+ +1 test file\(s\)$/m);
    expect(resumed.stdout).toContain(
      '1 entry reused from an earlier run of this commit, not run again: lane:b.'
    );
    expect(verdict(resumed)).toBe(
      `FIREFORGE-VERDICT: PASS result=pending commit=${commit} reused=lane:b accept=visual`
    );
    // check and the build ran again; lane b did not.
    expect(await tests(project.engine)).toEqual([A, B, A]);
    expect(await buildCalls(project.engine)).toBe(2);
    const run = join(project.root, '.fireforge', 'gate', commit);
    expect(await exists(join(run, 'lane-b', 'output.log'))).toBe(true);
    expect(await exists(join(run, 'progress.json'))).toBe(false);

    const result = JSON.parse(await readFile(join(run, 'result.json'), 'utf8')) as {
      pass: boolean;
      entries: { id: string; reused?: boolean; ranAt?: string }[];
    };
    expect(result.pass).toBe(true);
    const lanes = Object.fromEntries(result.entries.map((entry) => [entry.id, entry]));
    expect(lanes['lane:b']).toMatchObject({ reused: true, ranAt: expect.any(String) as string });
    expect(lanes['lane:a']?.reused).toBeUndefined();
    expect(lanes['check']?.reused).toBeUndefined();

    // Evidence for an acceptance stands on the reused entry, and the pass verifies as a full result.
    const accepted = await cli(project, 'gate', 'accept', 'visual', '--note', 'fine');
    expect(accepted.exitCode).toBe(ExitCode.SUCCESS);
    const final = await cli(project, 'gate', '--json');
    expect(json(final)).toMatchObject({ outcome: 'verified', basis: 'recorded' });
    expect(entriesOf(final)['lane:b']).toMatchObject({ reused: true });
    expect(await refAt(project)).toBe(commit);
    expect(await tests(project.engine)).toEqual([A, B, A]);
  }, 240_000);

  it('continues a gate that was killed from the entries it recorded', async () => {
    const project = await flakyProject(['b']);
    expect((await cli(project, 'gate')).exitCode).toBe(ExitCode.BUILD_ERROR);
    const commit = await head(project);
    const run = join(project.root, '.fireforge', 'gate', commit);
    const result = JSON.parse(await readFile(join(run, 'result.json'), 'utf8')) as {
      entries: { id: string }[];
    } & Record<string, unknown>;
    // The state a kill at lane b leaves: what ended before it, and no result.
    await rm(join(run, 'result.json'));
    await writeFile(
      join(run, 'progress.json'),
      JSON.stringify({
        commit,
        tree: result['tree'],
        tool: result['tool'],
        declaration: result['declaration'],
        pid: 2 ** 22 - 1,
        startedAt: new Date().toISOString(),
        full: true,
        total: 4,
        current: { id: 'lane:b', position: 4, since: new Date().toISOString() },
        entries: result.entries.filter((entry) => entry.id !== 'lane:b'),
      })
    );
    const status = json(await cli(project, 'gate', 'status', '--json'));
    expect(status['running']).toEqual([]);
    await mend(project, 'b');

    const resumed = await cli(project, 'gate', '--resume', '--json');
    expect(resumed.stderr).toContain('Resuming the interrupted run of');
    expect(resumed.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(resumed)).toMatchObject({
      outcome: 'verified',
      resume: { reused: ['lane:a'], why: null },
    });
    expect(await tests(project.engine)).toEqual([A, B, B]);
  }, 240_000);

  it('says why and runs everything when the recorded run does not match', async () => {
    const project = await flakyProject(['a']);
    expect((await cli(project, 'gate')).exitCode).toBe(ExitCode.BUILD_ERROR);
    const commit = await head(project);
    const path = join(project.root, '.fireforge', 'gate', commit, 'result.json');
    const result = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...result, tool: '0.0.0-other' }));

    const again = await cli(project, 'gate', '--resume', '--json');
    expect(again.stderr).toContain(
      'Not resuming: the recorded run was made by FireForge 0.0.0-other'
    );
    expect(json(again)).toMatchObject({
      resume: { reused: [], why: expect.stringContaining('0.0.0-other') as string },
    });
    expect(await tests(project.engine)).toEqual([A, B, A, B]);
  }, 240_000);

  it('reuses nothing once a control diff git does not track holds something else', async () => {
    const project = await flakyProject(['a'], {
      controls: [
        { id: 'guard', diff: '.fireforge/guard.diff', test: A, assertions: ['the guard holds'] },
      ],
    });
    await writeTree(project.root, { '.fireforge/guard.diff': 'one mutation\n' });
    expect((await cli(project, 'gate')).exitCode).not.toBe(ExitCode.SUCCESS);
    await mend(project, 'a');
    // The tree is the same commit, and the control now names another mutation.
    await writeTree(project.root, { '.fireforge/guard.diff': 'another mutation\n' });

    const resumed = await cli(project, 'gate', '--resume', '--json');
    expect(json(resumed)).toMatchObject({
      resume: { reused: [], why: expect.stringContaining('declaration') as string },
    });
  }, 120_000);

  it('has nothing to resume on a commit no gate ran on', async () => {
    const project = await patchProject({ lanes: [LANE_A] });
    const fresh = await cli(project, 'gate', '--resume', '--json');
    expect(json(fresh)).toMatchObject({
      outcome: 'verified',
      resume: { reused: [], why: 'no full run of this commit is recorded in this checkout' },
    });
  }, 120_000);

  it('runs as it always did without --resume, and refuses it beside --lane', async () => {
    const project = await flakyProject(['a']);
    expect((await cli(project, 'gate')).exitCode).toBe(ExitCode.BUILD_ERROR);
    await mend(project, 'a');
    const again = await cli(project, 'gate', '--json');
    expect(json(again)).toMatchObject({ outcome: 'verified', resume: null });
    expect(entriesOf(again)['lane:b']?.['reused']).toBeUndefined();
    expect(await tests(project.engine)).toEqual([A, B, A, B]);
    const refused = await cli(project, 'gate', '--lane', 'a', '--resume');
    expect(refused.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
  }, 240_000);
});

describe('fireforge gate and the host load', () => {
  it('notes the load on a red entry in the line and the JSON, and judges nothing by it', async () => {
    const project = await patchProject({ lanes: [LANE_A, LANE_B] }, {}, harness({ [A]: 'boom' }));
    const red = await cli(project, 'gate', '--json');
    expect(red.exitCode).toBe(ExitCode.BUILD_ERROR);
    const entries = (json(red)['entries'] as Record<string, unknown>[]).map((entry) => entry);
    expect(entries.find((entry) => entry['id'] === 'lane:a')).toMatchObject({
      status: 'fail',
      load: { cpus: 4, start: 60, end: 60, busiest: { pid: 4242, name: 'clang', cpu: 310 } },
    });
    expect(entries.find((entry) => entry['id'] === 'lane:b')?.['load']).toBeUndefined();
    expect(entries.find((entry) => entry['id'] === 'build')?.['load']).toBeUndefined();
    const human = await cli(project, 'gate');
    expect(human.stdout).toContain(
      'host load 60 at the start, 60 at the end, on 4 CPUs (above the CPU count); busiest process outside this command: clang (PID 4242, 310% CPU)'
    );
    expect(verdict(human)).toMatch(
      /^FIREFORGE-VERDICT: FAIL result=failed reason=gate-failed failed=lane:a /
    );
  }, 240_000);
});
