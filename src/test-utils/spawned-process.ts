// SPDX-License-Identifier: EUPL-1.2
import { execStream } from '../utils/process.js';

export interface CapturedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Exercise the production bounded ownership lifecycle instead of a separate test-only reaper. */
export async function runCapturedProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; graceMs?: number }
): Promise<CapturedProcessResult> {
  let stdout = '';
  let stderr = '';
  const env: Record<string, string> = {};
  const envUnset: string[] = [];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) envUnset.push(key);
    else env[key] = value;
  }
  const exitCode = await execStream(command, args, {
    cwd: options.cwd,
    env,
    envUnset,
    processGroup: true,
    timeout: options.timeoutMs ?? 20_000,
    shutdownGraceMs: options.graceMs ?? 500,
    onStdout: (chunk) => {
      stdout += chunk;
    },
    onStderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { exitCode, stdout, stderr };
}
