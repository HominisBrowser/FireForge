// SPDX-License-Identifier: EUPL-1.2
/**
 * Toolchain-minimum awareness for Firefox source hops.
 *
 * When `fireforge download --force` moves the engine to a new Firefox MAJOR
 * version, the tree's declared toolchain minimums (cbindgen, Rust)
 * frequently move with it — and the first `fireforge build` then dies a few
 * seconds into `mach configure` with a message whose remediation text names
 * `./mach bootstrap`, the wrong tool for a FireForge-managed repo (e.g.
 * `ERROR: cbindgen version 0.29.1 is too old. At least version 0.29.4 is
 * required.`).
 *
 * Two layers:
 *  1. {@link formatMajorVersionHopNotice} — a post-download nudge when the
 *     downloaded major differs from the previously downloaded one.
 *  2. {@link runToolchainPreflight} — a cheap pre-build probe comparing the
 *     minimums the tree itself declares against the host binaries
 *     `mach configure` will resolve, probing configure's own candidate
 *     order: env override first, then the `~/.mozbuild` state-directory copy
 *     bootstrap installs, then PATH. Probing env-or-PATH alone blocks builds
 *     whose current tool lives in the state dir behind a stale PATH copy.
 *     Deliberately FAIL-SOFT: it reports a mismatch only when a minimum was
 *     positively parsed AND at least one candidate resolved AND every
 *     resolved candidate is definitively lower. Any uncertainty (file moved
 *     upstream, unparseable output, no candidate found) skips silently — the
 *     mach-error-hints translator still catches the real configure failure
 *     downstream.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';

/** Tools the preflight knows how to probe. */
export type ToolchainTool = 'cbindgen' | 'rustc';

/**
 * Resolves the mach state directory the same way mach itself does:
 * `$MOZBUILD_STATE_PATH`, else `~/.mozbuild` (same resolution as
 * `mach-resource-shim.ts`).
 */
function mozbuildStateDir(): string {
  return process.env['MOZBUILD_STATE_PATH'] ?? join(homedir(), '.mozbuild');
}

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

/**
 * How each tool's host binary is resolved and its version parsed.
 *
 * `stateDirRelPaths` are the mach-state-directory locations
 * `fireforge bootstrap` (via mozboot) installs the tool to. mach's configure
 * tries the state directory BEFORE the PATH candidates —
 * bindgen.configure's toolchain search path lists `~/.mozbuild/cbindgen/
 * cbindgen` first — so the probe must too. Probing only env-or-PATH fails a
 * build configure would have accepted whenever an old `~/.cargo/bin/
 * cbindgen` shadows a current bootstrap-installed copy. Rust has no
 * state-dir install — rustup owns it — so its list is empty.
 */
const HOST_PROBES: Record<
  ToolchainTool,
  { envVar: string; versionPattern: RegExp; stateDirRelPaths: readonly string[] }
> = {
  // `mach configure` honours the CBINDGEN env option (bindgen.configure's
  // `option(env="CBINDGEN", ...)`), so the probe must too — otherwise the
  // preflight could veto a build configure would have accepted.
  cbindgen: {
    envVar: 'CBINDGEN',
    versionPattern: /cbindgen\s+(\d+(?:\.\d+)*)/,
    stateDirRelPaths: ['cbindgen/cbindgen'],
  },
  rustc: { envVar: 'RUSTC', versionPattern: /rustc\s+(\d+(?:\.\d+)*)/, stateDirRelPaths: [] },
};

/** One probed candidate binary for a tool. */
export interface ToolchainCandidate {
  /** Binary path (or bare name for the PATH candidate). */
  binary: string;
  /** Parsed version of the candidate. */
  version: string;
}

/** One definitive host-vs-tree mismatch found by the preflight. */
export interface ToolchainMismatch {
  tool: ToolchainTool;
  minimumVersion: string;
  /** Engine-relative file the minimum was parsed from. */
  declaredIn: string;
  /**
   * Every candidate that resolved — all of them below the minimum
   * (mach-resolution order: env override, mozbuild state dir, PATH).
   */
  candidates: ToolchainCandidate[];
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
  const entries = Object.entries(MINIMUM_DECLARATIONS) as [
    ToolchainTool,
    (typeof MINIMUM_DECLARATIONS)[ToolchainTool],
  ][];
  const resolved = await Promise.all(
    entries.map(async ([tool, declaration]) => {
      const filePath = join(engineDir, declaration.relPath);
      if (!(await pathExists(filePath))) {
        verbose(`Toolchain preflight: ${declaration.relPath} not found; skipping ${tool}.`);
        return undefined;
      }
      try {
        const content = await readText(filePath);
        const match = declaration.pattern.exec(content);
        if (match?.[1]) {
          return [tool, match[1]] as const;
        } else {
          verbose(
            `Toolchain preflight: no ${tool} minimum declaration recognized in ${declaration.relPath}; skipping.`
          );
        }
      } catch (error: unknown) {
        verbose(
          `Toolchain preflight: could not read ${declaration.relPath} (${toError(error).message}); skipping ${tool}.`
        );
      }
      return undefined;
    })
  );
  return Object.fromEntries(resolved.filter((entry) => entry !== undefined));
}

/** Runs `<binary> --version` and parses the leading version number. */
async function probeBinaryVersion(
  binary: string,
  versionPattern: RegExp
): Promise<string | undefined> {
  const output = await new Promise<string | undefined>((resolvePromise) => {
    execFile(binary, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      resolvePromise(err ? undefined : stdout);
    });
  });
  if (output === undefined) return undefined;
  const match = versionPattern.exec(output);
  if (!match?.[1]) {
    verbose(`Toolchain preflight: could not parse a version from "${output.trim()}" (${binary}).`);
    return undefined;
  }
  return match[1];
}

/**
 * Probes every candidate binary for a tool in mach's resolution order:
 * the env override (which, when set, is the ONLY candidate — configure
 * uses it even when a better binary exists elsewhere), then the mozbuild
 * state-directory copy bootstrap installs, then PATH. Candidates that
 * fail to run or to parse are dropped silently.
 */
async function probeHostToolCandidates(tool: ToolchainTool): Promise<ToolchainCandidate[]> {
  const probe = HOST_PROBES[tool];
  const envOverride = process.env[probe.envVar];
  const binaries = envOverride
    ? [envOverride]
    : [...probe.stateDirRelPaths.map((rel) => join(mozbuildStateDir(), rel)), tool];

  const candidates = await Promise.all(
    binaries.map(async (binary): Promise<ToolchainCandidate | undefined> => {
      const version = await probeBinaryVersion(binary, probe.versionPattern);
      if (version !== undefined) return { binary, version };
      verbose(`Toolchain preflight: "${binary} --version" failed or not found; skipping.`);
      return undefined;
    })
  );
  return candidates.filter((candidate) => candidate !== undefined);
}

/**
 * Compares the tree-declared toolchain minimums against the host binaries
 * `mach configure` will resolve, in configure's own candidate order (env
 * override, mozbuild state dir, PATH). A tool fails ONLY when at least
 * one candidate resolved and none of them meets the minimum; any single
 * passing candidate passes the tool (configure will find it), and a tool
 * with no resolvable candidate skips silently (see module header for the
 * fail-soft rationale).
 *
 * @param engineDir - Path to the engine directory
 */
export async function runToolchainPreflight(engineDir: string): Promise<ToolchainMismatch[]> {
  const minimums = await readDeclaredToolchainMinimums(engineDir);
  const results = await Promise.all(
    (Object.entries(minimums) as [ToolchainTool, string][]).map(async ([tool, minimumVersion]) => {
      const minimum = parseVersionComponents(minimumVersion);
      if (!minimum) return undefined;
      const candidates = await probeHostToolCandidates(tool);
      const parsed = candidates.filter((c) => parseVersionComponents(c.version) !== undefined);
      if (parsed.length === 0) return undefined;
      const satisfying = parsed.find((c) => {
        const components = parseVersionComponents(c.version);
        return components !== undefined && !isVersionLower(components, minimum);
      });
      if (satisfying) {
        verbose(
          `Toolchain preflight: ${tool} ${satisfying.version} (${satisfying.binary}) satisfies minimum ${minimumVersion}.`
        );
        return undefined;
      }
      return {
        tool,
        minimumVersion,
        declaredIn: MINIMUM_DECLARATIONS[tool].relPath,
        candidates: parsed,
      } satisfies ToolchainMismatch;
    })
  );

  return results.filter((mismatch) => mismatch !== undefined);
}

/**
 * Formats the fail-fast message for definitive preflight mismatches,
 * listing every candidate probed (in mach's resolution order) and naming
 * `fireforge bootstrap` as the remedy (mach's own configure error
 * suggests `./mach bootstrap`, which is the wrong entry point for a
 * FireForge-managed repo).
 */
export function formatToolchainMismatchMessage(mismatches: ToolchainMismatch[]): string {
  const lines = mismatches.map((m) => {
    const probed = m.candidates.map((c) => `${c.version} (${c.binary})`).join(', ');
    return (
      `  - ${m.tool}: no resolvable candidate meets the minimum ${m.minimumVersion} declared by ` +
      `this Firefox source (engine/${m.declaredIn}); probed in mach's resolution order: ${probed}`
    );
  });
  return (
    'Toolchain preflight found host tools older than what this Firefox source requires:\n' +
    `${lines.join('\n')}\n\n` +
    'This typically happens after "fireforge download --force" moved the engine to a new ' +
    'Firefox major version. Run "fireforge bootstrap" to update the toolchain, then retry the build.'
  );
}
