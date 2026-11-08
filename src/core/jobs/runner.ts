// SPDX-License-Identifier: EUPL-1.2
/** The supervisor owns this process group; caller exit does not interrupt execution. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNoSourceAliases } from '../authored/paths.js';
import { LOAD_WATCH_TICK_MS, watchHostLoad } from '../test-host-state.js';
import { adapterOptionValues } from './adapter-arguments.js';
import { readCheckEvidence } from './check-evidence.js';
import { executionEnvironmentDigest, executorFingerprint, testStepEvidence } from './evidence.js';
import { readAdmittedSnapshot } from './guard.js';
import { type FrontHold, type FrontReport, holdFront } from './hold-front.js';
import { hostConditionReaders, steadyHostReaders, watchHostConditions } from './host-conditions.js';
import { stepMarker } from './job-view.js';
import { holdKeepAwake, wantsKeepAwake } from './keep-awake.js';
import type {
  CoordinatorConfig,
  ExecutionReport,
  JobStep,
  StepEvidence,
  StepHostState,
} from './schema.js';
import { stepOutputDirectory } from './step-environment.js';
import { throttleArguments } from './step-environment.js';
import { stepTraits } from './step-traits.js';
import { expandOutputOptions, validatorInvocation } from './step-validate.js';
import { readJson, writeDurable } from './store.js';

/** The adapter's own arguments plus what the executor owns: parallelism, results and profile. */
function adapterArguments(step: JobStep, cpu: number, results: string): string[] {
  const args = [...step.args];
  if (
    (step.command === 'check' || step.command === 'build') &&
    !args.some((arg) => arg === '--jobs' || arg.startsWith('--jobs=') || /^-j/.test(arg))
  )
    args.push('--jobs', String(cpu));
  if (step.command === 'test' && !stepTraits(step).buildOnly) args.push('--results', results);
  args.unshift(...throttleArguments(step.throttle));
  if (
    step.command === 'run' &&
    !args.some(
      (arg) => arg === '--profile' || arg.startsWith('--profile=') || arg === '--temp-profile'
    )
  )
    args.push('--temp-profile');
  return args;
}

/** One adapter's process, in this executor's group; its exit is the step's. */
async function runAdapter(command: string, args: readonly string[]): Promise<number> {
  const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  return code ?? (signal === null ? 1 : 143);
}

/** Runs a step's validator after a clean harness, in this executor's group: its exit becomes the step's. */
async function runValidator(step: JobStep, output: string | undefined): Promise<number> {
  if (step.validate === undefined) return 0;
  const { command, args } = validatorInvocation(step.validate, output);
  const code = await runAdapter(command, args);
  if (code !== 0)
    process.stderr.write(`Validator ${step.validate.command.join(' ')} exited ${String(code)}\n`);
  return code;
}

/** Starts holding the front for a step that asked to, watching for this slot's own browser binary. */
function startFrontHold(step: JobStep): FrontHold | undefined {
  if (step.holdFront !== true) return undefined;
  if (process.platform !== 'darwin')
    return {
      finish: () =>
        Promise.resolve({
          raises: 0,
          failures: 0,
          failed: 'Holding a browser in front is supported on darwin only',
        }),
    };
  return holdFront({ root: process.pid, slotRoot: process.cwd() });
}

/** Whether the namespace pins a steady host. A configuration that cannot be read pins nothing. */
async function steadyHost(namespace: string): Promise<boolean> {
  try {
    return (
      (await readJson<Partial<CoordinatorConfig>>(join(namespace, 'config.json'))).steadyHost ===
      true
    );
  } catch {
    return false;
  }
}

/**
 * Watches what changes on the host under a step with a browser, on the load
 * watch's tick. Any other step watches nothing.
 */
function watchStepHost(step: JobStep, steady: boolean): () => Promise<StepHostState | undefined> {
  const traits = stepTraits(step);
  if (!traits.browser) return () => Promise.resolve(undefined);
  const readers = (steady ? steadyHostReaders : hostConditionReaders)(traits.display);
  return watchHostConditions(readers, { tickMs: LOAD_WATCH_TICK_MS });
}

/** A qualification is not a CLI command: it runs here, inside the phase's process group. */
async function runQualification(): Promise<number> {
  try {
    // Imported here because it brings in Mach: every other phase starts faster without it.
    const { runQualificationPhase } = await import('./native-qualify.js');
    await runQualificationPhase(process.cwd());
    return 0;
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    return 1;
  }
}

/** Execute one adapter step after an owned IPC start handshake. */
export async function runOwnedExecutor(): Promise<void> {
  const namespace = process.env['FIREFORGE_COORDINATOR'];
  const jobId = process.env['FIREFORGE_JOB_ID'];
  if (!namespace || !jobId || !/^[a-f0-9-]{36}$/.test(jobId))
    throw new Error('Missing owned executor identity');

  let stopped = false;
  const isStopping = (): boolean => stopped;
  const terminate = (): void => {
    stopped = true;
    process.exitCode = 143;
  };
  const interrupt = (): void => {
    stopped = true;
    process.exitCode = 130;
  };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  const incoming = once(process, 'message');
  process.channel?.ref();
  process.send?.({ ready: true });
  const directory = join(namespace, 'artifacts', jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report: ExecutionReport = {
    schemaVersion: 1,
    jobId,
    toolsBefore: await executorFingerprint(),
    toolsAfter: '',
    environmentDigest: executionEnvironmentDigest(),
    steps: [],
  };
  const [message] = (await incoming) as [
    {
      step: JobStep;
      index: number;
      runtime: import('./slot-types.js').PhaseRuntimeIdentity;
      cpu: number;
    },
  ];
  const { step, index, runtime, cpu } = message;
  try {
    if (!isStopping()) {
      process.stdout.write(stepMarker(index, step));
      const startedAt = new Date().toISOString();
      const results = join(directory, `step-${index}-results.json`);
      const output = stepOutputDirectory(namespace, jobId, index, step);
      const args = expandOutputOptions(step.command, adapterArguments(step, cpu, results), output);
      process.exitCode = 0;
      const cliEntry = fileURLToPath(
        new URL(
          import.meta.url.endsWith('.ts')
            ? '../../../bin/fireforge.ts'
            : '../../../bin/fireforge.js',
          import.meta.url
        )
      );
      if (step.command === 'run') {
        for (const profile of adapterOptionValues(step, '--profile'))
          await assertNoSourceAliases(process.cwd(), profile);
      }
      const loader = import.meta.url.endsWith('.ts')
        ? ['--import', fileURLToPath(new URL('./source-loader-bootstrap.cjs', import.meta.url))]
        : [];
      const hold = wantsKeepAwake(step) ? holdKeepAwake() : undefined;
      const front = startFrontHold(step);
      const steady = await steadyHost(namespace);
      const stopLoadWatch = watchHostLoad();
      const stopHostWatch = watchStepHost(step, steady);
      let exitCode: number;
      let frontReport: FrontReport | undefined;
      let loadPeak: ReturnType<typeof stopLoadWatch>;
      let hostState: StepHostState | undefined;
      try {
        exitCode =
          step.command === 'qualify-native'
            ? await runQualification()
            : await runAdapter(process.execPath, [...loader, cliEntry, step.command, ...args]);
        if (exitCode === 0 && !isStopping()) exitCode = await runValidator(step, output);
      } finally {
        loadPeak = stopLoadWatch();
        hostState = await stopHostWatch();
        await hold?.release();
        frontReport = await front?.finish();
      }
      if (frontReport?.failed !== undefined) {
        process.stderr.write(`${frontReport.failed}\n`);
        if (exitCode === 0) exitCode = 1;
      }
      process.exitCode = isStopping() ? 143 : exitCode;
      const base: StepEvidence = {
        runtimeBefore: runtime,
        sourceGeneration: runtime.sourceGeneration,
        successfulBuildGeneration: runtime.successfulBuildGeneration,
        derivedDigest: runtime.derivedDigest,
        index,
        command: step.command,
        args: step.args,
        ...(step.env === undefined ? {} : { env: step.env }),
        ...(step.throttle === undefined ? {} : { throttle: step.throttle }),
        ...(frontReport === undefined ? {} : { front: frontReport }),
        ...(step.validate === undefined ? {} : { validated: step.validate.command }),
        ...(loadPeak === undefined
          ? {}
          : {
              hostLoadPeak: {
                load: Number(loadPeak.load.toFixed(2)),
                atSeconds: Math.max(0, Math.round((loadPeak.at - Date.parse(startedAt)) / 1000)),
              },
            }),
        ...(hostState === undefined ? {} : { hostState }),
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        selectedFiles: [],
      };
      if (exitCode === 0)
        await collectStepEvidence({ namespace, job: jobId, index, step, results, base, cpu });
      report.steps.push(base);
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    report.toolsAfter = await executorFingerprint();
    await writeDurable(join(directory, `step-${index}-execution.json`), report);
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
  }
}

/** A successful child still needs actual harness/check evidence before it becomes a successful phase. */
async function collectStepEvidence(options: {
  namespace: string;
  job: string;
  index: number;
  step: JobStep;
  results: string;
  base: StepEvidence;
  cpu: number;
}): Promise<void> {
  const { namespace, job, index, step, results, base, cpu } = options;
  if (step.command !== 'check' && !(step.command === 'test' && !stepTraits(step).buildOnly)) return;
  const admitted = await readAdmittedSnapshot(process.cwd());
  if (step.command === 'check') {
    base.check = await readCheckEvidence({
      namespace,
      job,
      index,
      root: process.cwd(),
      snapshot: admitted.snapshot,
      step,
      cpu,
      phase: admitted.phase,
    });
    base.resultDigest = base.check.resultDigest;
  } else Object.assign(base, await testStepEvidence(step, results, admitted.snapshot));
}
