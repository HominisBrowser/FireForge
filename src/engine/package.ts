// SPDX-License-Identifier: EUPL-1.2
/**
 * Packaging the browser. A plain package ships the development build as it
 * stands. A release is built for the purpose: with the project's release
 * overlay appended to the mozconfig, in an object directory of its own that
 * is emptied first, so nothing an earlier build left reaches it and the
 * development build stays untouched.
 */
import { dirname, join, posix } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import {
  cloneTree,
  ensureDir,
  exists,
  listDir,
  pathInfo,
  readTextIfExists,
  remove,
  writeFile,
} from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { writeJson } from '../kernel/json.js';
import { info, step } from '../kernel/log.js';
import { escapeRegExp } from '../kernel/text.js';
import { readHostConfig, withBuildSlot } from './hostLocks.js';
import { machFailure, runMach } from './mach.js';
import { renderMozconfig } from './mozconfig.js';
import { requireBuilt } from './objdir.js';
import type { Workspace } from './workspace.js';

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

  const outputDir = options.outputDir ?? join(project.paths.stateDir, 'release-output');
  const outputs: string[] = [];
  const collected: string[] = [];
  for (const declared of release.outputs ?? []) {
    const matches = await matchReleaseOutput(objDir, declared);
    if (matches.length === 0) {
      throw refusal(
        'release-output-missing',
        `The release build did not produce ${declared} in ${objDir}`
      );
    }
    for (const path of matches) {
      const target = join(outputDir, path);
      await remove(target);
      await ensureDir(dirname(target));
      await cloneTree(join(objDir, path), target, { allowCopy: true });
      outputs.push(target);
      collected.push(path);
      info(`Release output: ${target}`);
    }
  }
  const { product, version, sha256 } = project.config.firefox;
  await writeJson(join(outputDir, 'release.json'), {
    pin: { product, version, sha256 },
    overlay: { path: release.overlay, sha256: hash(overlay) },
    buildDate,
    secrets: release.secrets?.files ?? [],
    outputs: collected,
  });
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
 * secret file names, never their content) into the output directory.
 *
 * @param workspace - The workspace
 * @param options - See {@link PackageOptions}
 * @throws `build-missing`, `mach-failed`, `release-secrets-missing`,
 *   `release-output-missing` (exit code 5); `release-not-configured`,
 *   `release-overlay-missing` (exit code 2)
 */
export function packageBrowser(
  workspace: Workspace,
  options: PackageOptions = {}
): Promise<PackageResult> {
  return options.release === true
    ? packageRelease(workspace, options)
    : packageDevelopment(workspace);
}
