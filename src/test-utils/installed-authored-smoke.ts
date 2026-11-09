// SPDX-License-Identifier: EUPL-1.2
/**
 * Runs as plain JavaScript in the already installed tarball consumer, never through repository
 * source. It drives the installed CLI only: capture a source checkout, create a slot, run one
 * static job and read the verdict.
 */
const INSTALLED_AUTHORED_SMOKE = String.raw`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = join(process.cwd(), 'node_modules', ...__PACKAGE_SEGMENTS__, 'dist', 'bin', 'fireforge.js');
const base = join(process.cwd(), 'packaged-source-job');
const project = join(base, 'project');
const pristine = join(base, 'pristine');
const namespace = join(base, 'coordinator');
const exists = async (path) => {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(gitEnvironment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' });
const git = async (cwd, args) => (await exec('git', ['-c', 'core.hooksPath=' + devNull, ...args], { cwd, env: gitEnvironment, encoding: 'utf8' })).stdout.trim();
const fireforge = async (args) => {
  try {
    return (await exec(process.execPath, [cli, ...args], { cwd: project, env: gitEnvironment, encoding: 'utf8' })).stdout;
  } catch (error) {
    throw new Error('fireforge ' + args.join(' ') + ' failed:\n' + error.stdout + error.stderr, { cause: error });
  }
};
const put = async (root, path, text) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const commit = async (root) => {
  await git(root, ['add', '-A']);
  await git(root, ['-c', 'user.name=Package Fixture', '-c', 'user.email=package-fixture@example.invalid', 'commit', '-qm', 'fixture']);
};
const terminal = (job) => ['passed', 'failed', 'cancelled', 'interrupted'].includes(job.state);
const idle = async () => {
  const deadline = Date.now() + 90_000;
  while (await exists(join(namespace, 'endpoint.json')) || await exists(join(namespace, 'supervisor.lock'))) {
    if (Date.now() > deadline) throw new Error('Owned packaged supervisor did not release its namespace after terminal job cleanup: ' + namespace);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(join(base, 'owned-processes-settled'), 'idle\n');
};

await mkdir(project, { recursive: true });
await mkdir(pristine, { recursive: true });
await git(pristine, ['init', '--quiet']);
await put(pristine, 'browser/pristine.txt', 'immutable upstream\n');
await commit(pristine);
const pin = await git(pristine, ['rev-parse', 'HEAD']);
await git(project, ['init', '--quiet']);
await put(project, '.gitignore', 'engine/\n.fireforge/\n');
await put(project, 'package.json', JSON.stringify({ name: 'installed-source-fixture', private: true }));
await put(project, 'fireforge.json', JSON.stringify({
  name: 'Installed Fixture', vendor: 'Example', binaryName: 'fixture', appId: 'invalid.example.installed',
  firefox: { version: '153.6.0esr', product: 'firefox-esr', sha256: 'a'.repeat(64) },
  test: { reapOrphans: 'owned' },
  sources: { schemaVersion: 1, mode: 'authored', root: 'src', metadataRoot: '.fireforge-sources', pristineCommit: pin },
}));
await put(project, 'src/browser/installed.js', 'export const captured = true;\n');
await commit(project);
const editorHead = await git(project, ['rev-parse', 'HEAD']);
const editorIndex = await readFile(join(project, '.git/index'));
const donorHead = await git(pristine, ['rev-parse', 'HEAD']);
const donorIndex = await readFile(join(pristine, '.git/index'));
const snapshotFile = join(base, 'snapshot.json');
await fireforge(['authored', 'capture', '--out', snapshotFile, '--pristine-repository', pristine]);
const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
await put(project, 'src/browser/installed.js', 'export const captured = false;\n');
let job;
const view = async (command, id) => JSON.parse(await fireforge(['job', command, id, '--json', '--namespace', namespace]));
try {
  await fireforge([
    'slot', 'create', 'installed', '--snapshot', snapshotFile, '--pristine-repository', pristine,
    '--namespace', namespace,
  ]);
  await fireforge(['host', 'init', '--slots', '0', '--namespace', namespace]);
  const requestFile = join(base, 'request.json');
  await writeFile(requestFile, JSON.stringify({
    slot: 'installed',
    steps: [{ command: 'status', args: ['--json'] }],
    resources: { cpu: 1, memory: 1, build: 0, browser: 0, display: 0 },
    quiet: false,
  }));
  job = JSON.parse(await fireforge(['job', 'submit', requestFile, '--snapshot', snapshotFile, '--json', '--namespace', namespace]));
  job = await view('wait', job.id);
  const logs = { text: await readFile(join(namespace, 'logs', job.id + '.log'), 'utf8') };
  assert.equal(job.state, 'passed', JSON.stringify({ job, logs }));
  assert.ok(job.receipt, 'A passing packaged job must have sealed evidence');
  assert.equal(job.receipt.sourceId, snapshot.id);
  assert.equal(job.receipt.steps.length, 1);
  assert.equal(job.receipt.steps[0].command, 'status');
  assert.equal(job.receipt.steps[0].exitCode, 0);
  assert.ok(logs.text.includes('"authority":"authored"'));
  assert.ok(logs.text.includes(snapshot.id));
  assert.equal(await git(project, ['rev-parse', 'HEAD']), editorHead);
  assert.deepEqual(await readFile(join(project, '.git/index')), editorIndex);
  assert.equal(await git(pristine, ['rev-parse', 'HEAD']), donorHead);
  assert.deepEqual(await readFile(join(pristine, '.git/index')), donorIndex);
  process.stdout.write('FIREFORGE-PACKAGED-SOURCE-JOB: ' + JSON.stringify({ state: job.state, sourceId: snapshot.id, sealed: true, logged: true }) + '\n');
} finally {
  if (job && !terminal(job)) {
    await fireforge(['job', 'cancel', job.id, '--namespace', namespace]);
    job = await view('wait', job.id);
    assert.ok(terminal(job), 'Fixture cancellation must settle before cleanup');
  }
  await idle();
}
`;

/** Substitute only the package path; fixtures execute entirely under the consumer. */
export function installedAuthoredSmokeSource(packageName: string): string {
  return INSTALLED_AUTHORED_SMOKE.replace(
    '__PACKAGE_SEGMENTS__',
    JSON.stringify(packageName.split('/'))
  );
}
