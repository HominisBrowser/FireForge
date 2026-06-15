// SPDX-License-Identifier: EUPL-1.2
/**
 * Maintains `compilerOptions.paths` entries in a consumer-owned jsconfig
 * so typed cross-module imports of multi-file Furnace components work
 * (field report D3).
 *
 * When a main widget imports a sibling helper via its deployed chrome URL
 * (`chrome://global/content/elements/<helper>.mjs`), a wildcard module
 * shim swallows the import: value imports degrade to `any` and
 * `import(...).SomeType` typedefs fail with TS2694. The fix is a `paths`
 * mapping from the chrome URL to the real workspace source. Furnace
 * already owns the jar.mn side of that mapping, so it can maintain the
 * jsconfig side automatically on every deploy.
 *
 * Ownership contract: only entries whose key starts with
 * `chrome://global/content/elements/` AND whose mapped path resolves into
 * the Furnace custom-components workspace are managed (added, updated,
 * pruned). Everything else in the jsconfig — including hand-written
 * `paths` entries pointing elsewhere — is preserved verbatim. No
 * `baseUrl` is required or written: relative `paths` resolve against the
 * config file's directory.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type { FurnaceConfig } from '../types/furnace.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { info } from '../utils/logger.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { getFurnacePaths } from './furnace-config.js';

/** Chrome URL prefix under which registered custom-element files deploy. */
const CHROME_ELEMENTS_URL_PREFIX = 'chrome://global/content/elements/';

/** Result summary of a jsconfig paths sync. */
export interface JsconfigSyncResult {
  /** Keys newly added to compilerOptions.paths. */
  added: string[];
  /** Managed keys whose mapped path changed. */
  updated: string[];
  /** Managed keys removed because their component/file is gone. */
  pruned: string[];
  /** True when the file was (or would be) rewritten. */
  changed: boolean;
}

interface JsconfigShape {
  compilerOptions?: {
    paths?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Computes the desired managed `paths` entries: one per `.mjs` file of
 * every registered custom component, keyed by its deployed chrome URL and
 * mapped to the workspace source relative to the jsconfig directory.
 *
 * Workspace sources (not deployed engine copies) are the mapping target —
 * they are the files developers edit, and they exist even when the engine
 * has not been deployed yet.
 */
async function computeDesiredChromePathEntries(
  config: FurnaceConfig,
  customDir: string,
  jsconfigAbsPath: string
): Promise<Record<string, string[]>> {
  const jsconfigDir = dirname(jsconfigAbsPath);
  const entries: Record<string, string[]> = {};

  for (const [name, customConfig] of Object.entries(config.custom)) {
    if (!customConfig.register) continue;
    const componentDir = join(customDir, name);
    if (!(await pathExists(componentDir))) continue;

    const files = await readdir(componentDir);
    for (const file of files.sort()) {
      if (!file.endsWith('.mjs')) continue;
      // Emit a `./`-prefixed relative value. TypeScript treats a bare
      // `paths` value (`moz-widget/moz-widget.mjs`) as non-relative and
      // rejects it without `baseUrl` (TS5090); a `./`-prefixed value
      // resolves against the jsconfig directory with no `baseUrl` (which
      // TS6 deprecates, TS5101). `../`-prefixed paths are already relative
      // and left untouched.
      const rel = normalizePathSlashes(relative(jsconfigDir, join(componentDir, file)));
      const sourcePath = rel.startsWith('.') ? rel : `./${rel}`;
      entries[`${CHROME_ELEMENTS_URL_PREFIX}${file}`] = [sourcePath];
    }
  }

  return entries;
}

/**
 * Compares two `paths` values treating a leading `./` as insignificant, so
 * the reconciler does not churn between `./x` and bare `x` forms (either
 * direction). Used to decide whether a managed entry is stale.
 */
function samePathValue(a: string, b: string): boolean {
  const strip = (p: string): string => (p.startsWith('./') ? p.slice(2) : p);
  return strip(a) === strip(b);
}

/** True when `key`/`value` is a Furnace-managed chrome-elements mapping. */
function isManagedEntry(
  key: string,
  value: unknown,
  jsconfigDir: string,
  customDir: string
): boolean {
  if (!key.startsWith(CHROME_ELEMENTS_URL_PREFIX)) return false;
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') return false;
  const target = resolve(jsconfigDir, value[0]);
  return target.startsWith(resolve(customDir) + '/') || target === resolve(customDir);
}

/**
 * Reconciles the managed `compilerOptions.paths` entries of the configured
 * jsconfig against the current Furnace workspace. Idempotent; writes only
 * when something actually changes; dry-run returns the diff without
 * writing.
 *
 * The consumer owns the jsconfig file: a missing file is an error with
 * guidance rather than a silent scaffold, and JSONC (comments/trailing
 * commas) is unsupported for the managed file — `readJson` is a strict
 * JSON parser, so the error message says so explicitly.
 *
 * @param root - Project root directory
 * @param config - Loaded Furnace configuration (must carry `typecheckJsconfig`)
 * @param options - `dryRun` skips the write but still reports the diff
 */
export async function syncFurnaceJsconfigPaths(
  root: string,
  config: FurnaceConfig,
  options?: { dryRun?: boolean }
): Promise<JsconfigSyncResult> {
  const result: JsconfigSyncResult = { added: [], updated: [], pruned: [], changed: false };
  const jsconfigRel = config.typecheckJsconfig;
  if (!jsconfigRel) return result;

  const jsconfigAbs = resolve(root, jsconfigRel);
  if (!(await pathExists(jsconfigAbs))) {
    throw new FurnaceError(
      `furnace.json sets "typecheckJsconfig": "${jsconfigRel}", but the file does not exist. ` +
        'Create the jsconfig (it stays consumer-owned; Furnace only maintains the ' +
        `"compilerOptions.paths" entries under ${CHROME_ELEMENTS_URL_PREFIX}*), ` +
        'or remove the setting.'
    );
  }

  let jsconfig: JsconfigShape;
  try {
    jsconfig = await readJson<JsconfigShape>(jsconfigAbs);
  } catch (error: unknown) {
    throw new FurnaceError(
      `Could not parse ${jsconfigRel} as JSON: ${error instanceof Error ? error.message : String(error)}. ` +
        'Furnace manages paths entries only in plain-JSON jsconfig files — JSONC comments ' +
        'and trailing commas are not supported for the managed file.'
    );
  }

  const furnacePaths = getFurnacePaths(root);
  const desired = await computeDesiredChromePathEntries(
    config,
    furnacePaths.customDir,
    jsconfigAbs
  );
  const jsconfigDir = dirname(jsconfigAbs);

  const currentPaths: Record<string, unknown> = { ...(jsconfig.compilerOptions?.paths ?? {}) };
  const nextPaths: Record<string, unknown> = {};

  // Preserve every unmanaged entry verbatim; prune managed entries that are
  // no longer desired; update managed entries whose target moved.
  for (const [key, value] of Object.entries(currentPaths)) {
    if (!isManagedEntry(key, value, jsconfigDir, furnacePaths.customDir)) {
      nextPaths[key] = value;
      continue;
    }
    const want = desired[key];
    if (want === undefined) {
      result.pruned.push(key);
      continue;
    }
    // Treat `./x` and bare `x` as equal so a previously-synced bare value (or
    // a hand-written `./` prefix) is not rewritten as "stale" on every run.
    // The existing value is kept verbatim when equivalent — no churn either
    // way; only a genuinely different target updates (to the `./` form).
    if (!samePathValue((value as string[])[0] ?? '', want[0] ?? '')) {
      result.updated.push(key);
      nextPaths[key] = want;
    } else {
      nextPaths[key] = value;
    }
  }
  for (const [key, want] of Object.entries(desired)) {
    if (!(key in nextPaths)) {
      result.added.push(key);
      nextPaths[key] = want;
    }
  }

  result.changed = result.added.length > 0 || result.updated.length > 0 || result.pruned.length > 0;
  if (!result.changed || options?.dryRun === true) return result;

  const nextJsconfig: JsconfigShape = {
    ...jsconfig,
    compilerOptions: {
      ...(jsconfig.compilerOptions ?? {}),
      paths: nextPaths,
    },
  };
  await writeJson(jsconfigAbs, nextJsconfig);
  return result;
}

/**
 * Computes jsconfig `paths` drift for `furnace validate`: managed entries
 * that are missing or stale relative to the current workspace. Read-only —
 * delegates to {@link syncFurnaceJsconfigPaths} in dry-run mode.
 */
export async function findJsconfigPathsDrift(
  root: string,
  config: FurnaceConfig
): Promise<JsconfigSyncResult> {
  return syncFurnaceJsconfigPaths(root, config, { dryRun: true });
}

/**
 * Runs the jsconfig paths sync after a successful deploy/sync and reports
 * the diff. No-op when `typecheckJsconfig` is unset. Shared by
 * `furnace deploy` and `furnace sync` so both report identically.
 */
export async function reportJsconfigPathsSync(
  root: string,
  config: FurnaceConfig,
  dryRun: boolean
): Promise<void> {
  if (!config.typecheckJsconfig) return;
  const sync = await syncFurnaceJsconfigPaths(root, config, { dryRun });
  if (!sync.changed) return;
  info(
    `${dryRun ? '[dry-run] Would update' : 'Updated'} ${config.typecheckJsconfig} chrome-module paths: ` +
      `+${sync.added.length} added, ~${sync.updated.length} updated, -${sync.pruned.length} pruned`
  );
}
