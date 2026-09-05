// SPDX-License-Identifier: EUPL-1.2
/*
 * Platform-gate detection for the post-build dist-tree audit.
 *
 * `moz.build` files commonly wrap entries in conditional blocks like
 * `if CONFIG["MAKENSISU"]:` (Windows-only stubinstaller) or
 * `if CONFIG["OS_TARGET"] == "Darwin":` (macOS-only artwork). On a host that
 * does not match the gate, the wrapped files are never processed by the
 * build, so they cannot appear under `dist/`. Without this detection the
 * audit warns about every gated file on every off-platform build.
 *
 * Two gate sources are consulted, in order:
 *   1. Python-style `if CONFIG[...]:` blocks in the owning `moz.build`.
 *   2. Path-convention gates: certain directory fragments are packaged by
 *      platform-specific Makefile.in / NSIS recipes that FireForge does not
 *      parse, so a file under `browser/installer/windows/` or any
 *      `/stubinstaller/` subtree is Windows-only regardless of what its
 *      nearest moz.build says.
 *
 * The detection is lightweight: walk up from the source file
 * to the closest `moz.build`, scan it for the source basename inside an
 * `if CONFIG[...]:` block, and check whether the gate matches the host. The
 * path-convention pass runs only when no moz.build gate is found, so an
 * explicit gate always wins.
 *
 * Best-effort. False negatives (missing a gate and warning anyway) are
 * tolerable because the audit is warn-only. False positives (skipping a file
 * that should ship on this host) are not tolerable, so it errs toward not
 * skipping when uncertain.
 */

import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { pathExists, readText } from '../utils/fs.js';
import { getPlatform, type Platform } from '../utils/platform.js';
import { escapeRegex } from '../utils/regex.js';

/** Outcome of a moz.build platform-gate lookup for a single source file. */
export interface PlatformGateResult {
  /** True when the file is gated off on the current host. */
  gatedOff: boolean;
  /**
   * The gate expression that excluded the file, if any. Surfaced in
   * verbose output so an operator can confirm the audit's reasoning.
   */
  gateExpression?: string;
}

/**
 * Tokens that uniquely identify a Windows-only `if CONFIG[...]:` block.
 * `MAKENSISU` is the Windows stubinstaller compiler. `OS_TARGET ==
 * "WINNT"` and `MOZ_WIDGET_TOOLKIT == "windows"` are the conventional
 * platform discriminators.
 */
const WINDOWS_ONLY_GATE_TOKENS = ['MAKENSISU', '"WINNT"', "'WINNT'", '"windows"', "'windows'"];

/** Tokens that mark a macOS-only `if CONFIG[...]:` block. */
const DARWIN_ONLY_GATE_TOKENS = ['"Darwin"', "'Darwin'", '"cocoa"', "'cocoa'"];

/** Tokens that mark a Linux-only `if CONFIG[...]:` block. */
const LINUX_ONLY_GATE_TOKENS = ['"Linux"', "'Linux'", '"gtk"', "'gtk'"];

/**
 * Returns true when the platform-gate expression includes one of the
 * tokens characteristic of a single OS that is not the current host.
 */
function isGateOffHost(expression: string, host: Platform): boolean {
  const matchesWindows = WINDOWS_ONLY_GATE_TOKENS.some((t) => expression.includes(t));
  const matchesDarwin = DARWIN_ONLY_GATE_TOKENS.some((t) => expression.includes(t));
  const matchesLinux = LINUX_ONLY_GATE_TOKENS.some((t) => expression.includes(t));

  // Negation gates (`!= "WINNT"`, `not CONFIG["MAKENSISU"]`) flip the
  // semantics. Keep this conservative: if we cannot confidently parse
  // a negation, return false so we don't wrongly suppress a warning.
  const negated = /\bnot\b|!=/.test(expression);
  if (negated) return false;

  if (matchesWindows && host !== 'win32') return true;
  if (matchesDarwin && host !== 'darwin') return true;
  if (matchesLinux && host !== 'linux') return true;
  return false;
}

/**
 * Walks from a starting directory up to (but not above) the engine root,
 * yielding the first `moz.build` encountered. Returns undefined when no
 * ancestor has one, typically only for files that live above any
 * moz.build entry point, which would not be packageable anyway.
 */
async function findOwningMozBuild(
  engineDir: string,
  sourceDir: string
): Promise<string | undefined> {
  let current = sourceDir;
  const root = engineDir.replace(/\/+$/, '');
  while (current.startsWith(root)) {
    const candidate = join(current, 'moz.build');
    if (await pathExists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * Matches a `basename` appearing at the tail of a quoted path literal
 * on a single moz.build line. Catches both the bare entry
 * `"installing_page.css"` and the path-prefixed entry
 * `"stubinstaller/installing_page.css"`.
 */
function matchesQuotedBasename(line: string, basename: string): boolean {
  const escaped = escapeRegex(basename);
  return new RegExp(`["'](?:[^"']*\\/)?${escaped}["']`).test(line);
}

/**
 * Scans a moz.build file for a basename match inside a conditional
 * block, returning the gate expression when one encloses the match.
 *
 * The scanner uses indentation to track block scope (Python-style):
 * an `if CONFIG[…]:` line opens a scope at indent N+1, and dedenting
 * back to indent N closes it. A basename match inside that scope
 * inherits the gate expression.
 *
 * @param content moz.build file content
 * @param basename Basename of the source file we are auditing
 * @returns The enclosing gate expression, or undefined if none
 */
export function findEnclosingGate(content: string, basename: string): string | undefined {
  const lines = content.split('\n');
  const stack: Array<{ indent: number; expression: string }> = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = (/^(\s*)/.exec(line)?.[1] ?? '').length;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top && indent <= top.indent) {
        stack.pop();
        continue;
      }
      break;
    }
    const ifMatch = /^\s*if\s+(.+?):\s*(?:#.*)?$/.exec(line);
    if (ifMatch?.[1]) {
      stack.push({ indent, expression: ifMatch[1] });
      continue;
    }
    if (matchesQuotedBasename(line, basename)) {
      const top = stack[stack.length - 1];
      if (top) return top.expression;
      return undefined;
    }
  }
  return undefined;
}

/**
 * Path-convention gates: directories whose files are packaged by
 * platform-specific build recipes (NSIS stub installer, DMG creation, Linux
 * installer scripts) that live outside the moz.build graph. A file under any
 * of these fragments is platform-restricted regardless of what its nearest
 * `moz.build` says.
 *
 * `stubinstaller/` is the Windows NSIS stub installer asset tree, referenced
 * from `browser/installer/windows/Makefile.in` and `nsis/stub.nsh` rather
 * than through any `if CONFIG[…]:` block an ancestor moz.build exposes.
 */
const PATH_GATES: ReadonlyArray<{ fragment: string; platform: Platform; label: string }> = [
  { fragment: '/stubinstaller/', platform: 'win32', label: 'path convention: /stubinstaller/' },
  {
    fragment: '/browser/installer/windows/',
    platform: 'win32',
    label: 'path convention: browser/installer/windows/',
  },
  {
    fragment: '/browser/installer/macosx/',
    platform: 'darwin',
    label: 'path convention: browser/installer/macosx/',
  },
  {
    fragment: '/browser/installer/linux/',
    platform: 'linux',
    label: 'path convention: browser/installer/linux/',
  },
];

/**
 * Returns a path-convention gate for `sourcePath` when one applies.
 * Leading slash added so `startsWith`-style prefix traps
 * (`browser/installer/windows/…`) match whether or not the input
 * starts with a separator.
 */
function findPathConventionGate(
  sourcePath: string
): { platform: Platform; label: string } | undefined {
  const normalised = `/${sourcePath}`.replace(/\/+/g, '/');
  for (const entry of PATH_GATES) {
    if (normalised.includes(entry.fragment)) {
      return { platform: entry.platform, label: entry.label };
    }
  }
  return undefined;
}

/**
 * Determines whether the given source file is gated off on the current
 * host by an enclosing `if CONFIG[...]:` block in its owning moz.build,
 * or by a path-convention rule for installer-tree subdirectories that
 * are packaged via Makefile.in recipes the audit does not parse.
 * Returns `gatedOff: false` and no expression when no gate is found. The
 * file is not platform-restricted, so the caller should audit it
 * normally.
 *
 * @param engineDir Absolute path to the engine root
 * @param sourcePath Engine-relative POSIX path of the source file
 * @returns Detection result
 */
export async function detectPlatformGate(
  engineDir: string,
  sourcePath: string
): Promise<PlatformGateResult> {
  let host: Platform | undefined;
  try {
    host = getPlatform();
  } catch {
    // Unrecognised host platform. The platform gates below are advisory, so an
    // unknown host disables them rather than failing a warn-only audit.
    host = undefined;
  }

  const sourceDir = dirname(join(engineDir, sourcePath));
  const mozBuild = await findOwningMozBuild(engineDir, sourceDir);
  if (mozBuild) {
    let content: string;
    try {
      content = await readText(mozBuild);
    } catch {
      // An unreadable moz.build contributes no platform gates. The audit is
      // warn-only, so a missing input degrades to 'no gate found', not an error.
      content = '';
    }
    const sourceBasename = sourcePath.split('/').pop() ?? '';
    const expression = findEnclosingGate(content, sourceBasename);
    if (expression) {
      if (host && isGateOffHost(expression, host)) {
        return { gatedOff: true, gateExpression: expression };
      }
      return { gatedOff: false, gateExpression: expression };
    }
  }

  const pathGate = findPathConventionGate(sourcePath);
  if (pathGate && host && host !== pathGate.platform) {
    return { gatedOff: true, gateExpression: pathGate.label };
  }

  return { gatedOff: false };
}

/**
 * Result of an ancestor `DIRS +=` gate lookup.
 */
export interface AncestorDirsGateResult {
  /** True when an ancestor's `DIRS` entry is gated off on this host. */
  gatedOff: boolean;
  /** The gate expression that excluded the directory. */
  gateExpression?: string;
  /** Engine-relative path of the `moz.build` carrying the gate. */
  gateFile?: string;
}

/**
 * Maximum ancestor levels walked looking for a gating `DIRS` entry, and the
 * largest `moz.build` read while doing it. The audit runs on every build, so
 * a pathological tree must not be able to make it slow. Beyond these bounds
 * the walk gives up and the caller keeps today's behaviour (warn).
 */
const MAX_ANCESTOR_DEPTH = 12;
const MAX_MOZ_BUILD_BYTES = 256 * 1024;

/** Matches a line that begins a `DIRS` assignment. */
const DIRS_ASSIGNMENT_PATTERN = /^\s*DIRS\s*\+?=/;

/**
 * Collects the full stack of `if CONFIG[…]:` expressions enclosing the
 * `DIRS` entry whose value equals `relDir`.
 *
 * Two differences from {@link findEnclosingGate}, both load-bearing here:
 * only quoted values inside a `DIRS` assignment are considered (an
 * unrelated string literal elsewhere in the file must not gate a
 * directory), and every enclosing expression is returned rather than the
 * innermost. Firefox nests these: `toolkit/moz.build` reaches
 * `mozapps/defaultagent` inside `OS_ARCH == "WINNT"`, then a `CC_TYPE`
 * test, then `MOZ_DEFAULT_BROWSER_AGENT`, and it is the outermost one that
 * excludes the directory on a macOS host.
 *
 * @param content - `moz.build` file content
 * @param relDir - Directory path relative to the `moz.build`, POSIX-separated
 * @returns Enclosing gate expressions, outermost first. Empty when ungated
 *   or when no `DIRS` entry reaches `relDir`
 */
function findDirsEntryGates(content: string, relDir: string): string[] | undefined {
  const lines = content.split('\n');
  const stack: Array<{ indent: number; expression: string }> = [];
  let inDirs = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = (/^(\s*)/.exec(line)?.[1] ?? '').length;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top && indent <= top.indent) {
        stack.pop();
        continue;
      }
      break;
    }
    const ifMatch = /^\s*if\s+(.+?):\s*(?:#.*)?$/.exec(line);
    if (ifMatch?.[1]) {
      stack.push({ indent, expression: ifMatch[1] });
      inDirs = false;
      continue;
    }
    if (DIRS_ASSIGNMENT_PATTERN.test(line)) {
      // A `DIRS += [` list body continues on later lines. A single-line
      // `DIRS += ["x"]` is fully handled by the match below.
      inDirs = !line.includes(']');
      if (dirsLineNames(line, relDir)) return stack.map((entry) => entry.expression);
      continue;
    }
    if (inDirs) {
      if (dirsLineNames(line, relDir)) return stack.map((entry) => entry.expression);
      if (line.includes(']')) inDirs = false;
    }
  }
  return undefined;
}

/** True when `line` carries `relDir` as a quoted value. */
function dirsLineNames(line: string, relDir: string): boolean {
  const escaped = escapeRegex(relDir.replace(/\/+$/, ''));
  return new RegExp(`["']${escaped}\\/?["']`).test(line);
}

/**
 * Determines whether the source file's directory is excluded from this
 * build by a gate in an ancestor `moz.build`.
 *
 * `detectPlatformGate` reads only the file's own nearest `moz.build`, which
 * misses the common Firefox shape where the whole subtree is reached
 * through a conditional `DIRS +=` one or more levels up: nothing in
 * `toolkit/mozapps/defaultagent/moz.build` says "Windows only", yet none of
 * it is built on macOS.
 *
 * Errs toward not skipping, like the rest of this module: an unreadable or
 * oversized ancestor, or a directory no `DIRS` entry names, yields
 * `gatedOff: false`.
 *
 * @param engineDir - Absolute path to the engine root
 * @param sourcePath - Engine-relative POSIX path of the source file
 */
export async function detectAncestorDirsGate(
  engineDir: string,
  sourcePath: string
): Promise<AncestorDirsGateResult> {
  let host: Platform | undefined;
  try {
    host = getPlatform();
  } catch {
    return { gatedOff: false };
  }

  const segments = sourcePath.split('/').filter(Boolean);
  // Drop the basename: the walk is over directories.
  segments.pop();
  const root = engineDir.replace(/[/\\]+$/, '');

  const depth = Math.min(segments.length, MAX_ANCESTOR_DEPTH);
  // Start at the immediate parent of the file's directory and walk up, so
  // the nearest gating ancestor is found first.
  for (let cut = segments.length - 1; cut >= segments.length - depth; cut -= 1) {
    const ancestorSegments = segments.slice(0, cut);
    const relDir = segments.slice(cut).join('/');
    if (relDir === '') continue;
    const mozBuild = join(root, ...ancestorSegments, 'moz.build');
    if (!(await pathExists(mozBuild))) continue;
    let content: string;
    try {
      const stats = await stat(mozBuild);
      if (stats.size > MAX_MOZ_BUILD_BYTES) continue;
      content = await readText(mozBuild);
    } catch {
      continue;
    }
    const gates = findDirsEntryGates(content, relDir);
    if (gates === undefined) continue;
    const offHost = gates.find((expression) => isGateOffHost(expression, host));
    if (offHost !== undefined) {
      return {
        gatedOff: true,
        gateExpression: offHost,
        gateFile: [...ancestorSegments, 'moz.build'].join('/'),
      };
    }
    // The directory is reached from here and this host passes every gate.
    // A further ancestor cannot un-reach it.
    return { gatedOff: false };
  }

  return { gatedOff: false };
}
