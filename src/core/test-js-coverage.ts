// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { PreflightRefusalError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { isObject } from '../utils/validation.js';
import {
  browserCoverageApi,
  xpcshellCoverageHead,
  xpcshellCoverageWrapper,
} from './test-js-coverage-scripts.js';

export interface CoverageSession {
  directory: string;
  token: string;
  suite: 'xpcshell' | 'mochitest';
  args: string[];
  env: Record<string, string>;
}

/** Each attempt owns a fresh directory. Existing coverage is never overwritten or trusted. */
export async function prepareJsCoverage(options: {
  output: string;
  engineDir: string;
  objDir: string | undefined;
  suite: 'xpcshell' | 'mochitest' | 'generic';
  args: readonly string[];
  env?: Record<string, string>;
}): Promise<CoverageSession> {
  if (options.suite === 'generic')
    throw new PreflightRefusalError(
      '--coverage needs suite-specific xpcshell or mochitest dispatch; remove --generic-mach-test and supply explicit test paths.',
      'coverage-suite'
    );
  if (options.args.some((arg) => /^--(?:xpcshell|app-binary|install-extension)(?:=|$)/.test(arg)))
    throw new PreflightRefusalError(
      '--coverage owns its xpcshell wrapper/extension adapter; remove conflicting forwarded adapter flags.',
      'coverage-adapter'
    );
  await mkdir(options.output, { recursive: true });
  const directory = await mkdtemp(join(resolve(options.output), 'dispatch-'));
  const token = randomUUID();
  const args = [...options.args];
  if (options.suite === 'xpcshell') {
    if (process.platform === 'win32')
      throw new PreflightRefusalError(
        '--coverage xpcshell wrapper currently requires a POSIX host.',
        'coverage-host'
      );
    if (options.objDir === undefined)
      throw new PreflightRefusalError('--coverage needs the resolved objdir.', 'coverage-objdir');
    const binary = resolve(options.engineDir, options.objDir, 'dist/bin/xpcshell');
    if (!(await pathExists(binary)))
      throw new PreflightRefusalError(
        `Coverage xpcshell executable is missing: ${binary}`,
        'coverage-binary'
      );
    const head = join(directory, 'coverage-head.js'),
      wrapper = join(directory, 'xpcshell-coverage');
    await writeFile(head, xpcshellCoverageHead(directory, token));
    await writeFile(wrapper, xpcshellCoverageWrapper(binary, head, directory, token));
    await chmod(wrapper, 0o700);
    args.push(`--xpcshell=${wrapper}`);
    // The upstream harness derives its XRE directory from --xpcshell. A
    // scratch wrapper must not make that directory become the coverage output.
    if (!args.some((arg) => /^--xre-path(?:=|$)/.test(arg))) {
      const resources = join(dirname(dirname(binary)), 'Resources');
      const xre =
        process.platform === 'darwin' && (await pathExists(join(resources, 'application.ini')))
          ? resources
          : dirname(binary);
      args.push(`--xre-path=${xre}`);
    }
  } else {
    const extension = join(directory, 'extension');
    await mkdir(extension);
    await writeFile(
      join(extension, 'manifest.json'),
      JSON.stringify({
        manifest_version: 2,
        name: 'FireForge coverage barrier',
        version: '1.0',
        applications: { gecko: { id: `coverage-${token}@fireforge.invalid` } },
        background: { scripts: ['background.js'] },
        experiment_apis: {
          fireforgeCoverage: {
            schema: 'schema.json',
            parent: { scopes: ['addon_parent'], paths: [['fireforgeCoverage']], script: 'api.js' },
          },
        },
      })
    );
    await writeFile(
      join(extension, 'schema.json'),
      JSON.stringify([
        {
          namespace: 'fireforgeCoverage',
          functions: [{ name: 'start', type: 'function', parameters: [] }],
        },
      ])
    );
    await writeFile(join(extension, 'background.js'), 'browser.fireforgeCoverage.start();\n');
    await writeFile(join(extension, 'api.js'), browserCoverageApi(directory, token));
    args.push(
      '--install-extension',
      extension,
      '--setpref=toolkit.shutdown.fastShutdownStage=0',
      '--setpref=extensions.experiments.enabled=true'
    );
  }
  return {
    directory,
    token,
    suite: options.suite,
    args,
    env: {
      ...options.env,
      JS_CODE_COVERAGE_OUTPUT_DIR: directory,
      MOZ_CC_RUN_DURING_SHUTDOWN: '1',
    },
  };
}

export interface CoverageReport {
  schemaVersion: 1;
  complete: boolean;
  processes: number[];
  missing: number[];
  errors: string[];
  sourceRecords: number;
  files: string[];
  lostFiles: string[];
}

/** Check each process independently so a malformed peer cannot erase the remaining roster. */
async function readProcessCoverage(
  session: CoverageSession,
  name: string,
  report: CoverageReport
): Promise<void> {
  const pid = Number(name.split('.')[0]);
  report.processes.push(pid);
  try {
    const start: unknown = JSON.parse(await readFile(join(session.directory, name), 'utf8'));
    const flush: unknown = JSON.parse(
      await readFile(join(session.directory, `${pid}.flushed.json`), 'utf8')
    );
    if (
      !isObject(start) ||
      !isObject(flush) ||
      start['token'] !== session.token ||
      flush['token'] !== session.token ||
      start['pid'] !== pid ||
      flush['pid'] !== pid ||
      flush['schemaVersion'] !== 1 ||
      !Array.isArray(flush['errors']) ||
      typeof flush['globals'] !== 'number' ||
      flush['globals'] < 1
    )
      throw new Error('Invalid or foreign flush receipt');
    for (const error of flush['errors']) report.errors.push(`pid ${pid}: ${String(error)}`);
    const lcov = await readFile(join(session.directory, `${pid}.lcov`), 'utf8');
    const count = (lcov.match(/^SF:/gm) ?? []).length;
    if (count !== flush['sourceRecords'])
      throw new Error('LCOV source count differs from flush receipt');
    report.sourceRecords += count;
  } catch (error: unknown) {
    report.missing.push(pid);
    report.lostFiles.push(`${pid}.lcov`);
    report.errors.push(`pid ${pid}: ${toError(error).message}`);
  }
}

/** All started process receipts must have a matching successful flush and real LCOV output. */
export async function finishJsCoverage(session: CoverageSession): Promise<CoverageReport> {
  const names = await readdir(session.directory);
  const report: CoverageReport = {
    schemaVersion: 1,
    complete: false,
    processes: [],
    missing: [],
    errors: [],
    sourceRecords: 0,
    files: names.filter((name) => /\.(?:lcov|info)$/.test(name)),
    lostFiles: [],
  };
  let barriers = 0;
  for (const name of names.filter((name) => /^\d+\.started\.json$/.test(name))) {
    await readProcessCoverage(session, name, report);
  }
  // Native runtime dumps can reveal a process which never loaded our adapter.
  // They supplement the explicit startup handshake, rather than replacing it.
  for (const name of names) {
    const nativePid = /^\d+-(\d+)-\d+\.info$/.exec(name)?.[1];
    if (nativePid !== undefined && !report.processes.includes(Number(nativePid))) {
      const pid = Number(nativePid);
      if (!report.missing.includes(pid)) report.missing.push(pid);
      report.lostFiles.push(name);
      report.errors.push(
        `pid ${pid}: native coverage exists without an acknowledged flush adapter (${name})`
      );
    }
  }
  if (session.suite === 'mochitest') {
    for (const name of names.filter((name) => /^\d+\.barrier\.json$/.test(name))) {
      try {
        const barrier: unknown = JSON.parse(await readFile(join(session.directory, name), 'utf8'));
        if (
          isObject(barrier) &&
          barrier['token'] === session.token &&
          barrier['missingReady'] === 0 &&
          Array.isArray(barrier['pending']) &&
          barrier['pending'].length === 0
        )
          barriers++;
        else report.errors.push('Parent shutdown barrier did not acknowledge every known process');
      } catch {
        report.errors.push('Parent shutdown barrier receipt is missing or invalid');
      }
    }
    if (barriers !== 1)
      report.errors.push('Exactly one completed parent shutdown barrier is required');
  }
  if (report.processes.length === 0) report.errors.push('No instrumented process started');
  if (report.sourceRecords === 0) report.errors.push('No JavaScript source coverage was emitted');
  report.complete = report.errors.length === 0 && report.missing.length === 0;
  await writeFile(
    join(session.directory, 'fireforge-coverage.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  return report;
}
