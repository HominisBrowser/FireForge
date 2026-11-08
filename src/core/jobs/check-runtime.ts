// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import type { CheckVerdict } from '../../commands/check-report.js';
import type { CheckStepRecorder, CheckStepResult } from '../../commands/check-run.js';
import type { CheckStepPlan } from '../../commands/check-steps.js';
import { digest } from '../authored/git.js';
import { assertFullCheckArguments } from './check-arguments.js';
import { describeCheckPlan, fullCheckContractForSnapshot } from './check-contract.js';
import type { CheckExecutionDocument } from './check-types.js';
import { coordinatorNamespace, readAdmittedSnapshot } from './guard.js';
import { ensurePrivateNamespace, writeDurable } from './store.js';

export interface OwnedCheckCapture {
  recorder: CheckStepRecorder;
  finish: (results: CheckStepResult[], verdict: CheckVerdict) => Promise<void>;
}
/** Real child output is retained in full; metadata records execution boundaries rather than echoed intent. */
function recorderFor(
  directory: string,
  relativeDirectory: string,
  plans: readonly CheckStepPlan[]
): CheckStepRecorder {
  return async (plan, run) => {
    const index = plans.indexOf(plan);
    if (index < 0) throw new Error('Observed check step was not planned');
    const artifact = `${relativeDirectory}/step-${index}.ndjson`,
      handle = await open(join(directory, `step-${index}.ndjson`), 'wx', 0o600);
    const hash = createHash('sha256'),
      startedAt = new Date().toISOString();
    let pending = Promise.resolve();
    const append = (value: unknown): void => {
      const line = JSON.stringify(value) + '\n';
      hash.update(line);
      pending = pending.then(() => handle.writeFile(line));
      void pending.catch(() => undefined);
    };
    try {
      append({
        event: 'start',
        name: plan.name,
        kind: plan.kind,
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        display: plan.display,
        at: startedAt,
      });
      const result = await run({
        append: (stream, text) => {
          append({ stream, text });
        },
      });
      const finishedAt = new Date().toISOString();
      append({
        event: 'end',
        name: plan.name,
        status: result.status,
        exitCode: result.exitCode,
        at: finishedAt,
      });
      await pending;
      await handle.sync();
      return { ...result, startedAt, finishedAt, artifact, artifactDigest: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  };
}
/** Only a live exact check capability may write the fixed artifact location for its admitted phase. */
export async function beginOwnedCheck(
  projectRoot: string,
  plans: readonly CheckStepPlan[],
  jobs: number
): Promise<OwnedCheckCapture | undefined> {
  if (process.env['FIREFORGE_JOB_TOKEN'] === undefined) return undefined;
  if (process.env['FIREFORGE_ADAPTER_COMMAND'] !== 'check')
    throw new Error('Check execution requires its own admitted phase');
  const admitted = await readAdmittedSnapshot(projectRoot),
    execution = admitted.execution;
  if (!execution || !Number.isSafeInteger(execution.index) || execution.index < 0)
    throw new Error('Check capability lacks an admitted step identity');
  const requested = assertFullCheckArguments(execution.args, execution.cpu) ?? execution.cpu;
  if (jobs !== requested) throw new Error('Check concurrency differs from admitted full check');
  const contract = fullCheckContractForSnapshot(admitted.snapshot);
  if (digest(describeCheckPlan(plans, projectRoot)) !== digest(contract.steps))
    throw new Error('Check plan differs from the captured complete gate');
  const base = join(coordinatorNamespace(), 'artifacts', execution.jobId),
    relativeDirectory = `step-${execution.index}-check`,
    directory = join(base, relativeDirectory);
  await ensurePrivateNamespace(base);
  await mkdir(directory, { mode: 0o700 });
  const startedAt = new Date().toISOString();
  return {
    recorder: recorderFor(directory, relativeDirectory, plans),
    finish: async (results, verdict) => {
      const document: CheckExecutionDocument = {
        version: 1,
        source: admitted.snapshot.id,
        contract: contract.digest,
        configDigest: contract.configDigest,
        job: execution.jobId,
        index: execution.index,
        phase: admitted.phase,
        jobs,
        startedAt,
        finishedAt: new Date().toISOString(),
        plan: contract.steps,
        steps: results.map((result) => ({
          ...result,
          command: result.command.split(projectRoot).join('$PROJECT'),
        })),
        verdict,
      };
      await writeDurable(join(base, `step-${execution.index}-check.json`), document);
    },
  };
}
