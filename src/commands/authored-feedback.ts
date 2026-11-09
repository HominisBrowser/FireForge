// SPDX-License-Identifier: EUPL-1.2
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import { wantsMachineOutput } from '../cli-usage-error.js';
import { pruneSnapshotRefs } from '../core/authored/feedback.js';
import { assertSourcePath } from '../core/authored/paths.js';
import type { AuthoredSnapshot } from '../core/authored/types.js';
import type { SourceGateOptions } from '../core/authored-gates.js';
import {
  authoredGateContext,
  checkAuthoredTypes,
  lintAuthoredSource,
  verifyAuthoredSource,
} from '../core/authored-gates.js';
import { resolveSourceScope } from '../core/authored-scope.js';
import { loadConfig } from '../core/config.js';
import { coordinatorNamespace } from '../core/jobs/guard.js';
import { terminal } from '../core/jobs/schema.js';
import { readJournal } from '../core/jobs/store.js';
import { capturedTypecheck, inTypecheckProject } from '../core/proof/plan-typecheck.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { setStdoutSealed } from '../utils/logger.js';
import { MACHINE_OUTPUT_SCHEMA_VERSION } from '../utils/machine-output.js';
import { assertSourceMode, parseWhole, printData } from './job-support.js';

interface FeedbackOptions {
  snapshot?: string;
  pristineRepository?: string;
  allowDirtyRoot?: boolean;
}

async function gateOptions(options: FeedbackOptions): Promise<SourceGateOptions> {
  return {
    ...(options.snapshot
      ? { snapshot: JSON.parse(await readFile(resolve(options.snapshot), 'utf8')) as unknown }
      : {}),
    ...(options.pristineRepository
      ? { pristineRepository: resolve(options.pristineRepository) }
      : {}),
    ...(options.allowDirtyRoot ? { allowDirtyRoot: true } : {}),
    onNotice: (message) => {
      process.stderr.write(`${message}\n`);
    },
  };
}

/**
 * One result shape for every check; a nonzero exit means an error-severity finding,
 * or warnings over the line the project's `check` and `prove` hold them to.
 */
function report(name: string, issues: readonly PatchLintIssue[], maxWarnings?: number): void {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const overLine = maxWarnings !== undefined && warnings > maxWarnings;
  if (wantsMachineOutput()) {
    setStdoutSealed(true);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
        check: name,
        verification: 'provisional-no-job',
        passed: errors === 0 && !overLine,
        ...(maxWarnings === undefined ? {} : { maxWarnings }),
        issues,
      })}\n`
    );
  } else {
    for (const issue of issues)
      process.stdout.write(`${issue.severity} [${issue.check}] ${issue.file}: ${issue.message}\n`);
    process.stdout.write(
      `authored ${name}: ${errors} error(s), ${issues.length - errors} other finding(s); static feedback, not sealed job evidence.\n`
    );
  }
  if (errors > 0) throw new GeneralError(`authored ${name} found ${errors} error(s).`);
  if (overLine)
    throw new GeneralError(
      `authored ${name} found ${warnings} warning(s), over check.maxWarnings.lint ${maxWarnings}, the line prove and check hold.`
    );
}

/**
 * Names the project pass this command does not run when a `typecheck.projects`
 * entry holds a file in scope: the gate's check types those projects whole, and
 * can refuse what the authored pass accepts.
 */
async function noteProjectPass(
  snapshot: AuthoredSnapshot,
  scope: ReadonlySet<string> | undefined
): Promise<void> {
  const typecheck = await capturedTypecheck(snapshot, snapshot.config.typecheck);
  if (typecheck === undefined) return;
  const paths = snapshot.files
    .filter((file) => file.kind !== 'delete' && (scope === undefined || scope.has(file.path)))
    .map((file) => `engine/${file.path}`);
  const covering = typecheck.projects
    .filter((project) => paths.some((path) => inTypecheckProject(project, path)))
    .map((entry) => entry.project);
  if (covering.length === 0) return;
  process.stderr.write(
    `authored typecheck checks authored sources only, not the project pass the gate's check runs over ${covering.join(', ')}; a task-tier "fireforge prove" (its types obligation) or "fireforge job run --check" predicts that pass.\n`
  );
}

function withFeedbackOptions(command: Command): Command {
  return command
    .option('--snapshot <file>', 'Judge this captured handle instead of capturing the checkout')
    .option('--pristine-repository <path>', 'Read pristine objects from this donor repository')
    .option('--allow-dirty-root', 'Capture with changed files outside the selection left out');
}

/** Static checks from a snapshot, in-process: no slot, job or namespace is involved. */
export function registerAuthoredFeedback(command: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  withFeedbackOptions(
    command
      .command('lint [paths...]')
      .description('Lint captured source from a private view; no slot or job is needed')
  ).action(
    withErrorHandling(async (paths: string[], options: FeedbackOptions) => {
      await assertSourceMode(getProjectRoot());
      paths.forEach((path) => {
        assertSourcePath(path);
      });
      const gate = await gateOptions(options);
      const issues = await lintAuthoredSource(getProjectRoot(), paths, gate);
      const config =
        gate.snapshot === undefined
          ? await loadConfig(getProjectRoot())
          : (gate.snapshot as AuthoredSnapshot).config;
      report('lint', issues, config.check?.maxWarnings?.lint);
    })
  );
  withFeedbackOptions(
    command
      .command('typecheck [paths...]')
      .description('Type-check captured source from a private view; no slot or job is needed')
  ).action(
    withErrorHandling(async (paths: string[], options: FeedbackOptions) => {
      await assertSourceMode(getProjectRoot());
      const gate = await authoredGateContext(getProjectRoot(), await gateOptions(options));
      const scope = paths.length
        ? resolveSourceScope(
            gate.snapshot.files.map((file) => file.path),
            paths,
            'authored typecheck'
          )
        : undefined;
      await noteProjectPass(gate.snapshot, scope);
      report('typecheck', await checkAuthoredTypes(gate, scope));
    })
  );
  withFeedbackOptions(
    command
      .command('verify')
      .description('Check policy and registration of captured source; no slot or job is needed')
  ).action(
    withErrorHandling(async (options: FeedbackOptions) => {
      await assertSourceMode(getProjectRoot());
      const issues = await verifyAuthoredSource(getProjectRoot(), await gateOptions(options));
      report('verify', issues);
    })
  );
  command
    .command('prune')
    .description(
      'Release retained snapshots beyond the newest ones, keeping any a job or slot uses'
    )
    .option('--keep <count>', 'Newest snapshots to retain', '50')
    .action(
      withErrorHandling(async (options: { keep: string }) => {
        const keep = parseWhole('--keep', options.keep, 0) ?? 50;
        const result = await pruneSnapshotRefs({
          projectRoot: getProjectRoot(),
          keep,
          inUse: await snapshotsInUse(coordinatorNamespace()),
        });
        printData({ ...result });
      })
    );
}

/** Sources that unfinished jobs and existing slots still read from this object store. */
async function snapshotsInUse(namespace: string): Promise<Set<string>> {
  const inUse = new Set<string>();
  try {
    for (const job of (await readJournal(namespace)).values())
      if (!terminal(job.state)) inUse.add(job.request.sourceId);
    for (const slot of await readdir(join(namespace, 'slots'))) {
      const record = JSON.parse(
        await readFile(join(namespace, 'slots', slot, 'slot.json'), 'utf8')
      ) as { sourceId?: unknown };
      if (typeof record.sourceId === 'string') inUse.add(record.sourceId);
    }
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw toError(error);
  }
  return inUse;
}
