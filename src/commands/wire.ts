// SPDX-License-Identifier: EUPL-1.2
import { join, relative } from 'node:path';

import { Command } from 'commander';

import { DEFAULT_BROWSER_SUBSCRIPT_DIR, wireSubscript } from '../core/browser-wire.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  furnaceConfigExists as checkFurnaceConfigExists,
  loadFurnaceConfig,
} from '../core/furnace-config.js';
import { consumeParserFallbackEvents } from '../core/parser-fallback.js';
import { DEFAULT_DOM_TARGET, probeDomFragmentInsertionPoint } from '../core/wire-dom-fragment.js';
import { coerceToCall, validateWireName as validateWireExpression } from '../core/wire-utils.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { WireOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import {
  isContainedRelativePath,
  isExplicitAbsolutePath,
  isPathInsideRoot,
  stripEnginePrefix,
  toRootRelativePath,
} from '../utils/paths.js';

const BROWSER_BASE_DIR = 'browser/base';

function printWireDryRun(
  engineDir: string,
  name: string,
  subscriptDir: string,
  domFilePath: string | undefined,
  domTargetPath: string,
  options: WireOptions
): void {
  info('[dry-run] Would wire subscript:');
  info(`  source: ${subscriptDir}/${name}.js`);
  info(`  browser-main.js: loadSubScript("chrome://browser/content/${name}.js")`);
  if (options.init) {
    // Show the coerced form so the preview matches the emitted block.
    // Before 0.16.0 the preview echoed the raw input ("EvalStartup.init"),
    // which did not reflect that the real run writes `EvalStartup.init();`
    // to browser-init.js.
    info(`  browser-init.js: ${coerceToCall(options.init)}`);
  }
  if (options.destroy) {
    info(`  browser-init.js onUnload(): ${coerceToCall(options.destroy)}`);
  }
  if (domFilePath) {
    const includePath = relative(
      join(engineDir, subscriptDir),
      join(engineDir, domFilePath)
    ).replace(/\\/g, '/');
    info(`  ${domTargetPath}: #include ${includePath}`);
  }
  const relPath = relative(
    join(engineDir, BROWSER_BASE_DIR),
    join(engineDir, subscriptDir)
  ).replace(/\\/g, '/');
  info(`  jar.mn: content/browser/${name}.js (${relPath}/${name}.js)`);
  outro('Dry run complete');
}

/**
 * Resolves the chrome document the `#include` directive is inserted into.
 *
 * Preference order:
 *   1. `--target <path>` CLI flag (explicit caller intent)
 *   2. First entry of `furnace.json.tokenHostDocuments` (fork-configured
 *      chrome doc list; already consumed by the missing-token-link
 *      validator and the doctor check)
 *   3. `browser/base/content/browser.xhtml` (upstream default)
 *
 * Step 2 is silent — a missing / invalid furnace.json falls through to the
 * upstream default rather than surfacing a warning, because forks that don't
 * use furnace shouldn't have to configure anything.
 */
async function resolveDomTargetPath(
  projectRoot: string,
  explicit: string | undefined
): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }
  if (await checkFurnaceConfigExists(projectRoot)) {
    try {
      const furnaceConfig = await loadFurnaceConfig(projectRoot);
      const first = furnaceConfig.tokenHostDocuments?.[0];
      if (first !== undefined && first.length > 0) {
        return first;
      }
    } catch {
      // Fall through to default — a broken furnace.json should not block
      // the wire command. The doctor surfaces that issue separately.
    }
  }
  return DEFAULT_DOM_TARGET;
}

/**
 * Validates a subscript name supplied on the command line. Subscripts are
 * resolved into filenames under the subscript directory and registered in
 * jar.mn by this name, so any path separator or `..` segment would let
 * the caller write outside the intended directory or corrupt the manifest.
 * Mirrors the validation already applied to setup's binaryName and furnace
 * custom component targetPath.
 */
function validateWireName(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    throw new InvalidArgumentError(
      `Subscript name "${name}" is invalid. ` +
        'Names must start with a letter or underscore and contain only letters, digits, underscores, or hyphens. ' +
        'Path separators and parent-directory segments are not permitted.',
      'name'
    );
  }
}

/**
 * Asserts that the resolved chrome document both exists on disk AND
 * exposes an insertion anchor (`#include browser-sets.inc` or
 * `<html:body>`) that `addDomFragment` can splice into. Fires the same
 * check in dry-run and real-run mode, so the preview and execution
 * agree on whether the target is wireable before any disk mutations
 * happen. Before 0.16.0 this check only ran on the real branch, which
 * let the dry-run produce a plausible-looking plan that the real run
 * then refused with `Could not find insertion point in chrome document`.
 */
async function assertDomTargetIsWireable(
  projectRoot: string,
  domFilePath: string,
  domTargetPath: string
): Promise<void> {
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(join(paths.engine, domTargetPath)))) {
    throw new InvalidArgumentError(
      `Chrome document not found in engine: ${domTargetPath}\n` +
        'Set "tokenHostDocuments" in furnace.json (first entry is used by wire) ' +
        'or pass --target <path>.',
      'target'
    );
  }
  try {
    await probeDomFragmentInsertionPoint(paths.engine, domFilePath, domTargetPath);
  } catch (probeError: unknown) {
    throw new InvalidArgumentError(
      `${probeError instanceof Error ? probeError.message : String(probeError)}\n` +
        `The resolved chrome document ${domTargetPath} does not expose an insertion anchor ` +
        'that `fireforge wire` recognises (`#include browser-sets.inc` or `<html:body>`). ' +
        'Add one of those anchors to the chrome doc, or target a document that has them via ' +
        '`--target <path>`.',
      'target'
    );
  }
}

async function resolveWireSubscriptDir(projectRoot: string, options: WireOptions): Promise<string> {
  let subscriptDir = DEFAULT_BROWSER_SUBSCRIPT_DIR;
  try {
    const config = await loadConfig(projectRoot);
    if (config.wire?.subscriptDir) {
      subscriptDir = config.wire.subscriptDir;
    }
  } catch (error: unknown) {
    warn(
      `Using default wire.subscriptDir because fireforge.json could not be loaded: ${toError(error).message}`
    );
  }
  if (options.subscriptDir) {
    if (!isContainedRelativePath(options.subscriptDir)) {
      throw new InvalidArgumentError(
        `Subscript directory must stay within engine/: ${options.subscriptDir}`,
        'subscriptDir'
      );
    }
    subscriptDir = options.subscriptDir;
  }
  return subscriptDir;
}

async function ensureSubscriptSourceExists(
  projectRoot: string,
  subscriptDir: string,
  name: string,
  dryRun: boolean
): Promise<void> {
  const paths = getProjectPaths(projectRoot);
  const subscriptPath = join(paths.engine, subscriptDir, `${name}.js`);
  if (!(await pathExists(subscriptPath))) {
    if (dryRun) {
      info(
        `Note: ${subscriptDir}/${name}.js does not exist yet — the real wire command will require it before writing. Create the file before re-running without --dry-run.`
      );
    } else {
      throw new InvalidArgumentError(
        `Subscript file not found: ${subscriptDir}/${name}.js\n` +
          'Create the file in engine/ before wiring.',
        'name'
      );
    }
  }
}

/**
 * Validates the `--dom` fragment argument and computes its engine-root-
 * relative path. Accepts absolute, repo-root-relative (`engine/...`), and
 * engine-relative inputs; rejects missing files and paths escaping
 * engine/. Returns undefined when `--dom` was not supplied.
 */
async function resolveDomFragmentPath(
  projectRoot: string,
  dom: string | undefined
): Promise<string | undefined> {
  // Validate DOM fragment file exists and compute path relative to engine root.
  //
  // Accepts three shapes:
  //  - Absolute paths (`/project/engine/browser/base/content/foo.inc.xhtml`)
  //  - Repo-root-relative forms (`engine/browser/base/content/foo.inc.xhtml`)
  //  - Engine-relative forms (`browser/base/content/foo.inc.xhtml`)
  //
  // Before the engine-prefix normalization, passing an `engine/…`-prefixed
  // relative path from the repo root double-rooted through
  // `toRootRelativePath(engineDir, …)` — `resolve(engineDir, 'engine/…')`
  // landed at `engineDir/engine/…`, which is still "inside" engineDir but
  // named as a second-level `engine/…` entry. The computed `#include`
  // then read `../../../engine/browser/base/content/foo.inc.xhtml`,
  // packaging-breaking nonsense. For absolute inputs this pre-existing
  // contract was fine — `toRootRelativePath` handles absolute candidates
  // correctly — so we only strip the prefix when the input is relative.
  if (!dom) return undefined;
  {
    const paths = getProjectPaths(projectRoot);
    const domCandidate = isExplicitAbsolutePath(dom) ? dom : stripEnginePrefix(dom);
    // `pathExists` resolves relative paths against CWD, so an engine-
    // relative `domCandidate` (e.g. `browser/base/content/foo.inc.xhtml`)
    // would be probed inside the operator's shell directory rather than
    // the engine root and fail "DOM fragment file not found" even when
    // the file is sitting at engine/<path>. Mirror `register.ts`: probe
    // the absolute path as-is, otherwise join with `paths.engine` first.
    // The `isPathInsideRoot` / `toRootRelativePath` calls below keep
    // operating on `domCandidate` because they internally resolve
    // relative candidates against the engine root, which matches the
    // probe path we just built.
    const domProbePath = isExplicitAbsolutePath(domCandidate)
      ? domCandidate
      : join(paths.engine, domCandidate);
    if (!(await pathExists(domProbePath))) {
      throw new InvalidArgumentError(`DOM fragment file not found: ${dom}`, 'dom');
    }
    if (!isPathInsideRoot(paths.engine, domCandidate)) {
      throw new InvalidArgumentError(`DOM fragment file must stay within engine/: ${dom}`, 'dom');
    }
    return toRootRelativePath(paths.engine, domCandidate);
  }
}

/**
 * Builds the wireSubscript option bag from the command flags, omitting
 * every key whose flag is absent (exactOptionalPropertyTypes) and the
 * defaults the lower layer already assumes.
 */
function buildWireSubscriptOptions(
  options: WireOptions,
  domFilePath: string | undefined,
  domTargetPath: string,
  subscriptDir: string
): Parameters<typeof wireSubscript>[2] {
  return {
    ...(options.init !== undefined ? { init: options.init } : {}),
    ...(options.destroy !== undefined ? { destroy: options.destroy } : {}),
    ...(domFilePath !== undefined ? { domFilePath } : {}),
    ...(domFilePath !== undefined && domTargetPath !== DEFAULT_DOM_TARGET ? { domTargetPath } : {}),
    ...(options.after !== undefined ? { after: options.after } : {}),
    ...(subscriptDir !== DEFAULT_BROWSER_SUBSCRIPT_DIR ? { subscriptDir } : {}),
    dryRun: false,
  };
}

/**
 * Surfaces any legacy parser fallbacks the wiring run consumed, so the
 * operator knows which files were mutated by the regex path rather than
 * the AST path.
 */
function reportParserFallbacks(): void {
  const parserFallbacks = consumeParserFallbackEvents();
  if (parserFallbacks.length > 0) {
    const contexts = [...new Set(parserFallbacks.map((event) => event.context))];
    info(
      `Legacy parser fallback was used for ${contexts.length} file${contexts.length === 1 ? '' : 's'}: ${contexts.join(', ')}`
    );
  }
}

/**
 * Prints the per-mutation success/skip rows for a completed (non-dry-run)
 * wire invocation.
 */
function reportWireResult(
  result: Awaited<ReturnType<typeof wireSubscript>>,
  name: string,
  options: WireOptions,
  domFilePath: string | undefined,
  domTargetPath: string
): void {
  if (result.subscriptAdded) {
    success(`Added loadSubScript for ${name}.js to browser-main.js`);
  } else {
    info(`${name}.js already registered in browser-main.js (skipped)`);
  }

  if (options.init) {
    if (result.initAdded) {
      success(`Added init expression to browser-init.js onLoad()`);
    } else {
      info(`Init expression already present in browser-init.js (skipped)`);
    }
  }

  if (options.destroy) {
    if (result.destroyAdded) {
      success(`Added destroy expression to browser-init.js onUnload()`);
    } else {
      info(`Destroy expression already present in browser-init.js (skipped)`);
    }
  }

  if (domFilePath) {
    if (result.domInserted) {
      success(`Inserted #include directive into ${domTargetPath}`);
    } else {
      info(`#include directive already present in ${domTargetPath} (skipped)`);
    }
  }

  if (result.jarMnResult.skipped) {
    info(`${name}.js already registered in jar.mn (skipped)`);
  } else {
    success(`Registered ${name}.js in ${result.jarMnResult.manifest}`);
  }
}

/**
 * Wires a chrome subscript into the browser.
 *
 * @param projectRoot - Root directory of the project
 * @param name - Subscript name (without .js extension)
 * @param options - Command options
 */
export async function wireCommand(
  projectRoot: string,
  name: string,
  options: WireOptions = {}
): Promise<void> {
  intro('Wire');
  validateWireName(name);
  if (options.after !== undefined) {
    // --after references an existing init block by its subscript name, so
    // it must follow the same naming rules as `name` itself. Without this
    // check, a caller could sneak a path-traversal segment in through
    // --after and have it forwarded unchanged to the lookup layer.
    validateWireName(options.after);
  }

  // Validate init/destroy expressions BEFORE the dry-run/real fork so
  // both paths enforce the same contract. Pre-0.16.0, validation only
  // ran inside `addInitToBrowserInit`/`addDestroyToBrowserInit` (the
  // real-execution path), so `--dry-run --init 'void 0'` succeeded and
  // rendered a plausible-looking preview even though the real run would
  // reject the same arguments. Dropping `void 0` into the template
  // silently (or breaking out of the string literal) was already
  // prevented downstream — this hoist just makes the failure surface
  // identical in preview mode.
  if (options.init !== undefined) {
    validateWireExpression(options.init, 'init expression');
  }
  if (options.destroy !== undefined) {
    validateWireExpression(options.destroy, 'destroy expression');
  }

  consumeParserFallbackEvents();

  const subscriptDir = await resolveWireSubscriptDir(projectRoot, options);

  const domFilePath = await resolveDomFragmentPath(projectRoot, options.dom);

  // Resolve the chrome document the `#include` directive will land in.
  // Only consulted when `--dom` is supplied — we still resolve it here so
  // the dry-run plan can print the target accurately.
  //
  // `stripEnginePrefix` is applied so `--target engine/browser/base/browser.xhtml`
  // and `--target browser/base/browser.xhtml` are treated identically,
  // matching the `--dom` normalization above. Absolute `--target` paths
  // stay absolute (the containment check downstream rejects them).
  const normalizedTarget =
    options.target !== undefined && !isExplicitAbsolutePath(options.target)
      ? stripEnginePrefix(options.target)
      : options.target;
  if (normalizedTarget !== undefined && !isContainedRelativePath(normalizedTarget)) {
    throw new InvalidArgumentError(
      `Target chrome document must stay within engine/: ${options.target ?? ''}`,
      'target'
    );
  }
  const domTargetPath = await resolveDomTargetPath(projectRoot, normalizedTarget);
  if (domFilePath) {
    await assertDomTargetIsWireable(projectRoot, domFilePath, domTargetPath);
  }

  // Verify the subscript file exists in engine/ (skip for dry-run:
  // dry-run is meant to preview the mutation plan without requiring
  // the subscript to already exist, matching the "plan before write"
  // pattern operators rely on for setup scripts).
  //
  // Dry-run keeps the existence check advisory rather than fatal: the
  // "wire first, create file after" workflow is a legitimate use of
  // preview, but operators who run dry-run over a typo were surprised
  // when the real command then refused with `Subscript file not
  // found`. 2026-04-23 eval (Finding in eval 2): dry-run produced a
  // plausible plan and the non-dry-run invocation then errored. The
  // info line surfaces the mismatch in preview mode so the operator
  // can act on the warning before re-running without --dry-run.
  await ensureSubscriptSourceExists(projectRoot, subscriptDir, name, options.dryRun ?? false);

  if (options.dryRun) {
    printWireDryRun(
      getProjectPaths(projectRoot).engine,
      name,
      subscriptDir,
      domFilePath,
      domTargetPath,
      options
    );
    return;
  }

  const result = await wireSubscript(
    projectRoot,
    name,
    buildWireSubscriptOptions(options, domFilePath, domTargetPath, subscriptDir)
  );

  reportParserFallbacks();
  reportWireResult(result, name, options, domFilePath, domTargetPath);

  outro('Wiring complete');
}

/** Registers the wire command on the CLI program. */
export function registerWire(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('wire <name>')
    .description('Wire a chrome subscript into the browser')
    .option('--init <expression>', 'Init expression for browser-init.js onLoad()')
    .option('--destroy <expression>', 'Destroy expression for browser-init.js onUnload()')
    .option('--dom <file>', 'XHTML fragment file to insert into the chrome document')
    .option('--dry-run', 'Show what would be changed without writing')
    .option('--after <name>', 'Insert init block after the block for this name')
    .option(
      '--subscript-dir <dir>',
      'Subscript directory relative to engine/ (default: browser/base/content)'
    )
    .option(
      '--target <path>',
      'Chrome document to insert --dom into, relative to engine/ ' +
        '(default: first entry of furnace.json tokenHostDocuments, else browser/base/content/browser.xhtml)'
    )
    .action(
      withErrorHandling(
        async (
          name: string,
          options: {
            init?: string;
            destroy?: string;
            dom?: string;
            dryRun?: boolean;
            after?: string;
            subscriptDir?: string;
            target?: string;
          }
        ) => {
          await wireCommand(getProjectRoot(), name, pickDefined(options));
        }
      )
    );
}
