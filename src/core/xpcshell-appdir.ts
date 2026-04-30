// SPDX-License-Identifier: EUPL-1.2
/**
 * Auto-injects `--app-path=<abs>` into `mach test` invocations whose nearest
 * xpcshell.toml sets `firefox-appdir = "browser"` (or `<appname>-appdir = …`)
 * but whose `appname` is not `firefox`.
 *
 * ## Why this exists
 *
 * The upstream xpcshell harness computes the manifest key for the appdir
 * override as `mozInfo["appname"] + "-appdir"`. On a stock Firefox build the
 * key is `firefox-appdir`, so the very common `firefox-appdir = "browser"`
 * directive is honoured. On a rebranded fork (appname=`mybrowser`, …) the
 * harness looks for `mybrowser-appdir`
 * — the literal `firefox-appdir` line is silently ignored, `appPath` falls
 * back to `xrePath`, and every `resource:///modules/…` import throws
 * `Failed to load resource:///modules/<name>.sys.mjs` because xpcshell now
 * resolves the `resource:///` prefix one level above the real app root.
 *
 * ## Strategy
 *
 * 1. For each test path the operator handed us, find the nearest
 *    `xpcshell.toml`. If none exists, the test is not an xpcshell test and
 *    nothing to inject.
 * 2. Read the manifest's `[DEFAULT]` section. Look for `<appname>-appdir`
 *    first — if present, the harness already finds it and there's nothing to
 *    do. Fall back to `firefox-appdir`. This ordering matches upstream
 *    precedence and avoids overriding an operator who already migrated.
 * 3. If only `firefox-appdir` is present and `appname != "firefox"`, compute
 *    the absolute app dir path against the active `obj-X/dist` tree
 *    (probing `dist/bin/<value>` first, then any `dist/<bundle>.app/Contents/
 *    Resources/<value>` for the macOS packaged layout) and return it as
 *    the value to pass to `--app-path`.
 * 4. If multiple test paths disagree on the resolved value (e.g. one
 *    manifest sets `browser`, another sets `xulrunner`), refuse injection
 *    and return null — the operator can drop down to `--mach-arg`.
 *
 * Operator escape hatches: `--mach-arg=--app-path=…` always wins (handled in
 * test.ts; we skip injection when `--app-path=` already appears in the
 * forwarded args).
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { pathExists, readJson, readText } from '../utils/fs.js';
import { isObject, isString } from '../utils/validation.js';

/**
 * Result of attempting to resolve the auto-injected `--app-path` value.
 * Carries enough context for the caller to log a useful info line and for
 * the diagnostic hint to know whether an injection was attempted.
 */
export interface AppdirResolveResult {
  /** Absolute path to the app dir. Pass as `--app-path=<value>`. */
  appPath: string;
  /** Manifest the value was sourced from. Used for the info log. */
  manifestPath: string;
  /** Manifest key (e.g. `firefox-appdir`) that triggered the injection. */
  key: string;
  /** Relative appdir from the manifest (e.g. `browser`). */
  relativeAppdir: string;
}

/**
 * `[DEFAULT]` section parser shaped to the narrow case we need: pull a
 * single key/value out without depending on a real TOML parser. Avoids
 * pulling a TOML dep into the test path for a one-shot lookup.
 *
 * Accepts:
 *  - Single- or double-quoted values
 *  - Whitespace either side of `=`
 *  - Continuation comments (`#` or `;`) at the end of the line
 *  - Bare unquoted bareword values (e.g. `firefox-appdir = browser`) — some
 *    operators omit the quotes and the harness honours either form.
 *
 * Returns `undefined` when the key is absent or sits outside `[DEFAULT]`.
 */
export function parseAppdirFromToml(
  tomlText: string,
  key: string
): { value: string; lineIndex: number } | undefined {
  const lines = tomlText.split(/\r?\n/);
  let inDefault = false;
  let sectionSeen = false;
  // Anchored on the start of the line so a `# firefox-appdir = "…"`-style
  // comment further along the file is not mistaken for the directive.
  const escapedKey = escapeRegex(key);
  const keyPattern = new RegExp('^\\s*' + escapedKey + '\\s*=\\s*(.+?)\\s*(?:[#;].*)?$');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      sectionSeen = true;
      inDefault = sectionMatch[1]?.trim().toUpperCase() === 'DEFAULT';
      continue;
    }
    // The implicit pre-section region of an xpcshell.toml is treated as
    // [DEFAULT] by the upstream parser, so we honour the same convention.
    const inImplicitDefault = !sectionSeen;
    if (!inDefault && !inImplicitDefault) continue;

    const match = keyPattern.exec(line);
    if (!match) continue;
    const raw = (match[1] ?? '').trim();
    const value = stripQuotes(raw);
    if (value === undefined) continue;
    return { value, lineIndex: i };
  }
  return undefined;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripQuotes(raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Bareword: must not contain whitespace; otherwise we are looking at
  // commentary that the regex's optional comment tail did not strip.
  if (/\s/.test(raw)) return undefined;
  return raw;
}

/**
 * Walks up from `startPath` (a file or directory under `engineDir`) and
 * returns the absolute path of the first sibling `xpcshell.toml` found.
 * Stops at `engineDir` (inclusive) and returns null on miss.
 *
 * Special-cases `startPath` itself when it already ends with
 * `xpcshell.toml` — operators sometimes pass a manifest path directly.
 */
export async function findNearestXpcshellManifest(
  engineDir: string,
  startPath: string
): Promise<string | null> {
  const absStart = resolve(engineDir, startPath);
  if (absStart.toLowerCase().endsWith(`${sep}xpcshell.toml`)) {
    return (await pathExists(absStart)) ? absStart : null;
  }

  const engineAbs = resolve(engineDir);
  let current = absStart;
  // First iteration walks down to a directory; subsequent ones walk up.
  // Cap iterations defensively — a pathological symlink loop would
  // otherwise spin until the call stack overflows.
  for (let i = 0; i < 64; i += 1) {
    const dir = i === 0 ? dirname(absStart) : dirname(current);
    const candidate = join(dir, 'xpcshell.toml');
    if (await pathExists(candidate)) return candidate;
    if (dir === engineAbs || dir === dirname(dir)) return null;
    current = dir;
  }
  return null;
}

/**
 * Reads `<objDir>/mozinfo.json` for the active app name. Returns
 * `"firefox"` when mozinfo cannot be read or the field is missing — that
 * is the safe default because it matches stock Firefox behaviour and
 * means the resolver will not inject anything (the manifest's
 * `firefox-appdir` value WILL be honoured by the upstream harness when
 * appname is firefox).
 */
export async function readMozinfoAppname(objDirPath: string): Promise<string> {
  const mozinfoPath = join(objDirPath, 'mozinfo.json');
  if (!(await pathExists(mozinfoPath))) return 'firefox';
  try {
    const data = await readJson(mozinfoPath);
    if (isObject(data) && isString(data['appname'])) {
      return data['appname'];
    }
  } catch {
    // Malformed mozinfo is a build-system problem out of scope for the
    // appdir resolver; treat as if appname were missing.
  }
  return 'firefox';
}

/**
 * Probes the obj-dir's `dist/` subtree for the absolute path that the
 * harness would have computed if the manifest key had been honoured.
 * Returns null when no candidate exists — better to skip injection
 * silently than to point the harness at a path that doesn't exist
 * (which fails with a different error than the original `firefox-appdir`
 * symptom and confuses triage).
 *
 * Probe order differs by host platform:
 *
 * - **macOS (`darwin`)**: prefer `<objDir>/dist/<App>.app/Contents/Resources/
 *   <value>` FIRST, then fall back to `<objDir>/dist/bin/<value>`.
 *   2026-04-24 eval Finding 8: on macOS `dist/bin` is symlinked to
 *   `dist/<App>.app/Contents/MacOS/` (the *binaries* directory), so
 *   `dist/bin/browser` actually resolves to `<App>.app/Contents/MacOS/
 *   browser/`. That is NOT where `resource:///modules/` is rooted — on
 *   macOS, `-a` for xpcshell must point at the `.app/Contents/Resources/
 *   <value>` subtree where modules / chrome.manifest live. Returning
 *   `dist/bin/browser` caused the injected `--app-path` to look
 *   successful (the info log showed it) but pointed at a directory
 *   without the modules tree, so every `resource:///modules/…` import
 *   still threw.
 * - **non-macOS**: keep the historical order — `dist/bin/<value>` first,
 *   `.app/Contents/Resources/<value>` as fallback.
 *
 * On both platforms the final `.app` fallback iterates every `*.app`
 * entry because a rebranded fork may pick an arbitrary app name.
 */
export async function resolveAbsoluteAppPath(
  objDirAbs: string,
  relativeAppdir: string
): Promise<string | null> {
  const distBinCandidate = join(objDirAbs, 'dist', 'bin', relativeAppdir);
  const distDir = join(objDirAbs, 'dist');
  const isMacos = process.platform === 'darwin';

  async function probeMacAppBundle(): Promise<string | null> {
    if (!(await pathExists(distDir))) return null;
    let entries: string[];
    try {
      entries = await readdir(distDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue;
      const candidate = join(distDir, entry, 'Contents', 'Resources', relativeAppdir);
      if (await pathExists(candidate)) return candidate;
    }
    return null;
  }

  if (isMacos) {
    const appBundle = await probeMacAppBundle();
    if (appBundle) return appBundle;
    if (await pathExists(distBinCandidate)) return distBinCandidate;
    return null;
  }

  if (await pathExists(distBinCandidate)) return distBinCandidate;
  return probeMacAppBundle();
}

/**
 * Outcome carrier for {@link resolveXpcshellAppdirArg}. Distinguishes the
 * three "did nothing" cases so callers can shape diagnostics:
 *  - `none`: no manifest under any test path needs injection.
 *  - `mismatch`: at least two manifests resolved to different values; we
 *    refuse to guess which one the operator meant.
 *  - `unresolved`: the manifest asks for `firefox-appdir = "<value>"` but
 *    no `dist/` candidate exists for that value.
 *  - `injected`: the absolute path to pass via `--app-path=`.
 */
export type XpcshellAppdirOutcome =
  | { kind: 'none' }
  | { kind: 'mismatch'; values: string[] }
  | { kind: 'unresolved'; relativeAppdir: string; manifestPath: string }
  | { kind: 'injected'; result: AppdirResolveResult };

/**
 * Top-level resolver. Walks every test path, reads the nearest
 * xpcshell.toml, and returns the single absolute path to inject (or a
 * structured "no injection" outcome). Never throws — every fs / parse
 * error is folded into a `none` outcome so the test command always falls
 * through to the diagnostic hint instead of dying inside a helper.
 */
export async function resolveXpcshellAppdirArg(
  engineDir: string,
  testPaths: readonly string[],
  objDirName: string
): Promise<XpcshellAppdirOutcome> {
  if (testPaths.length === 0) return { kind: 'none' };

  const objDirAbs = resolve(engineDir, objDirName);
  const appname = await readMozinfoAppname(objDirAbs);
  // When appname IS "firefox" the upstream harness reads `firefox-appdir`
  // natively. Injecting in that case would be a no-op at best and an
  // override at worst, so bail out before doing any IO per-path.
  if (appname === 'firefox') return { kind: 'none' };

  const appnameKey = `${appname}-appdir`;
  const seenInjections = new Map<string, AppdirResolveResult>();

  for (const testPath of testPaths) {
    const manifestPath = await findNearestXpcshellManifest(engineDir, testPath);
    if (!manifestPath) continue;
    let body: string;
    try {
      body = await readText(manifestPath);
    } catch {
      continue;
    }

    // Operator already migrated — harness will read the appname-keyed
    // value directly. Nothing to do.
    if (parseAppdirFromToml(body, appnameKey) !== undefined) continue;

    const fallback = parseAppdirFromToml(body, 'firefox-appdir');
    if (fallback === undefined) continue;

    const absolute = await resolveAbsoluteAppPath(objDirAbs, fallback.value);
    if (!absolute) {
      return {
        kind: 'unresolved',
        relativeAppdir: fallback.value,
        manifestPath,
      };
    }

    seenInjections.set(absolute, {
      appPath: absolute,
      manifestPath,
      key: 'firefox-appdir',
      relativeAppdir: fallback.value,
    });
  }

  if (seenInjections.size === 0) return { kind: 'none' };
  if (seenInjections.size > 1) {
    return { kind: 'mismatch', values: Array.from(seenInjections.keys()) };
  }
  const [result] = seenInjections.values();
  // Map.size === 1 was just checked, so result is defined.
  return { kind: 'injected', result: result as AppdirResolveResult };
}

/**
 * Returns true when the operator already passed `--app-path=` (or its
 * `--app-path <value>` two-token form) through `--mach-arg`. Used by the
 * test command to skip auto-injection so the operator override always
 * wins.
 */
export function operatorAlreadySetAppPath(extraArgs: readonly string[]): boolean {
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i] ?? '';
    if (arg === '--app-path' && i + 1 < extraArgs.length) return true;
    if (arg.startsWith('--app-path=')) return true;
  }
  return false;
}
