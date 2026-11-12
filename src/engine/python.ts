// SPDX-License-Identifier: EUPL-1.2
/** Finding the Python interpreter `mach` accepts: the newest one inside the range the engine's `mach` declares. */
import { join } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { readTextIfExists } from '../kernel/fs.js';
import { verbose } from '../kernel/log.js';
import { findExecutable, run } from '../kernel/process/index.js';

/** A `major.minor` range, both ends included. */
interface PythonRange {
  major: number;
  min: number;
  max: number;
}

/** The range assumed for a `mach` that declares none. */
const DEFAULT_RANGE: PythonRange = { major: 3, min: 8, max: 12 };

/**
 * The range a `mach` script declares with `MIN_PYTHON_VERSION` and
 * `MAX_PYTHON_VERSION_TO_CONSIDER`, or the default when it declares none.
 *
 * @param machSource - The text of `mach`
 */
export function machPythonRange(machSource: string): PythonRange {
  const min = /MIN_PYTHON_VERSION\s*=\s*\((\d+),\s*(\d+)\)/.exec(machSource);
  const max = /MAX_PYTHON_VERSION_TO_CONSIDER\s*=\s*\((\d+),\s*(\d+)\)/.exec(machSource);
  if (min === null || max === null) return DEFAULT_RANGE;
  return { major: Number(min[1]), min: Number(min[2]), max: Number(max[2]) };
}

const resolved = new Map<string, string>();

async function minorOf(candidate: string, major: number): Promise<number | undefined> {
  try {
    const probe = await run(
      candidate,
      ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
      { timeoutMs: 10_000 }
    );
    const match = /^(\d+)\.(\d+)$/.exec(probe.stdout.trim());
    return probe.exitCode === 0 && match !== null && Number(match[1]) === major
      ? Number(match[2])
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Python to run an engine's `mach` with: `python3.<n>` from the newest
 * minor the engine accepts downwards, then `python3`, then `python`.
 *
 * @param engineDir - The engine
 * @throws `python-not-found` (exit code 7) when no installed Python is in range
 */
export async function machPython(engineDir: string): Promise<string> {
  const range = machPythonRange((await readTextIfExists(join(engineDir, 'mach'))) ?? '');
  const key = `${range.major}.${range.min}-${range.max}`;
  const known = resolved.get(key);
  if (known !== undefined) return known;
  const candidates: string[] = [];
  for (let minor = range.max; minor >= range.min; minor -= 1) {
    candidates.push(`python${range.major}.${minor}`);
  }
  candidates.push(`python${range.major}`, 'python');
  for (const candidate of candidates) {
    if ((await findExecutable(candidate)) === undefined) continue;
    const minor = await minorOf(candidate, range.major);
    if (minor !== undefined && minor >= range.min && minor <= range.max) {
      verbose(`mach runs under ${candidate} (Python ${range.major}.${minor}).`);
      resolved.set(key, candidate);
      return candidate;
    }
  }
  throw new FireForgeError(
    'python-not-found',
    `mach needs Python ${range.major}.${range.min} to ${range.major}.${range.max}, and none is on PATH`,
    {
      exitCode: ExitCode.MISSING_DEPENDENCY,
      hint: `Install Python ${range.major}.${range.max} and make sure "python${range.major}.${range.max}" is on PATH.`,
    }
  );
}
