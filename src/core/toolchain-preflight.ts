// SPDX-License-Identifier: EUPL-1.2
/**
 * Toolchain-minimum awareness for Firefox source hops.
 *
 * When `fireforge download --force` moves the engine to a new Firefox
 * MAJOR version, the tree's declared toolchain minimums (cbindgen, Rust)
 * frequently move with it — and the first `fireforge build` then dies a
 * few seconds into `mach configure` with a message whose remediation
 * text names `./mach bootstrap`, the wrong tool for a FireForge-managed
 * repo (152.0b7 → 153.0b8 source-refresh drill: `ERROR: cbindgen version
 * 0.29.1 is too old. At least version 0.29.4 is required.`).
 *
 * Two layers:
 *  1. {@link formatMajorVersionHopNotice} — a post-download nudge when
 *     the downloaded major differs from the previously downloaded one.
 *  2. {@link runToolchainPreflight} — a cheap pre-build probe comparing
 *     the minimums the tree itself declares against the host binaries
 *     `mach configure` will resolve. Deliberately FAIL-SOFT: it reports
 *     a mismatch only when a minimum was positively parsed AND the host
 *     binary was found AND its version is definitively lower. Any
 *     uncertainty (file moved upstream, unparseable output, binary not
 *     on PATH) skips silently — the mach-error-hints translator still
 *     catches the real configure failure downstream.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';

/** Tools the preflight knows how to probe. */
export type ToolchainTool = 'cbindgen' | 'rustc';

/** Where each tool's minimum is declared inside the Firefox tree. */
const MINIMUM_DECLARATIONS: Record<ToolchainTool, { relPath: string; pattern: RegExp }> = {
  // build/moz.configure/bindgen.configure:
  //   cbindgen_min_version = Version("0.27.0")
  cbindgen: {
    relPath: 'build/moz.configure/bindgen.configure',
    pattern: /cbindgen_min_version\s*=\s*Version\(\s*["']([\d.]+)["']\s*\)/,
  },
  // python/mozboot/mozboot/util.py:
  //   MINIMUM_RUST_VERSION = "1.82.0"
  // (build/moz.configure/rust.configure imports this constant, so the
  // mozboot file is the single authority in the tree.)
  rustc: {
    relPath: 'python/mozboot/mozboot/util.py',
    pattern: /MINIMUM_RUST_VERSION\s*=\s*["']([\d.]+)["']/,
  },
};

/** How each tool's host binary is resolved and its version parsed. */
const HOST_PROBES: Record<ToolchainTool, { envVar: string; versionPattern: RegExp }> = {
  // `mach configure` honours the CBINDGEN env option (bindgen.configure's
  // `option(env="CBINDGEN", ...)`), so the probe must too — otherwise the
  // preflight could veto a build configure would have accepted.
  cbindgen: { envVar: 'CBINDGEN', versionPattern: /cbindgen\s+(\d+(?:\.\d+)*)/ },
  rustc: { envVar: 'RUSTC', versionPattern: /rustc\s+(\d+(?:\.\d+)*)/ },
};

/** One definitive host-vs-tree mismatch found by the preflight. */
export interface ToolchainMismatch {
  tool: ToolchainTool;
  hostVersion: string;
  minimumVersion: string;
  /** Engine-relative file the minimum was parsed from. */
  declaredIn: string;
}

/**
 * Parses a dotted version string into numeric components. Trailing
 * non-numeric suffixes are ignored; returns undefined when the string
 * does not start with a number. (Same posture as the furnace version
 * drift classifier, kept local so the two modules stay decoupled.)
 */
function parseVersionComponents(version: string): number[] | undefined {
  const match = /^(\d+(?:\.\d+)*)/.exec(version.trim());
  if (!match?.[1]) return undefined;
  return match[1].split('.').map(Number);
}

/** Component-wise comparison; missing components count as 0. */
function isVersionLower(candidate: number[], minimum: number[]): boolean {
  const length = Math.max(candidate.length, minimum.length);
  for (let i = 0; i < length; i += 1) {
    const a = candidate[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * Returns the one-line notice to print after a download that hopped the
 * Firefox MAJOR version, or undefined when no notice is warranted (first
 * download, same major, or unparseable versions — an unparseable version
 * must not spam every download with a false hint).
 *
 * @param previousVersion - `downloadedVersion` recorded in state before this download
 * @param newVersion - Version that was just downloaded
 */
export function formatMajorVersionHopNotice(
  previousVersion: string | undefined,
  newVersion: string
): string | undefined {
  if (!previousVersion) return undefined;
  const previousMajor = parseVersionComponents(previousVersion)?.[0];
  const newMajor = parseVersionComponents(newVersion)?.[0];
  if (previousMajor === undefined || newMajor === undefined) return undefined;
  if (previousMajor === newMajor) return undefined;
  return (
    `Firefox major version changed (${String(previousMajor)} → ${String(newMajor)}): ` +
    'upstream toolchain minimums (cbindgen, Rust, …) may have moved with it. ' +
    'Consider running "fireforge bootstrap" before the next build.'
  );
}

/**
 * Reads the toolchain minimums the engine tree itself declares. Any file
 * that is missing or no longer matches the expected declaration shape
 * yields undefined for that tool — never an error.
 */
export async function readDeclaredToolchainMinimums(
  engineDir: string
): Promise<Partial<Record<ToolchainTool, string>>> {
  const minimums: Partial<Record<ToolchainTool, string>> = {};
  for (const [tool, declaration] of Object.entries(MINIMUM_DECLARATIONS) as [
    ToolchainTool,
    (typeof MINIMUM_DECLARATIONS)[ToolchainTool],
  ][]) {
    const filePath = join(engineDir, declaration.relPath);
    if (!(await pathExists(filePath))) {
      verbose(`Toolchain preflight: ${declaration.relPath} not found; skipping ${tool}.`);
      continue;
    }
    try {
      const content = await readText(filePath);
      const match = declaration.pattern.exec(content);
      if (match?.[1]) {
        minimums[tool] = match[1];
      } else {
        verbose(
          `Toolchain preflight: no ${tool} minimum declaration recognized in ${declaration.relPath}; skipping.`
        );
      }
    } catch (error: unknown) {
      verbose(
        `Toolchain preflight: could not read ${declaration.relPath} (${error instanceof Error ? error.message : String(error)}); skipping ${tool}.`
      );
    }
  }
  return minimums;
}

/** Runs `<binary> --version` and parses the leading version number. */
async function probeHostToolVersion(tool: ToolchainTool): Promise<string | undefined> {
  const probe = HOST_PROBES[tool];
  const binary = process.env[probe.envVar] ?? tool;
  const output = await new Promise<string | undefined>((resolvePromise) => {
    execFile(binary, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      resolvePromise(err ? undefined : stdout);
    });
  });
  if (output === undefined) {
    verbose(`Toolchain preflight: "${binary} --version" failed or not found; skipping ${tool}.`);
    return undefined;
  }
  const match = probe.versionPattern.exec(output);
  if (!match?.[1]) {
    verbose(`Toolchain preflight: could not parse ${tool} version from "${output.trim()}".`);
    return undefined;
  }
  return match[1];
}

/**
 * Compares the tree-declared toolchain minimums against the host binaries
 * `mach configure` will resolve. Returns only DEFINITIVE mismatches; every
 * uncertain probe passes silently (see module header for the rationale).
 *
 * @param engineDir - Path to the engine directory
 */
export async function runToolchainPreflight(engineDir: string): Promise<ToolchainMismatch[]> {
  const minimums = await readDeclaredToolchainMinimums(engineDir);
  const mismatches: ToolchainMismatch[] = [];

  for (const [tool, minimumVersion] of Object.entries(minimums) as [ToolchainTool, string][]) {
    const minimum = parseVersionComponents(minimumVersion);
    if (!minimum) continue;
    const hostVersion = await probeHostToolVersion(tool);
    if (hostVersion === undefined) continue;
    const host = parseVersionComponents(hostVersion);
    if (!host) continue;
    if (isVersionLower(host, minimum)) {
      mismatches.push({
        tool,
        hostVersion,
        minimumVersion,
        declaredIn: MINIMUM_DECLARATIONS[tool].relPath,
      });
    } else {
      verbose(`Toolchain preflight: ${tool} ${hostVersion} satisfies minimum ${minimumVersion}.`);
    }
  }

  return mismatches;
}

/**
 * Formats the fail-fast message for definitive preflight mismatches,
 * naming `fireforge bootstrap` as the remedy (mach's own configure error
 * suggests `./mach bootstrap`, which is the wrong entry point for a
 * FireForge-managed repo).
 */
export function formatToolchainMismatchMessage(mismatches: ToolchainMismatch[]): string {
  const lines = mismatches.map(
    (m) =>
      `  - ${m.tool} ${m.hostVersion} is older than the minimum ${m.minimumVersion} declared by this Firefox source (engine/${m.declaredIn})`
  );
  return (
    'Toolchain preflight found host tools older than what this Firefox source requires:\n' +
    `${lines.join('\n')}\n\n` +
    'This typically happens after "fireforge download --force" moved the engine to a new ' +
    'Firefox major version. Run "fireforge bootstrap" to update the toolchain, then retry the build.'
  );
}
