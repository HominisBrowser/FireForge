// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists, readJson } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { isObject, isString } from '../utils/validation.js';

/**
 * Result of checking for build artifacts.
 */
export interface BuildArtifactCheck {
  /** Whether build artifacts exist */
  exists: boolean;
  /** Name of the obj-* directory if found */
  objDir?: string;
  /** Whether multiple valid obj-* directories were found */
  ambiguous?: boolean;
  /** All candidate obj-* directories with build artifacts */
  objDirs?: string[];
  /** Build metadata points at a different source or objdir */
  metadataMismatch?: {
    objDir: string;
    topsrcdir?: string;
    topobjdir?: string;
    mozconfig?: string;
  };
}

interface BuildMozinfo {
  topsrcdir?: string;
  topobjdir?: string;
  mozconfig?: string;
}

function validateBuildMozinfo(data: unknown): BuildMozinfo {
  if (!isObject(data)) {
    throw new Error('mozinfo metadata must be an object');
  }

  const mozinfo: BuildMozinfo = {};

  if (data['topsrcdir'] !== undefined) {
    if (!isString(data['topsrcdir'])) {
      throw new Error('mozinfo.topsrcdir must be a string');
    }
    mozinfo.topsrcdir = data['topsrcdir'];
  }

  if (data['topobjdir'] !== undefined) {
    if (!isString(data['topobjdir'])) {
      throw new Error('mozinfo.topobjdir must be a string');
    }
    mozinfo.topobjdir = data['topobjdir'];
  }

  if (data['mozconfig'] !== undefined) {
    if (!isString(data['mozconfig'])) {
      throw new Error('mozinfo.mozconfig must be a string');
    }
    mozinfo.mozconfig = data['mozconfig'];
  }

  return mozinfo;
}

/**
 * Checks if build artifacts exist in the engine directory.
 * Looks for obj-* directories with a dist subdirectory.
 * @param engineDir - Path to the engine directory
 * @returns Build artifact check result
 */
export async function hasBuildArtifacts(engineDir: string): Promise<BuildArtifactCheck> {
  try {
    const entries = await readdir(engineDir);
    const objDirs = entries.filter((e) => e.startsWith('obj-')).sort();

    if (objDirs.length === 0) {
      return { exists: false };
    }

    const validObjDirs: string[] = [];
    for (const objDir of objDirs) {
      const distPath = join(engineDir, objDir, 'dist');
      if (await pathExists(distPath)) {
        validObjDirs.push(objDir);
      }
    }

    if (validObjDirs.length === 0) {
      const firstObjDir = objDirs[0];
      return firstObjDir ? { exists: false, objDir: firstObjDir } : { exists: false };
    }

    if (validObjDirs.length > 1) {
      return { exists: true, ambiguous: true, objDirs: validObjDirs };
    }

    const selectedObjDir = validObjDirs[0];
    if (!selectedObjDir) {
      return { exists: false };
    }

    const mozinfoPath = join(engineDir, selectedObjDir, 'mozinfo.json');
    if (await pathExists(mozinfoPath)) {
      try {
        const mozinfo = validateBuildMozinfo(await readJson<unknown>(mozinfoPath));
        const expectedSrcDir = resolve(engineDir);
        const expectedObjDir = resolve(engineDir, selectedObjDir);
        const actualSrcDir = mozinfo.topsrcdir ? resolve(mozinfo.topsrcdir) : undefined;
        const actualObjDir = mozinfo.topobjdir ? resolve(mozinfo.topobjdir) : undefined;

        if (
          (actualSrcDir !== undefined && actualSrcDir !== expectedSrcDir) ||
          (actualObjDir !== undefined && actualObjDir !== expectedObjDir)
        ) {
          return {
            exists: true,
            objDir: selectedObjDir,
            metadataMismatch: {
              objDir: selectedObjDir,
              ...(mozinfo.topsrcdir ? { topsrcdir: mozinfo.topsrcdir } : {}),
              ...(mozinfo.topobjdir ? { topobjdir: mozinfo.topobjdir } : {}),
              ...(mozinfo.mozconfig ? { mozconfig: mozinfo.mozconfig } : {}),
            },
          };
        }
      } catch (error: unknown) {
        verbose(
          `Ignoring invalid mozinfo metadata in ${selectedObjDir}: ${toError(error).message}`
        );
      }
    }

    return { exists: true, objDir: selectedObjDir };
  } catch (error: unknown) {
    void error;
    return { exists: false };
  }
}

/** Builds a user-facing explanation when detected build artifacts belong to another workspace. */
export function buildArtifactMismatchMessage(
  engineDir: string,
  buildCheck: BuildArtifactCheck,
  commandName: string
): string | undefined {
  if (!buildCheck.metadataMismatch || !buildCheck.objDir) {
    return undefined;
  }

  const expectedObjDir = join(engineDir, buildCheck.objDir);
  const details = [`Current engine: ${engineDir}`, `Detected objdir: ${expectedObjDir}`];

  if (buildCheck.metadataMismatch.topsrcdir) {
    details.push(`mozinfo topsrcdir: ${buildCheck.metadataMismatch.topsrcdir}`);
  }
  if (buildCheck.metadataMismatch.topobjdir) {
    details.push(`mozinfo topobjdir: ${buildCheck.metadataMismatch.topobjdir}`);
  }
  if (buildCheck.metadataMismatch.mozconfig) {
    details.push(`mozinfo mozconfig: ${buildCheck.metadataMismatch.mozconfig}`);
  }

  return (
    `${commandName} cannot use copied or relocated build artifacts whose metadata still points at a different Firefox workspace.\n\n` +
    `${details.join('\n')}\n\n` +
    'Delete the stale obj-* directory in this workspace and run "fireforge build" again so mach regenerates build metadata for the current checkout.'
  );
}
