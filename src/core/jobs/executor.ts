// SPDX-License-Identifier: EUPL-1.2
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPackageRoot } from '../../utils/package-root.js';
import type { ProcessOwnership } from '../../utils/process-group.js';
import { ownProcessTree } from '../../utils/process-group.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { CONTROL_ASSERTIONS_ENV } from '../control-assertions.js';
import { hermeticGitEnvironment } from '../git-hermetic.js';
import { allowedEnvironment, readCliCacheHook } from './environment.js';
import { cleanupFailedExecutor } from './executor-cleanup.js';
import { quarantineHostUnknown } from './host-quarantine.js';
import { nativeToolEnvironment, needsNativeTools, readHostToolchain } from './native-tools.js';
import { processIdentityAsync, signalOwnedProcess } from './process.js';
import { capturedFilesPath } from './runtime-state.js';
import type { JobRecord, ProcessIdentity } from './schema.js';
import { jobSlot } from './schema.js';
import type { PhaseRuntimeIdentity } from './slot-types.js';
import { assertSourceLoaderEnvironment, sourceLoaderCacheEnvironment } from './source-loader.js';
import { declaredProcessEnvironment, stepOutputDirectory } from './step-environment.js';
import { ensurePrivateNamespace, readJson, writeDurableBytes } from './store.js';

export interface OwnedExecutor {
  child: ChildProcess;
  identity: ProcessIdentity;
  token: string;
  ownership?: ProcessOwnership;
  start: (runtime: PhaseRuntimeIdentity, cpu: number) => Promise<void>;
}

/** Launch an owned adapter but do not release its start message before durable process ownership exists. */
export async function launchExecutor(
  namespace: string,
  job: JobRecord,
  root: string
): Promise<OwnedExecutor> {
  if (!job.phase) throw new Error('Missing executor phase');
  const index = job.phase.index;
  const step = job.request.steps[index];
  if (!step) throw new Error('Missing adapter');
  if (import.meta.url.endsWith('.ts')) assertSourceLoaderEnvironment(getPackageRoot());
  const entry = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './runner-main.ts' : './runner-main.js',
      import.meta.url
    )
  );
  const slot = jobSlot(job);
  if (slot === undefined) throw new Error('Executor job has no assigned slot');
  const token = randomBytes(32).toString('hex');
  const args = import.meta.url.endsWith('.ts')
    ? ['--import', fileURLToPath(new URL('./source-loader-bootstrap.cjs', import.meta.url)), entry]
    : [entry];
  const snapshot = await readJson<AuthoredSnapshot>(
    join(namespace, 'slots', slot, 'snapshot.json')
  );
  const native = step.command === 'qualify-native' || needsNativeTools(step, snapshot);
  const toolEnvironment: Record<string, string> = native
    ? nativeToolEnvironment(await readHostToolchain(namespace), root, job.gitExecutable)
    : {};
  const hook = join(namespace, 'artifacts', job.id, 'cli-cache-hook.cjs');
  await writeDurableBytes(hook, await readCliCacheHook());
  const allowed = allowedEnvironment(process.env);
  const output = stepOutputDirectory(namespace, job.id, index, step);
  if (output !== undefined) await mkdir(output, { recursive: true, mode: 0o700 });
  const environment = {
    ...allowed,
    // Before everything the executor owns: submission refuses those names, and this holds regardless.
    ...declaredProcessEnvironment(step, output),
    ...toolEnvironment,
    // A check's Node scripts have to find the Node the CLI hook qualifies, not whichever comes first on a PATH.
    ...(step.command === 'check'
      ? {
          PATH: [dirname(process.execPath), toolEnvironment['PATH'] ?? allowed['PATH']]
            .filter(Boolean)
            .join(delimiter),
        }
      : {}),
    ...hermeticGitEnvironment(job.gitExecPath),
    FIREFORGE_EXECUTION_ROOT: root,
    FIREFORGE_CAPTURED_FILES: capturedFilesPath(root),
    ...sourceLoaderCacheEnvironment(import.meta.url.endsWith('.ts')),
    NODE_DISABLE_COMPILE_CACHE: '1',
    JITI_FS_CACHE: 'false',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    NODE_OPTIONS: `--require ${JSON.stringify(hook)}`,
    FIREFORGE_QUALITY_TOOLS_DIGEST: job.qualityToolsDigest,
    FIREFORGE_COORDINATOR: namespace,
    FIREFORGE_JOB_ID: job.id,
    FIREFORGE_JOB_TOKEN: token,
    FIREFORGE_JOB_PHASE: job.phase.nonce,
    FIREFORGE_ADAPTER_COMMAND: step.command,
    // A control judges its own labels as this job's evidence will, so its verdict cannot disagree.
    ...(step.controlAssertions?.length
      ? { [CONTROL_ASSERTIONS_ENV]: JSON.stringify(step.controlAssertions) }
      : {}),
  };
  await ensurePrivateNamespace(join(namespace, 'logs'));
  const log = await open(join(namespace, 'logs', `${job.id}.log`), 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
      env: environment,
    });
  } catch (error) {
    await log.close();
    throw error;
  }

  const ready = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Executor readiness exceeded 10000 ms'));
    }, 10000);
    timer.unref();
    child.once('message', (message: unknown) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Executor exited before ready'));
    });
  });
  void ready.catch(() => undefined);
  const ownership = ownProcessTree(child);
  let identity: ProcessIdentity | undefined;
  try {
    await log.close();
    identity = child.pid === undefined ? undefined : await processIdentityAsync(child.pid);
    if (!identity) throw new Error('Cannot identify executor process');
  } catch (error) {
    const uncertain = await cleanupFailedExecutor({
      child,
      ...(identity ? { identity } : {}),
      ...(ownership ? { ownership } : {}),
    });
    // With no birth to name, nothing narrower than the host can hold what may still run.
    if (uncertain !== undefined) await quarantineHostUnknown(namespace, uncertain);
    throw error;
  }
  return {
    child,
    identity,
    token,
    ...(ownership ? { ownership } : {}),
    start: async (runtime, cpu) => {
      const message = await ready;
      if (
        !message ||
        typeof message !== 'object' ||
        !('ready' in message) ||
        message.ready !== true
      ) {
        await signalOwnedProcess(identity, 'SIGTERM');
        throw new Error('Invalid executor readiness');
      }
      child.send({ step, index, runtime, cpu }, () => {
        if (child.connected) child.disconnect();
      });
    },
  };
}
