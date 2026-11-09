// SPDX-License-Identifier: EUPL-1.2
import { sourceGit } from '../core/authored/git.js';
import { authoredGateContext, type SourceGateContext } from '../core/authored-gates.js';
import { readBuildDerived } from '../core/jobs/build-derived.js';
import { readDerivedOutputs } from '../core/jobs/derived.js';
import { coordinatorNamespace, readAdmittedSnapshot } from '../core/jobs/guard.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { info } from '../utils/logger.js';
import { resolveStatusCheckPolicy } from './status-check.js';

export interface AuthoredStatusOptions {
  patches?: string[];
  json?: boolean;
  raw?: boolean;
  ownership?: boolean;
  includeOwnership?: boolean;
  summary?: boolean;
  unmanaged?: boolean;
  check?: boolean;
  failOn?: string;
  allow?: string;
  failOnUnknown?: boolean;
}

function assertAuthoredStatusFlags(options: AuthoredStatusOptions): void {
  if (options.patches?.length)
    throw new GeneralError('Authored status uses source paths, not patch aliases.');
  for (const [enabled, flag] of [
    [options.ownership, '--ownership'],
    [options.includeOwnership, '--include-ownership'],
    [options.unmanaged, '--unmanaged'],
  ] as const)
    if (enabled)
      throw new InvalidArgumentError(
        `Authored status has no patch ownership to classify, so ${flag} is not available.`,
        flag
      );
}

/** Engine paths in an admitted slot that nothing captured or derived accounts for. */
async function engineCensus(
  projectRoot: string,
  context: SourceGateContext
): Promise<{ count: number; files: string[] }> {
  const admitted = await readAdmittedSnapshot(projectRoot);
  const namespace = coordinatorNamespace();
  const allowed = new Set([
    ...context.snapshot.files.map((file) => file.path),
    ...Object.keys(await readBuildDerived(namespace, admitted.slot)),
    ...Object.keys(await readDerivedOutputs(namespace, admitted.slot))
      .filter((path) => path.startsWith('engine/'))
      .map((path) => path.slice('engine/'.length)),
  ]);
  const raw = await sourceGit(context.engine, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  const files = raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter((path) => !allowed.has(path))
    .sort();
  return { count: files.length, files };
}

/** Source files as captured; a job judges its slot, an editing checkout gets provisional feedback. */
export async function statusAuthored(
  projectRoot: string,
  options: AuthoredStatusOptions
): Promise<void> {
  assertAuthoredStatusFlags(options);
  const policy = resolveStatusCheckPolicy(options);
  const inJob = process.env['FIREFORGE_JOB_ID'] !== undefined;
  if (policy.checkEnabled && !inJob)
    throw new InvalidArgumentError(
      'status --check judges an execution slot, and this checkout has none. Use "authored verify" for static checks, or submit a job.',
      '--check'
    );
  const context = await authoredGateContext(projectRoot);
  const { snapshot } = context;
  const files = snapshot.files.map((file) => ({
    file: file.path,
    classification: file.kind === 'generated' ? 'generated' : 'authored',
    origin: file.kind,
    source: snapshot.id,
  }));
  const census =
    policy.checkEnabled && policy.failOn.includes('unmanaged')
      ? await engineCensus(projectRoot, context)
      : { count: 0, files: [] };
  const offenders =
    census.count > 0
      ? [{ classification: 'unmanaged', count: census.count, files: census.files }]
      : [];
  const failed = offenders.length > 0;
  const document = {
    schemaVersion: 1,
    source: snapshot.id,
    tree: snapshot.tree,
    authority: 'authored',
    verification: inJob ? 'provisional-until-job-sealed' : 'provisional-no-job',
    summary: { total: files.length },
    ...(policy.checkEnabled
      ? {
          check: {
            enabled: true,
            failOn: policy.failOn,
            ...(options.allow !== undefined ? { allow: options.allow.split(',') } : {}),
            ...(options.failOnUnknown ? { failOnUnknown: true } : {}),
            failed,
            offenders,
          },
        }
      : {}),
    ...(options.summary ? {} : { files }),
  };
  if (options.json) process.stdout.write(`${JSON.stringify(document)}\n`);
  else if (options.raw) {
    if (files.length > 0) process.stdout.write(files.map((file) => file.file).join('\n') + '\n');
  } else
    info(
      `Captured authored source ${snapshot.id}: ${files.length} paths; final verification requires a sealed job receipt.`
    );
  if (failed)
    throw new GeneralError(
      `status --check failed: ${census.count} unmanaged (${census.files.slice(0, 5).join(', ')}${census.count > 5 ? `, +${census.count - 5} more` : ''}). The slot engine holds paths this snapshot does not account for.`
    );
}
