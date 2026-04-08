// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { PythonNotFoundError } from '../errors/build.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { exec, executableExists } from '../utils/process.js';

/** Cached Python resolution state */
const pythonCache: { python?: string; requirementsKey?: string } = {};

interface PythonVersion {
  major: number;
  minor: number;
  micro?: number | undefined;
}

interface MachPythonRequirements {
  min: PythonVersion;
  max: PythonVersion;
}

const DEFAULT_MACH_PYTHON_REQUIREMENTS: MachPythonRequirements = {
  min: { major: 3, minor: 8 },
  max: { major: 3, minor: 12 },
};

function formatPythonMinor(version: PythonVersion): string {
  return `${version.major}.${version.minor}`;
}

function formatRequirementsKey(requirements: MachPythonRequirements): string {
  return `${formatPythonMinor(requirements.min)}-${formatPythonMinor(requirements.max)}`;
}

function comparePythonVersions(left: PythonVersion, right: PythonVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return (left.micro ?? 0) - (right.micro ?? 0);
}

function isVersionWithinRequirements(
  version: PythonVersion,
  requirements: MachPythonRequirements
): boolean {
  return (
    comparePythonVersions({ major: version.major, minor: version.minor }, requirements.min) >= 0 &&
    comparePythonVersions({ major: version.major, minor: version.minor }, requirements.max) <= 0
  );
}

function parsePythonVersion(output: string): PythonVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    micro: Number(match[3]),
  };
}

async function readMachPythonRequirements(engineDir?: string): Promise<MachPythonRequirements> {
  if (!engineDir) {
    return DEFAULT_MACH_PYTHON_REQUIREMENTS;
  }

  const machPath = join(engineDir, 'mach');
  if (!(await pathExists(machPath))) {
    return DEFAULT_MACH_PYTHON_REQUIREMENTS;
  }

  try {
    const machContent = await readText(machPath);
    const minMatch = /MIN_PYTHON_VERSION\s*=\s*\((\d+),\s*(\d+)\)/.exec(machContent);
    const maxMatch = /MAX_PYTHON_VERSION_TO_CONSIDER\s*=\s*\((\d+),\s*(\d+)\)/.exec(machContent);

    if (!minMatch || !maxMatch) {
      return DEFAULT_MACH_PYTHON_REQUIREMENTS;
    }

    return {
      min: { major: Number(minMatch[1]), minor: Number(minMatch[2]) },
      max: { major: Number(maxMatch[1]), minor: Number(maxMatch[2]) },
    };
  } catch (error: unknown) {
    verbose(
      `Using default mach python requirements because engine/mach could not be read: ${toError(error).message}`
    );
    return DEFAULT_MACH_PYTHON_REQUIREMENTS;
  }
}

function buildPythonCandidates(requirements: MachPythonRequirements): string[] {
  const candidates: string[] = [];

  for (let minor = requirements.max.minor; minor >= requirements.min.minor; minor--) {
    candidates.push(`python${requirements.min.major}.${minor}`);
  }

  candidates.push(`python${requirements.min.major}`, 'python');
  return [...new Set(candidates)];
}

/**
 * Resets the resolved Python executable. Primarily useful for testing.
 */
export function resetResolvedPython(): void {
  delete pythonCache.python;
  delete pythonCache.requirementsKey;
}

/**
 * Dynamically resolves the python executable and ensures it is available.
 * Checks the Python version range declared by engine/mach when available.
 * @throws PythonNotFoundError if no suitable python is installed
 */
export async function ensurePython(engineDir?: string): Promise<void> {
  const requirements = await readMachPythonRequirements(engineDir);
  const requirementsKey = formatRequirementsKey(requirements);

  if (pythonCache.python && pythonCache.requirementsKey === requirementsKey) {
    return;
  }

  const candidates = buildPythonCandidates(requirements);

  for (const candidate of candidates) {
    if (await executableExists(candidate)) {
      try {
        const { stdout } = await exec(candidate, [
          '-c',
          'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")',
        ]);
        const version = parsePythonVersion(stdout);
        if (version && isVersionWithinRequirements(version, requirements)) {
          pythonCache.python = candidate;
          pythonCache.requirementsKey = requirementsKey;
          return;
        }
      } catch (error: unknown) {
        verbose(`Python candidate ${candidate} was not usable: ${toError(error).message}`);
      }
    }
  }

  throw new PythonNotFoundError(
    formatPythonMinor(requirements.min),
    formatPythonMinor(requirements.max)
  );
}

/**
 * Gets the resolved Python executable name.
 * @param engineDir - Optional engine directory for engine-specific Python requirements
 * @returns The resolved Python executable name
 */
export async function getPython(engineDir?: string): Promise<string> {
  await ensurePython(engineDir);
  if (!pythonCache.python) {
    throw new PythonNotFoundError();
  }
  return pythonCache.python;
}
