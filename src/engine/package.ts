// SPDX-License-Identifier: EUPL-1.2
/**
 * Packaging the browser. A plain package ships the development build as it
 * stands. A release is built for the purpose: with the project's release
 * overlay appended to the mozconfig, in an object directory of its own that
 * is emptied first, so nothing an earlier build left reaches it and the
 * development build stays untouched.
 */
import { dirname, join, posix, resolve } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import {
  cloneTree,
  ensureDir,
  exists,
  isInside,
  listDir,
  move,
  pathInfo,
  readTextIfExists,
  realPath,
  remove,
  tempPathFor,
  writeFile,
} from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { writeJson } from '../kernel/json.js';
import { info, step, warn } from '../kernel/log.js';
import { escapeRegExp } from '../kernel/text.js';
import { readHostConfig, withBuildSlot } from './hostLocks.js';
import { machFailure, runMach } from './mach.js';
import { renderMozconfig } from './mozconfig.js';
import { requireBuilt } from './objdir.js';
import type { Workspace } from './workspace.js';

/** The document beside a release's outputs that says what decided it. */
const RELEASE_RECORD = 'release.json';

/** How the browser is packaged. */
export interface PackageOptions {
  /** Build and package a release with the project's `build.release` recipe. */
  release?: boolean;
  /** Where a release's declared outputs go. Default `.fireforge/release-output` in the project. */
  outputDir?: string;
  /** Parallel jobs of the release build. Default `build.jobs`. */
  jobs?: number;
  /** How long to wait for the host's build slot, in milliseconds. */
  waitMs?: number;
}

/** What packaging produced. */
export interface PackageResult {
  /** The object directory that was packaged. */
  objDir: string;
  /**
   * Absolute paths of the results: a release's collected outputs, or the
   * files `mach package` wrote into the development build's `dist/`.
   */
  outputs: string[];
  /** A release's output directory, which also holds `release.json`. */
  outputDir?: string;
}

/**
 * The mozconfig of a release build: the development one, the project's
 * overlay after it so its options win, and the object directory last.
 *
 * @param generated - The rendered development mozconfig
 * @param overlay - The project's release overlay
 * @param objDir - The release object directory
 */
export function composeReleaseMozconfig(
  generated: string,
  overlay: string,
  objDir: string
): string {
  return `${generated.trimEnd()}\n\n# Release overlay\n${overlay.trimEnd()}\n\nmk_add_options MOZ_OBJDIR="${objDir}"\n`;
}

/**
 * The paths in an object directory that one declared output names: the path
 * itself, or what a `*` in its last segment matches.
 *
 * @param objDir - The object directory
 * @param declared - A relative path as `build.release.outputs` declares it
 * @returns The matches, relative to `objDir`, sorted
 */
export async function matchReleaseOutput(objDir: string, declared: string): Promise<string[]> {
  const name = posix.basename(declared);
  if (!name.includes('*')) return (await exists(join(objDir, declared))) ? [declared] : [];
  const parent = posix.dirname(declared);
  const pattern = new RegExp(`^${name.split('*').map(escapeRegExp).join('.*')}$`);
  return (await listDir(join(objDir, parent)))
    .filter((entry) => pattern.test(entry.name))
    .map((entry) => (parent === '.' ? entry.name : `${parent}/${entry.name}`));
}

function refusal(code: string, message: string, hint?: string): FireForgeError {
  return new FireForgeError(code, message, {
    exitCode: ExitCode.BUILD_ERROR,
    ...(hint === undefined ? {} : { hint }),
  });
}

/** The path as the file system has it, or lexically when it does not exist yet. */
async function settled(path: string): Promise<string> {
  const absolute = resolve(path);
  return (await exists(absolute)) ? realPath(absolute) : absolute;
}

/** Refuses an output directory that holds the object directory or lies inside it. */
async function requireSeparate(objDir: string, outputDir: string): Promise<void> {
  const [build, output] = await Promise.all([settled(objDir), settled(outputDir)]);
  if (isInside(build, output) || isInside(output, build)) {
    throw new FireForgeError(
      'release-output-overlaps-build',
      `The release output directory ${outputDir} overlaps the release object directory ${objDir}`,
      {
        exitCode: ExitCode.INVALID_ARGUMENT,
        hint: 'Collecting outputs would copy a build over itself; choose a directory outside the build.',
      }
    );
  }
}

/**
 * Every declared output resolved against the object directory, before
 * anything is copied. A path another match already contains is left out.
 */
async function resolveOutputs(objDir: string, declared: readonly string[]): Promise<string[]> {
  const matched: string[] = [];
  for (const output of declared) {
    const matches = await matchReleaseOutput(objDir, output);
    if (matches.length === 0) {
      throw refusal(
        'release-output-missing',
        `The release build did not produce ${output} in ${objDir}`
      );
    }
    matched.push(...matches);
  }
  const unique = [...new Set(matched)];
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`))
  );
}

/**
 * Puts staged files into `outputDir` together: each previous file is moved
 * aside first, and when any placement fails everything placed is removed and
 * the previous files are put back.
 *
 * @param staging - Holds the new files at their relative paths
 * @param outputDir - The output directory; files in it that are not replaced stay
 * @param paths - The relative paths to replace, in placement order
 */
async function publishOutputs(
  staging: string,
  outputDir: string,
  paths: readonly string[]
): Promise<void> {
  const aside = tempPathFor(outputDir);
  const done: { path: string; displaced: boolean; placed: boolean }[] = [];
  let keepAside = false;
  try {
    for (const path of paths) {
      const target = join(outputDir, path);
      const displaced = (await pathInfo(target)) !== undefined;
      if (displaced) {
        await ensureDir(dirname(join(aside, path)));
        await move(target, join(aside, path));
      }
      const entry = { path, displaced, placed: false };
      done.push(entry);
      await ensureDir(dirname(target));
      await move(join(staging, path), target);
      entry.placed = true;
    }
  } catch (error: unknown) {
    for (const { path, displaced, placed } of done.reverse()) {
      const target = join(outputDir, path);
      try {
        if (placed) await remove(target);
        if (displaced) await move(join(aside, path), target);
      } catch {
        keepAside = true;
      }
    }
    if (keepAside) {
      warn(`The previous release outputs could not all be put back; they are in ${aside}.`);
    }
    throw error;
  } finally {
    if (!keepAside) await remove(aside);
  }
}

async function packageDevelopment(workspace: Workspace): Promise<PackageResult> {
  await requireBuilt(workspace);
  const dist = join(workspace.objDir, 'dist');
  const startedAt = Date.now();
  step('Packaging the development build');
  const result = await runMach(workspace, ['package']);
  if (result.exitCode !== 0) throw machFailure('mach package', result);
  const outputs: string[] = [];
  for (const entry of await listDir(dist)) {
    if (entry.kind !== 'file') continue;
    const path = join(dist, entry.name);
    // Second granularity on some file systems: allow the write to predate the start by one.
    if (((await pathInfo(path))?.mtimeMs ?? 0) >= startedAt - 1_000) outputs.push(path);
  }
  return { objDir: workspace.objDir, outputs };
}

async function releaseSecrets(
  workspace: Workspace,
  secrets: { variable: string; files: string[] } | undefined
): Promise<Record<string, string>> {
  if (secrets === undefined) return {};
  const directory = (await readHostConfig(workspace.project.host)).releaseSecrets;
  if (directory === undefined) {
    throw refusal(
      'release-secrets-missing',
      'This release declares secrets and this host names no directory for them',
      `Set "releaseSecrets" in ${join(workspace.project.host.root, 'host.json')} to the directory holding ${secrets.files.join(', ')}.`
    );
  }
  for (const file of secrets.files) {
    if (!(await exists(join(directory, file)))) {
      throw refusal('release-secrets-missing', `Release secret ${file} is not in ${directory}`);
    }
  }
  return { [secrets.variable]: directory };
}

async function packageRelease(
  workspace: Workspace,
  options: PackageOptions
): Promise<PackageResult> {
  const { project } = workspace;
  const release = project.config.build?.release;
  if (release === undefined) {
    throw new FireForgeError(
      'release-not-configured',
      'A release needs "build.release" in fireforge.json',
      {
        exitCode: ExitCode.CONFIG_ERROR,
        hint: 'Declare build.release.overlay, the mozconfig fragment a release appends.',
      }
    );
  }
  const overlay = await readTextIfExists(join(project.root, release.overlay));
  if (overlay === undefined) {
    throw new FireForgeError(
      'release-overlay-missing',
      `The release overlay ${release.overlay} does not exist`,
      {
        exitCode: ExitCode.CONFIG_ERROR,
        hint: 'Create it, or correct build.release.overlay in fireforge.json.',
      }
    );
  }
  const secrets = await releaseSecrets(workspace, release.secrets);
  const objDir = workspace.releaseObjDir;
  const outputDir = options.outputDir ?? join(project.paths.stateDir, 'release-output');
  await requireSeparate(objDir, outputDir);
  const mozconfig = join(dirname(objDir), 'mozconfig');
  await remove(objDir);
  await writeFile(
    mozconfig,
    composeReleaseMozconfig(await renderMozconfig(workspace), overlay, objDir)
  );
  // One build date for both commands, which would otherwise mint different build ids.
  const buildDate = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const env = { MOZCONFIG: mozconfig, MOZ_BUILD_DATE: buildDate, ...secrets };
  const jobs = options.jobs ?? project.config.build?.jobs;

  await withBuildSlot(project.host, options.waitMs, async () => {
    for (const args of [['build', ...(jobs === undefined ? [] : [`-j${jobs}`])], ['package']]) {
      step(`Release: mach ${args.join(' ')}`);
      const result = await runMach(workspace, args, { env });
      if (result.exitCode !== 0) throw machFailure(`mach ${args.join(' ')}`, result);
    }
  });

  // Resolved and staged first: the output directory is not touched until every output is ready.
  const collected = await resolveOutputs(objDir, release.outputs ?? []);
  const staging = tempPathFor(outputDir);
  try {
    for (const path of collected) {
      const target = join(staging, path);
      await ensureDir(dirname(target));
      await cloneTree(join(objDir, path), target, { allowCopy: true });
    }
    const { product, version, sha256, candidate } = project.config.firefox;
    await writeJson(join(staging, RELEASE_RECORD), {
      pin: { product, version, sha256, candidate },
      overlay: { path: release.overlay, sha256: hash(overlay) },
      buildDate,
      secrets: release.secrets?.files ?? [],
      outputs: collected,
    });
    await publishOutputs(staging, outputDir, [...collected, RELEASE_RECORD]);
  } finally {
    await remove(staging);
  }
  const outputs = collected.map((path) => join(outputDir, path));
  for (const output of outputs) info(`Release output: ${output}`);
  return { objDir, outputs, outputDir };
}

/**
 * Packages the workspace's browser.
 *
 * Plain: runs `mach package` on the development build as it stands; the
 * caller makes sure it matches the source first (`ensureBuilt`). Release: builds from clean with the release overlay
 * in the release object directory, with one build date across build and
 * package and the host's secrets directory in the declared variable, then
 * copies the declared outputs and a `release.json` (what decided the release;
 * secret file names, never their content) into the output directory. Every
 * declared output is resolved first and the copies are staged beside the
 * output directory, so a missing output leaves the directory as it was and a
 * failed replacement puts the previous files back. An output directory that
 * overlaps the release object directory is refused before the build starts.
 *
 * @param workspace - The workspace
 * @param options - See {@link PackageOptions}
 * @throws `build-missing`, `mach-failed`, `release-secrets-missing`,
 *   `release-output-missing` (exit code 5); `release-not-configured`,
 *   `release-overlay-missing`, `release-output-overlaps-build` (exit code 2)
 */
export function packageBrowser(
  workspace: Workspace,
  options: PackageOptions = {}
): Promise<PackageResult> {
  return options.release === true
    ? packageRelease(workspace, options)
    : packageDevelopment(workspace);
}
