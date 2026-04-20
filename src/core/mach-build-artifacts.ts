// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { getPlatform } from '../utils/platform.js';
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

/**
 * Outcome of the `hasRunnableBundle` probe. Distinguishes "no objdir at
 * all" from "objdir exists but the launchable binary is not yet written"
 * so callers (notably `fireforge run`) can give the operator a specific
 * message instead of the generic build-artifacts-missing line.
 */
export interface RunnableBundleCheck {
  /** True when an objdir is present AND the expected binary was found under it. */
  runnable: boolean;
  /** Repo-relative (engine-rooted) path we probed; populated even on failure for error copy. */
  expectedPath?: string;
}

/**
 * Checks whether the built browser's launchable binary exists under
 * `<engineDir>/<objDir>/dist/...`. `hasBuildArtifacts` only confirms that
 * an obj tree with a `dist/` subdir exists; a partial or in-progress build
 * can satisfy that check without ever writing the executable, which is the
 * failure mode that makes `fireforge run` throw `mach run` after having
 * reported the build as usable. Separating the probes lets `run` fail fast
 * with a precise message and `watch` stay permissive (it exists to drive
 * rebuilds of incomplete trees) while still reporting the bundle state in
 * its startup banner.
 *
 * Platform layout:
 * - macOS: `<objDir>/dist/*.app/Contents/MacOS/<binaryName>` (the `.app`
 *   display casing can differ from `binaryName` — e.g. `Hominis.app` for
 *   binary `hominis`, so we enumerate the `*.app` bundles rather than
 *   compute the name.
 * - Linux: `<objDir>/dist/bin/<binaryName>`.
 * - Windows: `<objDir>/dist/bin/<binaryName>.exe`.
 *
 * Returns `runnable: false` with no `expectedPath` when the `objDir`
 * itself cannot be scanned — same degraded contract as `hasBuildArtifacts`.
 *
 * @param engineDir Path to the engine directory
 * @param binaryName Lowercase binary name from `fireforge.json`
 * @param objDir The single matching `obj-*` directory name (caller
 *   resolves it; typically from `hasBuildArtifacts().objDir`)
 * @returns Structured check result
 */
export async function hasRunnableBundle(
  engineDir: string,
  binaryName: string,
  objDir: string
): Promise<RunnableBundleCheck> {
  const platform = getPlatform();
  const distDir = join(engineDir, objDir, 'dist');

  if (!(await pathExists(distDir))) {
    return { runnable: false };
  }

  if (platform === 'darwin') {
    let entries;
    try {
      entries = await readdir(distDir, { withFileTypes: true });
    } catch {
      return { runnable: false };
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.endsWith('.app')) continue;
      const candidate = join(distDir, entry.name, 'Contents', 'MacOS', binaryName);
      if (await pathExists(candidate)) {
        return { runnable: true, expectedPath: relative(engineDir, candidate) };
      }
    }
    // Report an expected-but-missing path rooted at the first .app bundle we
    // can see, or a synthetic path when no bundle exists yet, so the error
    // message names something the operator can look for on disk.
    const firstApp = entries.find((e) => e.isDirectory() && e.name.endsWith('.app'));
    const expected = firstApp
      ? relative(engineDir, join(distDir, firstApp.name, 'Contents', 'MacOS', binaryName))
      : relative(engineDir, join(distDir, `<AppName>.app/Contents/MacOS/${binaryName}`));
    return { runnable: false, expectedPath: expected };
  }

  const binaryFile = platform === 'win32' ? `${binaryName}.exe` : binaryName;
  const candidate = join(distDir, 'bin', binaryFile);
  const expectedPath = relative(engineDir, candidate);
  if (await pathExists(candidate)) {
    return { runnable: true, expectedPath };
  }
  return { runnable: false, expectedPath };
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
    'Delete the stale obj-* directory in this workspace and run "fireforge build" again so mach regenerates build metadata for the current checkout.\n' +
    'If the workspace was simply moved (same tree, different prefix), "fireforge build --rewrite-mozinfo" will patch mozinfo.json paths in place and run mach configure instead of scrubbing the whole tree.'
  );
}

/**
 * Outcome of an in-place mozinfo.json rewrite attempt. A successful rewrite
 * returns the paths written; a refused rewrite returns a human-readable
 * reason so the build flow can surface it alongside the original mismatch
 * message before falling back to the clean-rebuild instruction.
 */
export interface MozinfoRewriteResult {
  /** Whether mozinfo.json was patched in place. */
  rewritten: boolean;
  /** Reason the rewrite was refused (populated when `rewritten === false`). */
  reason?: string;
  /** New `topsrcdir` value written to disk (populated on success). */
  newTopsrcdir?: string;
  /** New `topobjdir` value written to disk (populated on success). */
  newTopobjdir?: string;
  /** New `mozconfig` value written to disk (populated on success when it lived inside topsrcdir). */
  newMozconfig?: string;
}

/**
 * Safe-relocation rewriter for mozinfo.json under the active obj-* tree.
 *
 * Firefox build artefacts bake the topsrcdir into many generated files
 * (Makefiles, config.status, backend.mk, .deps dependency files — anything
 * produced by `mach configure`). A fresh `mach configure` rebuilds those
 * from the top, so the rewriter only needs to patch the one file `mach`
 * reads to learn where its checkout actually lives. Once mozinfo.json
 * agrees with the on-disk layout, `mach configure` regenerates the rest.
 *
 * Safety rules — the rewrite is refused when any of them are violated:
 *   - `topsrcdir` and `topobjdir` must both be present and non-empty.
 *   - `topobjdir` must resolve to `<topsrcdir>/<objDir>`; a non-in-tree
 *     objdir means the previous workspace was configured differently,
 *     so a blind prefix-rewrite could point mach at the wrong tree.
 *   - The computed new `topobjdir` must be `<engineDir>/<objDir>`; if it
 *     is not, the objDir name itself changed and we cannot prove safety.
 *
 * When any rule trips, the caller should fall back to the clean-rebuild
 * instruction — that's always a correct (if expensive) recovery path.
 *
 * @param engineDir Absolute path to the current engine checkout.
 * @param objDir Name of the obj-* directory to rewrite against.
 * @returns Result object; callers inspect `rewritten` and surface `reason`.
 */
export async function attemptMozinfoRewrite(
  engineDir: string,
  objDir: string
): Promise<MozinfoRewriteResult> {
  const mozinfoPath = join(engineDir, objDir, 'mozinfo.json');
  if (!(await pathExists(mozinfoPath))) {
    return { rewritten: false, reason: 'mozinfo.json not found in obj directory' };
  }

  let raw: unknown;
  try {
    raw = await readJson<unknown>(mozinfoPath);
  } catch (error: unknown) {
    return { rewritten: false, reason: `mozinfo.json is unreadable: ${toError(error).message}` };
  }
  if (!isObject(raw)) {
    return { rewritten: false, reason: 'mozinfo.json is not a JSON object' };
  }

  let mozinfo: BuildMozinfo;
  try {
    mozinfo = validateBuildMozinfo(raw);
  } catch (error: unknown) {
    return { rewritten: false, reason: toError(error).message };
  }

  const oldSrc = mozinfo.topsrcdir;
  const oldObj = mozinfo.topobjdir;
  if (!oldSrc || !oldObj) {
    return {
      rewritten: false,
      reason: 'mozinfo.json is missing topsrcdir or topobjdir; cannot rewrite safely',
    };
  }

  const oldSrcResolved = resolve(oldSrc);
  const oldObjResolved = resolve(oldObj);
  const insideTree =
    oldObjResolved === oldSrcResolved ||
    oldObjResolved.startsWith(oldSrcResolved + sep) ||
    oldObjResolved.startsWith(oldSrcResolved + '/');
  if (!insideTree) {
    return {
      rewritten: false,
      reason: `topobjdir (${oldObjResolved}) is not inside topsrcdir (${oldSrcResolved}) — rewrite would change workspace layout`,
    };
  }

  const relativeObj = relative(oldSrcResolved, oldObjResolved).split(sep).join('/');
  if (relativeObj !== objDir) {
    return {
      rewritten: false,
      reason: `mozinfo objdir "${relativeObj}" does not match detected objdir "${objDir}" — rewrite would change the obj directory name`,
    };
  }

  const newSrc = resolve(engineDir);
  const newObj = resolve(engineDir, objDir);
  const patched: Record<string, unknown> = { ...raw, topsrcdir: newSrc, topobjdir: newObj };

  let newMozconfig: string | undefined;
  if (mozinfo.mozconfig) {
    const oldMozconfigResolved = resolve(mozinfo.mozconfig);
    if (
      oldMozconfigResolved === oldSrcResolved ||
      oldMozconfigResolved.startsWith(oldSrcResolved + sep) ||
      oldMozconfigResolved.startsWith(oldSrcResolved + '/')
    ) {
      const rel = relative(oldSrcResolved, oldMozconfigResolved);
      newMozconfig = resolve(newSrc, rel);
      patched['mozconfig'] = newMozconfig;
    }
    // A mozconfig living outside the old topsrcdir is left as-is — it
    // probably points at a shared configuration file the user kept in
    // place across the relocation. A relocated checkout that also moved
    // its mozconfig will still fail configure; operator can re-point
    // with `MOZCONFIG=…` or run a full clean rebuild.
  }

  await writeJson(mozinfoPath, patched);
  return {
    rewritten: true,
    newTopsrcdir: newSrc,
    newTopobjdir: newObj,
    ...(newMozconfig ? { newMozconfig } : {}),
  };
}
