// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge token lint`: themed-block lockstep and undeclared token
 * references (see `core/token-lint.ts` for the rules).
 *
 * Helper module: no registrar, called from `token.ts`.
 */
import { basename, join } from 'node:path';

import { authoredGateContext } from '../core/authored-gates.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { missingEngineMessage } from '../core/engine-precondition.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../core/furnace-config.js';
import { buildPatchQueueContext } from '../core/patch-lint.js';
import { buildJarTargetIndex } from '../core/patch-lint-forward-registration-extended.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import {
  collectDeclaredTokenNames,
  lintTokenLockstep,
  lintUndeclaredTokenReferences,
  type TokenLintFinding,
} from '../core/token-lint.js';
import { getTokensCssPath } from '../core/token-manager.js';
import { buildSiblingSheetMap } from '../core/token-sibling-sheets.js';
import { GeneralError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import {
  info,
  intro,
  outro,
  setMachineOutputMode,
  setStdoutSealed,
  success,
  warn,
} from '../utils/logger.js';
import { emitMachineError, MACHINE_OUTPUT_SCHEMA_VERSION } from '../utils/machine-output.js';

/** Options accepted by {@link tokenLintCommand}. */
export interface TokenLintOptions {
  /** Emit the machine-readable envelope instead of the human report. */
  json?: boolean;
}

interface TokenLintReport {
  tokensCssPath: string;
  tokenPrefix: string;
  filesScanned: number;
  findings: TokenLintFinding[];
}

interface TokenSettings {
  tokenPrefix: string;
  exempt: Set<string>;
  siblingSheets?: Record<string, string[]> | undefined;
}

/** Token prefix, exempt names and sibling sheets from furnace.json, with the init default. */
async function loadTokenSettings(projectRoot: string, binaryName: string): Promise<TokenSettings> {
  const fallback = { tokenPrefix: `--${binaryName}-`, exempt: new Set<string>() };
  if (!(await furnaceConfigExists(projectRoot))) return fallback;
  try {
    const furnace = await loadFurnaceConfig(projectRoot);
    return {
      tokenPrefix: furnace.tokenPrefix ?? fallback.tokenPrefix,
      exempt: new Set([...(furnace.tokenAllowlist ?? []), ...(furnace.runtimeVariables ?? [])]),
      siblingSheets: furnace.tokenSiblingSheets,
    };
  } catch (error: unknown) {
    warn(`Could not load furnace.json; using the default token prefix (${toError(error).message})`);
    return fallback;
  }
}

/** The engine tree to judge and the files the project changed in it. */
interface LintUniverse {
  /** Root whose furnace.json applies: the project, or a snapshot view of it. */
  root: string;
  engine: string;
  /** Engine-relative paths the project created or changed. */
  touched: string[];
  /** Jar-mapped `chrome://` targets to the source path they package. */
  jarTargets: () => Promise<Map<string, string>>;
}

/** Queue mode: every file a patch touches, read from the live engine. */
async function queueUniverse(projectRoot: string): Promise<LintUniverse> {
  const paths = getProjectPaths(projectRoot);
  const manifest = await loadPatchesManifest(paths.patches);
  return {
    root: projectRoot,
    engine: paths.engine,
    touched: [...new Set((manifest?.patches ?? []).flatMap((patch) => patch.filesAffected))],
    jarTargets: async () =>
      buildJarTargetIndex((await buildPatchQueueContext(paths.patches)).entries),
  };
}

/**
 * Source mode: every created, overridden and generated file of the captured
 * snapshot, as source-mode lint judges them (the admitted slot inside a job,
 * a private view of the checkout elsewhere).
 */
async function authoredUniverse(projectRoot: string): Promise<LintUniverse> {
  const context = await authoredGateContext(projectRoot);
  const touched = context.snapshot.files.flatMap((file) => (file.blob ? [file.path] : []));
  return {
    root: context.projectRoot,
    engine: context.engine,
    touched,
    // A whole jar.mn rather than a patch's added lines: unchanged upstream
    // entries only map sheets the project does not touch.
    jarTargets: async () =>
      buildJarTargetIndex([
        {
          filename: 'authored-source',
          order: 0,
          metadata: null,
          createdFiles: new Set(),
          newFiles: await readEngineFiles(
            context.engine,
            touched.filter((file) => basename(file) === 'jar.mn')
          ),
          modifiedFileAdditions: new Map(),
        },
      ]),
  };
}

async function collectTokenLint(projectRoot: string): Promise<TokenLintReport> {
  const config = await loadConfig(projectRoot);
  const universe = config.sources
    ? await authoredUniverse(projectRoot)
    : await queueUniverse(projectRoot);
  const tokensCssPath = getTokensCssPath(config.binaryName);
  const tokensFile = join(universe.engine, tokensCssPath);
  if (!(await pathExists(tokensFile))) {
    throw new GeneralError(
      config.sources || (await pathExists(universe.engine))
        ? `Token CSS file not found: ${tokensCssPath}. Run "fireforge furnace init" to seed it.`
        : await missingEngineMessage(universe.engine)
    );
  }
  const { tokenPrefix, exempt, siblingSheets } = await loadTokenSettings(
    universe.root,
    config.binaryName
  );
  const tokensCss = await readText(tokensFile);
  const lines = tokensCss.split('\n');
  const declared = collectDeclaredTokenNames(lines);

  const findings: TokenLintFinding[] = [
    ...lintTokenLockstep(lines, tokensCssPath, tokenPrefix),
    ...lintUndeclaredTokenReferences(tokensCssPath, tokensCss, tokenPrefix, declared, exempt),
  ];

  // Every CSS file the project touches: its own stylesheets and the upstream
  // ones it edits.
  const { engine, touched } = universe;
  const cssFiles = touched.filter((file) => file.endsWith('.css') && file !== tokensCssPath).sort();
  const contents = await readEngineFiles(
    engine,
    touched.filter((file) => LINKING_FILE.test(file))
  );
  const siblings = buildSiblingSheetMap({
    documents: contents,
    jarTargets: await universe.jarTargets(),
    sheets: cssFiles,
    explicit: siblingSheets,
  });
  let filesScanned = 1;
  for (const file of cssFiles) {
    const css = contents.get(file);
    if (css === undefined) continue;
    filesScanned++;
    findings.push(
      ...lintUndeclaredTokenReferences(
        file,
        css,
        tokenPrefix,
        await withSiblingDeclarations(engine, declared, siblings.get(file), contents),
        exempt
      )
    );
  }
  return { tokensCssPath, tokenPrefix, filesScanned, findings };
}

/** Files whose content can link a stylesheet: markup, scripts, and sheets (`@import`). */
const LINKING_FILE = /\.(?:css|xhtml|html|xml|mjs|js)$/;

/** Reads the engine files that exist, keyed by engine-relative path. */
async function readEngineFiles(engineDir: string, files: string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of files) {
    const absolute = join(engineDir, file);
    if (await pathExists(absolute)) contents.set(file, await readText(absolute));
  }
  return contents;
}

/** The tokens CSS declarations plus every declaration of a sheet's siblings. */
async function withSiblingDeclarations(
  engineDir: string,
  declared: ReadonlySet<string>,
  siblings: ReadonlySet<string> | undefined,
  contents: Map<string, string>
): Promise<ReadonlySet<string>> {
  if (siblings === undefined || siblings.size === 0) return declared;
  const merged = new Set(declared);
  for (const sibling of siblings) {
    if (!contents.has(sibling)) {
      const absolute = join(engineDir, sibling);
      if (!(await pathExists(absolute))) continue;
      contents.set(sibling, await readText(absolute));
    }
    const css = contents.get(sibling) ?? '';
    for (const name of collectDeclaredTokenNames(css.split('\n'))) merged.add(name);
  }
  return merged;
}

function failureMessage(count: number): string {
  return `token lint found ${String(count)} finding(s).`;
}

/**
 * Runs `token lint`. Exits non-zero (GeneralError) when any finding is
 * reported; with `--json` the report is written first, as `status --check
 * --json` does.
 *
 * @param projectRoot - Root directory of the project
 * @param options - Output-mode options
 */
export async function tokenLintCommand(
  projectRoot: string,
  options: TokenLintOptions = {}
): Promise<void> {
  if (options.json === true) {
    setMachineOutputMode(true);
    let findings = 0;
    try {
      const report = await collectTokenLint(projectRoot);
      findings = report.findings.length;
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION, ...report }, null, 2)}\n`
      );
      setStdoutSealed(true);
    } catch (error: unknown) {
      emitMachineError('token-lint-failed', toError(error).message);
    } finally {
      setMachineOutputMode(false);
    }
    if (findings > 0) throw new GeneralError(failureMessage(findings));
    return;
  }

  intro('Token Lint');
  const report = await collectTokenLint(projectRoot);
  for (const finding of report.findings) {
    warn(`${finding.file}:${String(finding.line)} [${finding.check}] ${finding.message}`);
  }
  info(`${String(report.filesScanned)} CSS file(s) scanned for ${report.tokenPrefix}* tokens`);
  if (report.findings.length > 0) {
    outro('Token lint failed');
    throw new GeneralError(failureMessage(report.findings.length));
  }
  success('Themed blocks are in lockstep with the base block; every token reference resolves');
  outro('Token lint passed');
}
