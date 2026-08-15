// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError } from '../errors/build.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson, readText, writeJson } from '../utils/fs.js';
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
 * Looks for obj-* directories with a dist subdirectory. Detection is
 * deliberately symlink-agnostic — building/running against a symlinked
 * objdir in place is the user's own arrangement; the clone path, where a
 * symlink would route writes into the original build, refuses separately
 * (`assertCloneSafeObjdir` in tree-store.ts).
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
 *   display casing can differ from `binaryName` — e.g. `MyBrowser.app` for
 *   binary `mybrowser`, so we enumerate the `*.app` bundles rather than
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
      // No readable dist directory means no runnable bundle, which is exactly
      // what the caller needs to know.
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

/** Per-command wording for {@link assertBuildArtifacts}. */
export interface BuildArtifactPreflightOptions {
  /** Label passed to {@link buildArtifactMismatchMessage} (e.g. `'Tests'`). */
  label: string;
  /** Sentence naming what needs a build, e.g. `'Tests require a completed build.'` */
  requirement: string;
  /** Follow-up telling the operator what to run, shown after `requirement`. */
  remediation: string;
  /**
   * Whether a missing/incomplete build is fatal. `fireforge build` runs
   * legitimately with no artifacts and only enforces this under `--ui`, so it
   * opts in rather than out.
   */
  requireExisting?: boolean;
}

/**
 * Shared build-artifact preflight: rejects ambiguous multi-objdir checkouts,
 * artifacts whose metadata points at another tree, and (when
 * `requireExisting`) missing or incomplete builds — each with the actionable
 * message for that case.
 *
 * Takes an already-probed {@link BuildArtifactCheck} rather than probing
 * itself, so it stays a pure validator: callers keep their own
 * `hasBuildArtifacts` call (which their suites already stub) and this function
 * needs no test double of its own.
 *
 * Five commands carried a character-identical copy of this ladder, including
 * the same `ambiguous && objDirs && objDirs.length > 0` expression that
 * `BuildArtifactCheck`'s boolean-plus-optionals shape forces at every reader.
 * The shape itself is unchanged — it has several producers and a documented
 * refusal contract (see the containment predicates below) — but it is now
 * destructured in exactly one place.
 */
export function assertBuildArtifacts(
  engineDir: string,
  buildCheck: BuildArtifactCheck,
  options: BuildArtifactPreflightOptions
): void {
  if (buildCheck.ambiguous && buildCheck.objDirs && buildCheck.objDirs.length > 0) {
    throw new AmbiguousBuildArtifactsError(buildCheck.objDirs);
  }

  const mismatchMessage = buildArtifactMismatchMessage(engineDir, buildCheck, options.label);
  if (mismatchMessage) {
    throw new GeneralError(mismatchMessage);
  }

  if (options.requireExisting && !buildCheck.exists) {
    const detail = buildCheck.objDir
      ? `Build artifacts incomplete in ${buildCheck.objDir}/`
      : 'No build artifacts found (obj-*/ directory missing)';
    throw new GeneralError(`${options.requirement} ${detail}\n\n${options.remediation}`);
  }
}

/**
 * Post-`mach configure` relocation check for a cloned objdir: confirms
 * configure actually regenerated `<engineDir>/<objDir>` and that none of
 * the four configure-generated root files (`config.status`, `backend.mk`,
 * `Makefile`, `config/autoconf.mk`) still names `forbiddenDir` (the
 * primary engine a relocated clone must never consult). Exit code 0 alone
 * proves neither — a stray MOZCONFIG/MOZ_OBJDIR can steer configure at a
 * different objdir entirely. Nested Makefiles are products of the verified
 * `config.status` and are not scanned; `.deps` files are build products a
 * configure cannot regenerate and are explicitly out of scope — any
 * primary-path strings they retain are read-only staleness corrected by
 * the first in-tree rebuild. Pure checker: returns a human-readable
 * violation, or `undefined` when clean; callers own the error type and
 * remediation copy. Unreadable metadata is itself a violation (fail
 * closed).
 */
export async function findObjdirRelocationViolation(args: {
  /** The relocated (tree) engine directory configure ran in. */
  engineDir: string;
  /** The obj-* directory name configure was expected to target. */
  objDir: string;
  /** The primary engine dir whose absolute path must not appear. */
  forbiddenDir: string;
}): Promise<string | undefined> {
  const { engineDir, objDir, forbiddenDir } = args;
  const objDirPath = join(engineDir, objDir);
  if (!(await pathExists(join(objDirPath, 'config.status')))) {
    return (
      `${objDir}/config.status was not written — mach configure may have targeted a ` +
      'different objdir (check MOZCONFIG / MOZ_OBJDIR)'
    );
  }

  let mozinfo: BuildMozinfo;
  try {
    mozinfo = validateBuildMozinfo(await readJson<unknown>(join(objDirPath, 'mozinfo.json')));
  } catch (error: unknown) {
    return `${objDir}/mozinfo.json could not be read after configure: ${toError(error).message}`;
  }
  const expectedSrcDir = resolve(engineDir);
  const expectedObjDir = resolve(objDirPath);
  const actualSrcDir = mozinfo.topsrcdir ? resolve(mozinfo.topsrcdir) : undefined;
  const actualObjDir = mozinfo.topobjdir ? resolve(mozinfo.topobjdir) : undefined;
  if (actualSrcDir !== expectedSrcDir) {
    return `${objDir}/mozinfo.json topsrcdir resolves to ${actualSrcDir ?? '(absent)'}, expected ${expectedSrcDir}`;
  }
  if (actualObjDir !== expectedObjDir) {
    return `${objDir}/mozinfo.json topobjdir resolves to ${actualObjDir ?? '(absent)'}, expected ${expectedObjDir}`;
  }

  // The canonical no-primary-paths assertion (mirrors the opt-in real-mach
  // proof in scripts/run-full-firefox-integration.mjs): substring search on
  // the resolved primary engine dir is collision-safe against the tree's own
  // paths — `<primary>/.fireforge/trees/<name>/engine` never contains the
  // substring `<primary>/engine`. Scans exactly the configure-generated
  // root files; `config.status` is mandatory (checked above), the rest are
  // optional-if-absent because not every configure backend writes them.
  const forbidden = resolve(forbiddenDir);
  for (const name of ['config.status', 'backend.mk', 'Makefile', 'config/autoconf.mk']) {
    const filePath = join(objDirPath, ...name.split('/'));
    if (name !== 'config.status' && !(await pathExists(filePath))) continue;
    let content: string;
    try {
      content = await readText(filePath);
    } catch (error: unknown) {
      return `${objDir}/${name} could not be read after configure: ${toError(error).message}`;
    }
    if (content.includes(forbidden)) {
      return `${objDir}/${name} still contains the primary engine path ${forbidden}`;
    }
  }
  return undefined;
}
