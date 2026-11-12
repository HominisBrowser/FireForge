// SPDX-License-Identifier: EUPL-1.2
/**
 * Drives real Firefox source and a real mach through the built CLI
 * (dist/bin/fireforge.js), once per project mode, in projects this script
 * creates. It is a smoke of the command sequence a fork runs, not a test of
 * the browser that comes out.
 *
 * Patch mode: setup, download, bootstrap, import, build, test; then an edit
 * of one engine file is exported as a patch, `reset --yes` drops it from the
 * engine, and `import` must bring it back; `verify` closes. The patch is
 * deleted and the edit discarded afterwards, so the project is reused by the
 * next run and its build stays warm.
 *
 * Source mode: setup (which pins the pristine commit), git init and commit,
 * download, bootstrap, `override` of one upstream file plus an edit of the
 * owned copy, build (which materializes the edit into a pool workspace, where
 * it must arrive), test, and `export --out`, whose generated queue must name
 * the file. The project is recreated each run; its build lives in the host
 * pool.
 *
 * Covered: every step exits 0 against real Firefox, the edit reaches the
 * engine in both modes, and the exported patch or queue names the edited
 * file. Not covered: launching the built browser, packaging, rebase, migrate,
 * gate and its lanes, Furnace, lint and typecheck rules, failure and recovery
 * paths, and any test beyond the one path given.
 *
 * Environment:
 *   FIREFORGE_FULL_WORK_DIR         where the projects and the run artifacts
 *                                   live (default: a new temporary directory)
 *   FIREFORGE_FULL_MODES            comma-separated modes (default patches,source)
 *   FIREFORGE_FULL_FIREFOX_VERSION  the Firefox to build on (default 140.0esr)
 *   FIREFORGE_FULL_TARGET_FILE      engine file to edit
 *                                   (default browser/base/content/browser.js)
 *   FIREFORGE_FULL_TEST_PATH        test to run
 *                                   (default toolkit/modules/tests/xpcshell/test_Log.js)
 *   FIREFORGE_FULL_SKIP_BOOTSTRAP   1 skips mach bootstrap, for a host that
 *                                   already has the toolchain
 *   FIREFORGE_HOME                  host state (pristine repositories, the
 *                                   workspace pool), as for the CLI
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fireforgeBin = fileURLToPath(new URL('../dist/bin/fireforge.js', import.meta.url));
const workDir =
  process.env.FIREFORGE_FULL_WORK_DIR ||
  (await mkdtemp(join(tmpdir(), 'fireforge-full-integration-')));
const modes = (process.env.FIREFORGE_FULL_MODES || 'patches,source')
  .split(',')
  .map((mode) => mode.trim())
  .filter(Boolean);
const firefoxVersion = process.env.FIREFORGE_FULL_FIREFOX_VERSION || '140.0esr';
const targetFile = process.env.FIREFORGE_FULL_TARGET_FILE || 'browser/base/content/browser.js';
const testPath =
  process.env.FIREFORGE_FULL_TEST_PATH || 'toolkit/modules/tests/xpcshell/test_Log.js';
const skipBootstrap = process.env.FIREFORGE_FULL_SKIP_BOOTSTRAP === '1';
const hostRoot = process.env.FIREFORGE_HOME || join(homedir(), '.fireforge');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = join(workDir, 'artifacts', stamp);
const marker = `// fireforge-full-integration ${stamp}`;
const patchName = 'infra-full-integration';
const identity = ['--name', 'Integration', '--vendor', 'FireForge', '--firefox-version'];

const report = {
  startedAt: new Date().toISOString(),
  workDir,
  firefoxVersion,
  targetFile,
  testPath,
  modes: {},
};

for (const mode of modes) {
  if (mode !== 'patches' && mode !== 'source') {
    throw new Error(`FIREFORGE_FULL_MODES names an unknown mode: ${mode}`);
  }
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false
  );
}

/**
 * Runs one command, teeing its output to the console and to a numbered log
 * file under the artifact directory.
 *
 * @param {object} run - The mode's record in the report
 * @param {string} label - What the step is, for the log name
 * @param {string} command - The executable
 * @param {string[]} args - Its arguments
 * @param {string} cwd - Where it runs
 * @returns {Promise<{exitCode: number, stdout: string}>}
 */
async function runLogged(run, label, command, args, cwd) {
  const index = String(run.steps.length + 1).padStart(2, '0');
  const logFile = join(artifactDir, `${run.mode}-${index}-${label}.log`);
  const log = createWriteStream(logFile, { encoding: 'utf8' });
  log.write(`$ ${command} ${args.join(' ')}\n\n`);
  const startedAt = Date.now();
  let stdout = '';
  const exitCode = await new Promise((resolve, reject) => {
    // stdin stays the terminal's, so a local run can answer mach bootstrap.
    const child = spawn(command, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  await new Promise((resolve) => log.end(`\n[exit ${exitCode}]\n`, resolve));
  run.steps.push({ label, args, exitCode, durationMs: Date.now() - startedAt, logFile });
  return { exitCode, stdout };
}

/**
 * Runs a FireForge command and fails unless it exits 0.
 *
 * @param {object} run - The mode's record in the report
 * @param {string} label - What the step is
 * @param {string[]} args - The CLI arguments
 * @returns {Promise<string>} Its stdout
 */
async function fireforge(run, label, args) {
  const { exitCode, stdout } = await runLogged(
    run,
    label,
    process.execPath,
    [fireforgeBin, ...args],
    run.root
  );
  if (exitCode !== 0) throw new Error(`fireforge ${args.join(' ')} exited ${exitCode}`);
  return stdout;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.name=FireForge integration',
    '-c',
    'user.email=integration@invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    message,
  ]);
}

async function appendMarker(path) {
  const content = await readFile(path, 'utf8');
  await appendFile(path, `${content.endsWith('\n') ? '' : '\n'}${marker}\n`);
}

async function requireMarker(path, present) {
  const holds = (await readFile(path, 'utf8')).includes(marker);
  if (holds !== present) {
    throw new Error(`${path} ${present ? 'lacks' : 'still holds'} the marker ${marker}`);
  }
}

async function bootstrapUnlessSkipped(run) {
  if (skipBootstrap) run.notes.push('bootstrap skipped (FIREFORGE_FULL_SKIP_BOOTSTRAP=1)');
  else await fireforge(run, 'bootstrap', ['bootstrap']);
}

async function patchMode(run) {
  const engineFile = join(run.root, 'engine', targetFile);
  const reused = await exists(join(run.root, 'fireforge.json'));
  if (reused) {
    const config = JSON.parse(await readFile(join(run.root, 'fireforge.json'), 'utf8'));
    if (config.firefox?.version !== firefoxVersion || (config.mode ?? 'patches') !== 'patches') {
      throw new Error(
        `${run.root} holds another project; remove it or point FIREFORGE_FULL_WORK_DIR elsewhere.`
      );
    }
    run.notes.push('reused the existing patch-mode project');
  } else {
    await mkdir(run.root, { recursive: true });
    await fireforge(run, 'setup', ['setup', ...identity, firefoxVersion, '--mode', 'patches']);
  }
  if (await exists(join(run.root, 'engine', '.git'))) run.notes.push('engine/ already present');
  else await fireforge(run, 'download', ['download']);
  // A reused project must start without leftovers of an earlier run.
  if (reused) await fireforge(run, 'status-clean', ['status', '--check']);
  await bootstrapUnlessSkipped(run);
  await fireforge(run, 'import', ['import']);
  await fireforge(run, 'build', ['build']);
  await fireforge(run, 'test', ['test', testPath]);

  await appendMarker(engineFile);
  run.cleanup = async () => {
    if (run.exported) await fireforge(run, 'cleanup-patch', ['patch', 'delete', patchName]);
    await fireforge(run, 'cleanup-discard', ['discard', targetFile]);
    await fireforge(run, 'cleanup-status', ['status', '--check']);
  };
  const exported = JSON.parse(
    await fireforge(run, 'export', [
      'export',
      targetFile,
      '--name',
      patchName,
      '--description',
      'Full Firefox integration marker',
      '--json',
    ])
  );
  run.exported = true;
  if (!exported.files?.includes(targetFile)) {
    throw new Error(`export did not capture ${targetFile}: ${JSON.stringify(exported)}`);
  }
  await fireforge(run, 'reset', ['reset', '--yes']);
  await requireMarker(engineFile, false);
  await fireforge(run, 'import-roundtrip', ['import']);
  await requireMarker(engineFile, true);
  await fireforge(run, 'verify', ['verify']);
}

async function sourceMode(run) {
  await rm(run.root, { recursive: true, force: true });
  await mkdir(run.root, { recursive: true });
  await fireforge(run, 'setup', ['setup', ...identity, firefoxVersion, '--mode', 'source']);
  git(run.root, ['init', '--quiet']);
  commitAll(run.root, 'setup');
  await fireforge(run, 'download', ['download']);
  await bootstrapUnlessSkipped(run);
  await fireforge(run, 'override', ['override', targetFile]);
  await appendMarker(join(run.root, 'src', targetFile));
  await fireforge(run, 'status-declared', ['status', '--check']);
  commitAll(run.root, `own ${targetFile}`);

  const built = JSON.parse(await fireforge(run, 'build', ['build', '--json']));
  if (typeof built.workspace !== 'string') {
    throw new Error(`build --json names no workspace: ${JSON.stringify(built)}`);
  }
  run.notes.push(`built in workspace ${built.workspace}`);
  await requireMarker(join(hostRoot, 'workspaces', built.workspace, 'engine', targetFile), true);
  await fireforge(run, 'test', ['test', testPath]);

  const out = join(artifactDir, 'source-queue');
  const exported = JSON.parse(await fireforge(run, 'export', ['export', '--out', out, '--json']));
  if (!exported.patches?.some((patch) => patch.files.includes(targetFile))) {
    throw new Error(`the exported queue does not name ${targetFile}: ${JSON.stringify(exported)}`);
  }
  await fireforge(run, 'verify', ['verify']);
}

async function main() {
  await access(fireforgeBin).catch(() => {
    throw new Error(`${fireforgeBin} is missing: run "npm run build" first.`);
  });
  await mkdir(artifactDir, { recursive: true });
  let failed = false;
  for (const mode of modes) {
    const run = { mode, root: join(workDir, mode), steps: [], notes: [] };
    const record = { root: run.root, steps: run.steps, notes: run.notes };
    report.modes[mode] = record;
    try {
      await (mode === 'patches' ? patchMode(run) : sourceMode(run));
      record.success = true;
    } catch (error) {
      record.success = false;
      record.failure = error instanceof Error ? error.message : String(error);
      failed = true;
    }
    if (run.cleanup) {
      await run.cleanup().catch((error) => {
        record.cleanupFailure = error instanceof Error ? error.message : String(error);
        failed = true;
      });
    }
  }
  report.completedAt = new Date().toISOString();
  report.success = !failed;
  await writeFile(join(artifactDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nFull Firefox integration ${failed ? 'FAILED' : 'passed'}: ${artifactDir}`);
  if (failed) process.exitCode = 1;
}

await main();
