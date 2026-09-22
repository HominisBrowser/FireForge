// SPDX-License-Identifier: EUPL-1.2
/**
 * Doctor check: can the bootstrapped clang link against the macOS SDK the
 * build will use?
 *
 * An Xcode update can ship an SDK whose `.tbd` stubs the pinned toolchain
 * cannot read (Xcode 27.0's `libSystem.tbd` lists `arm64e.x1-macos`
 * targets that clang/lld 21.1.8 rejects as "unknown architecture"). `mach
 * configure` then dies at "checking what kind of list files are supported
 * by the linker" with exit 5, and neither `build` nor `doctor` named the
 * cause: the operator had to read `config.log`. This check links a trivial
 * C program with the bootstrapped clang against the SDK the mozconfig
 * selects, and on failure names the mismatch and lists the SDKs installed.
 *
 * darwin only, and only when a bootstrapped clang exists. A warning, never
 * a failure: the SDK may be one the operator is about to replace.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mozbuildStateDir } from '../core/toolchain-preflight.js';
import type { DoctorCheck } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { exec } from '../utils/process.js';
import type { DoctorCheckDefinition } from './doctor-check-core.js';
import { ok, warning } from './doctor-check-core.js';

const CHECK_NAME = 'macOS SDK links with the bootstrapped clang';

/** The bootstrapped clang mach uses on macOS. */
export function bootstrappedClangPath(): string {
  return join(mozbuildStateDir(), 'clang', 'bin', 'clang');
}

/**
 * Sources a mozconfig with `ac_add_options` stubbed to print the
 * `--with-macos-sdk=` value, which is how mach reads it. A mozconfig is a
 * shell script: an SDK chosen by shell logic (the first of several
 * candidates that exists) has no literal value to grep.
 */
const SDK_FROM_MOZCONFIG_SCRIPT = [
  'ac_add_options() { for a in "$@"; do case "$a" in --with-macos-sdk=*) printf "%s\\n" "${a#--with-macos-sdk=}";; esac; done; }',
  'mk_add_options() { :; }',
  '. "$1"',
].join('\n');

/** The SDK the build would use, and where that answer came from. */
type SelectedSdk = { sdk: string; source: 'mozconfig' | 'xcrun' } | { error: string };

/**
 * Resolves the SDK the generated mozconfig selects (`--with-macos-sdk`),
 * falling back to `xcrun --show-sdk-path`, which is what configure
 * auto-detects when the mozconfig names none.
 */
async function resolveSelectedSdk(engineDir: string): Promise<SelectedSdk> {
  const mozconfig = join(engineDir, 'mozconfig');
  if (existsSync(mozconfig)) {
    const sourced = await exec('/bin/sh', ['-c', SDK_FROM_MOZCONFIG_SCRIPT, 'sh', mozconfig], {
      cwd: engineDir,
      env: { topsrcdir: engineDir },
      timeout: 10_000,
    });
    if (sourced.exitCode !== 0) {
      return {
        error: `engine/mozconfig failed while selecting the SDK: ${firstLine(sourced.stderr) ?? `exit ${sourced.exitCode}`}`,
      };
    }
    const selected = sourced.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop();
    if (selected !== undefined) return { sdk: selected, source: 'mozconfig' };
  }
  const xcrun = await exec('xcrun', ['--show-sdk-path'], { timeout: 10_000 });
  const path = xcrun.stdout.trim();
  if (xcrun.exitCode !== 0 || path.length === 0) {
    return { error: `xcrun --show-sdk-path failed: ${firstLine(xcrun.stderr) ?? 'no output'}` };
  }
  return { sdk: path, source: 'xcrun' };
}

function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/** Every macOS SDK directory on the host FireForge knows where to look for. */
async function listInstalledSdks(): Promise<string[]> {
  const roots = [mozbuildStateDir(), '/Library/Developer/CommandLineTools/SDKs'];
  const developer = await exec('xcode-select', ['-p'], { timeout: 10_000 });
  if (developer.exitCode === 0 && developer.stdout.trim().length > 0) {
    roots.push(join(developer.stdout.trim(), 'Platforms/MacOSX.platform/Developer/SDKs'));
  }
  const found: string[] = [];
  for (const root of roots) {
    try {
      for (const entry of await readdir(root)) {
        if (/^MacOSX.*\.sdk$/.test(entry)) found.push(join(root, entry));
      }
    } catch {
      // A root that does not exist lists nothing.
    }
  }
  return found;
}

/**
 * Links `int main(void){return 0;}` with the bootstrapped clang (through
 * its bundled lld, as the build does) against `sdk`, in a temp directory.
 * @returns undefined on success, else the first error line clang printed
 */
async function probeSdkLink(clang: string, sdk: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'fireforge-sdk-probe-'));
  try {
    await writeFile(join(dir, 'probe.c'), 'int main(void) { return 0; }\n');
    const lld = existsSync(join(clang, '..', 'ld64.lld')) ? ['-fuse-ld=lld'] : [];
    const linked = await exec(
      clang,
      ['-isysroot', sdk, ...lld, '-o', join(dir, 'probe'), join(dir, 'probe.c')],
      { timeout: 30_000 }
    );
    if (linked.exitCode === 0) return undefined;
    const output = `${linked.stderr}\n${linked.stdout}`;
    return (
      output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /error:/.test(line)) ??
      firstLine(output) ??
      `exit ${linked.exitCode}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs the check for one engine directory. */
export async function checkMacosSdkLink(engineDir: string): Promise<DoctorCheck> {
  const selected = await resolveSelectedSdk(engineDir);
  const fix =
    'Pin an SDK the bootstrapped toolchain can link in configs/darwin.mozconfig ' +
    '(ac_add_options --with-macos-sdk=<path>), then run fireforge build.';
  if ('error' in selected) {
    return warning(CHECK_NAME, selected.error, fix);
  }
  let failure: string | undefined;
  try {
    failure = await probeSdkLink(bootstrappedClangPath(), selected.sdk);
  } catch (error: unknown) {
    failure = toError(error).message;
  }
  if (failure === undefined) {
    return ok(CHECK_NAME, `OK (${selected.sdk}, from ${selected.source})`);
  }
  const installed = await listInstalledSdks();
  return warning(
    CHECK_NAME,
    `The bootstrapped clang cannot link against ${selected.sdk} (from ${selected.source}): ${failure}. ` +
      `mach configure fails at its linker probe the same way. Installed SDKs: ` +
      (installed.length > 0 ? installed.join(', ') : 'none found') +
      '.',
    fix
  );
}

/** Registry entry for the doctor runner. */
export const MACOS_SDK_LINK_DOCTOR_CHECK: DoctorCheckDefinition = {
  name: CHECK_NAME,
  skipIf: (ctx) =>
    process.platform !== 'darwin' || !ctx.engineExists || !existsSync(bootstrappedClangPath()),
  run: (ctx) => checkMacosSdkLink(ctx.paths.engine),
};
