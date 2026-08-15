// SPDX-License-Identifier: EUPL-1.2
/*
 * Platform-gate detection for the post-build dist-tree audit.
 *
 * `moz.build` files commonly wrap entries in conditional blocks like
 * `if CONFIG["MAKENSISU"]:` (Windows-only stubinstaller) or
 * `if CONFIG["OS_TARGET"] == "Darwin":` (macOS-only artwork). On a host
 * that does not match the gate, the wrapped files are never processed
 * by the build, so they cannot appear under `dist/`. Without this
 * detection, the audit fires a "missing packaged artifact" warning for
 * every gated file on every off-platform build — pure noise.
 *
 * Two gate sources are consulted, in order:
 *   1. Python-style `if CONFIG[...]:` blocks in the owning `moz.build`.
 *   2. Path-convention gates — certain directory fragments are packaged
 *      by platform-specific Makefile.in / NSIS recipes that FireForge
 *      does not parse, so a file living under `browser/installer/windows/`
 *      or any `/stubinstaller/` subtree is Windows-only regardless of
 *      what its nearest moz.build says. (The branding stubinstaller CSS
 *      is the motivating case: referenced from
 *      `browser/installer/windows/Makefile.in` / `nsis/stub.nsh` with no
 *      `if CONFIG[…]:` in any moz.build ancestor.)
 *
 * The detection is intentionally lightweight: we walk up from the
 * source file looking for the closest `moz.build`, scan it for an
 * occurrence of the source basename inside an `if CONFIG[...]:` block,
 * and check whether the gate expression matches the host platform.
 * The path-convention pass kicks in only when no moz.build gate is
 * found, so an explicit moz.build gate always wins.
 *
 * This is best-effort. False negatives (we miss a gate and warn anyway)
 * are tolerable — the audit is warn-only. False positives (we wrongly
 * skip a gated file that should ship on this host) are not, so the
 * detection errs toward NOT skipping when uncertain.
 */

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
 * `MAKENSISU` is the Windows stubinstaller compiler; `OS_TARGET ==
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
  // semantics. Keep this conservative — if we cannot confidently parse
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
 * ancestor has one — typically only for files that live above any
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
 * platform-specific build recipes (NSIS stub installer, DMG creation,
 * Linux installer scripts) that live outside the moz.build graph. A
 * file under any of these fragments is platform-restricted regardless
 * of what its nearest `moz.build` says.
 *
 * `stubinstaller/` is the Windows NSIS stub installer asset tree. It
 * is referenced from `browser/installer/windows/Makefile.in` (via
 * `FILES` / `_WIDGET_FILES` lists) and `nsis/stub.nsh`, never through
 * an `if CONFIG[…]:` block an ancestor moz.build exposes. Without
 * this path-level gate, the audit warns on every touched branding
 * stubinstaller CSS on every non-Windows build.
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
 * OR by a path-convention rule for installer-tree subdirectories that
 * are packaged via Makefile.in recipes the audit does not parse.
 * Returns `gatedOff: false` and no expression when no gate is found —
 * the file is not platform-restricted, so the caller should audit it
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
