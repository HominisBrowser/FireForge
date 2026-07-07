// SPDX-License-Identifier: EUPL-1.2
import { Command, InvalidArgumentError as CommanderInvalidArgumentError } from 'commander';

import { validateBrandOverride } from '../core/brand-validation.js';
import { auditBuildArtifacts } from '../core/build-audit.js';
import { readBuildBaseline, writeBuildBaseline } from '../core/build-baseline.js';
import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { withEngineSessionLock } from '../core/engine-session-lock.js';
import type { MachCommandResult, ProtectedMachBuildResult } from '../core/mach.js';
import {
  attemptMozinfoRewrite,
  build,
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  hasRunnableBundle,
  runMach,
  withBuildLock,
} from '../core/mach.js';
import { buildHarnessCrashMessage } from '../core/test-harness-crash.js';
import {
  formatToolchainMismatchMessage,
  runToolchainPreflight,
} from '../core/toolchain-preflight.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { BuildOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { checkDiskSpace, pathExists } from '../utils/fs.js';
import { error, info, intro, outro, spinner, verbose, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { isPositiveInteger } from '../utils/validation.js';

function parseJobCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CommanderInvalidArgumentError('jobs must be a positive integer');
  }

  return parsed;
}

/**
 * Patches `mozinfo.json` under the active obj-* directory so its recorded
 * paths match the current engine checkout, then runs `mach configure` to
 * regenerate every other generated path alongside it. Throws with the
 * original mismatch guidance when the rewriter refuses to proceed — that
 * always covers the unsafe cases, so the operator still gets the correct
 * fallback recovery instruction.
 */
async function rewriteAndReconfigure(
  engineDir: string,
  objDir: string,
  mismatchMessage: string
): Promise<void> {
  const rewriteSpinner = spinner('Rewriting mozinfo.json paths...');
  let rewrite;
  try {
    rewrite = await attemptMozinfoRewrite(engineDir, objDir);
  } catch (rewriteError: unknown) {
    rewriteSpinner.error('mozinfo rewrite failed');
    throw new GeneralError(
      `${mismatchMessage}\n\nmozinfo rewrite failed: ${toError(rewriteError).message}`
    );
  }
  if (!rewrite.rewritten) {
    rewriteSpinner.error('mozinfo rewrite refused');
    throw new GeneralError(
      `${mismatchMessage}\n\nmozinfo rewrite refused: ${rewrite.reason ?? 'unspecified reason'}`
    );
  }
  rewriteSpinner.stop(`mozinfo.json patched (topsrcdir → ${rewrite.newTopsrcdir})`);

  const configureSpinner = spinner('Running mach configure against rewritten mozinfo.json...');
  let exitCode: number;
  try {
    exitCode = await runMach(['configure'], engineDir);
  } catch (configureError: unknown) {
    configureSpinner.error('mach configure failed');
    throw new BuildError(
      'mach configure failed after mozinfo rewrite',
      'mach configure',
      configureError instanceof Error ? configureError : undefined
    );
  }
  if (exitCode !== 0) {
    configureSpinner.error('mach configure exited non-zero');
    throw new BuildError(
      `mach configure exited non-zero (${exitCode}) after mozinfo rewrite; a clean rebuild is required.`,
      'mach configure'
    );
  }
  configureSpinner.stop('mach configure regenerated the backend');
  info('Backend path-rewrite complete; continuing with the build.');
}

function resolveJobCount(
  options: BuildOptions,
  configJobs: number | undefined
): number | undefined {
  const jobs = options.jobs ?? configJobs;
  if (jobs === undefined) {
    return undefined;
  }

  if (!isPositiveInteger(jobs)) {
    throw new GeneralError('Build jobs must be a positive integer');
  }

  return jobs;
}

function tailLines(text: string, maxLines: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-maxLines).join('\n');
}

function extractLastMakeError(captured: string): string | undefined {
  const lines = captured.split(/\r?\n/).filter((line) => /\bg?make(?:\[\d+\])?: \*\*\*/.test(line));
  const actionable = lines.filter(
    (line) => !/\[\s*(?:all|build|default)\s*\]\s+Error\s+\d+/i.test(line)
  );
  return (actionable.at(-1) ?? lines.at(-1))?.trim();
}

function isWarningOnlyLine(line: string): boolean {
  if (/\b(?:error|failed|fatal)\b/i.test(line)) return false;
  return (
    /\bwarning\b/i.test(line) ||
    /urllib3|LibreSSL|NotOpenSSLWarning|InsecurePlatformWarning/i.test(line)
  );
}

function extractRecentMakeContext(captured: string): string | undefined {
  const lines = captured
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const makeLines = lines.filter((line) => /\b(?:g?make)(?:\[\d+\])?:/.test(line));
  if (makeLines.length === 0) return undefined;
  return makeLines.slice(-6).join('\n');
}

function extractLikelyFailingCommand(captured: string): string | undefined {
  const lines = captured
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let lastMakeErrorIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/\bg?make(?:\[\d+\])?: \*\*\*/.test(lines[index] ?? '')) {
      lastMakeErrorIndex = index;
      break;
    }
  }
  const startIndex = lastMakeErrorIndex > 0 ? lastMakeErrorIndex - 1 : lines.length - 1;
  for (let index = startIndex; index >= 0; index--) {
    const line = lines[index];
    if (!line) continue;
    if (isWarningOnlyLine(line)) continue;
    if (/^make(?:\[\d+\])?:/.test(line)) continue;
    if (/^g?make(?:\[\d+\])?:/.test(line)) continue;
    if (/^Error running mach:/.test(line)) continue;
    const comparable = line.replace(/^\d+:\d+\.\d+\s+/, '');
    if (/\b(?:cp|clang|clang\+\+|rustc|python|node|make|install_name_tool)\b/.test(comparable)) {
      return line;
    }
  }
  return undefined;
}

function buildFailureDiagnostics(
  result: MachCommandResult,
  engineDir: string,
  objDir: string | undefined,
  machCommand: string
): string {
  const captured = `${result.stderr}\n${result.stdout}`;
  const stderrTail = tailLines(result.stderr, 20);
  const combinedTail = tailLines(captured, 30);
  const makeError = extractLastMakeError(captured);
  const makeContext = extractRecentMakeContext(captured);
  const failingCommand = extractLikelyFailingCommand(captured);
  const logHint = objDir
    ? `engine/${objDir}/ (inspect build logs, warnings, and generated make targets under this objdir)`
    : 'engine/obj-* (inspect the active objdir for build logs, warnings, and generated make targets)';
  const verboseRerun = objDir
    ? `cd ${engineDir} && ./mach build -v; if a make target is named above, retry it with: make -C ${objDir} <target> V=1`
    : `cd ${engineDir} && ./mach build -v`;

  return [
    `Build failed with exit code ${result.exitCode}.`,
    `Mach phase: ${machCommand}`,
    makeError ? `Last make error: ${makeError}` : undefined,
    makeContext ? `Recent make context:\n${makeContext}` : undefined,
    failingCommand ? `Final failing command/error line: ${failingCommand}` : undefined,
    stderrTail ? `Captured stderr tail:\n${stderrTail}` : undefined,
    `Captured output tail:\n${combinedTail}`,
    `Logs/profile/warnings: ${logHint}`,
    `Verbose rerun: ${verboseRerun}`,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n\n');
}

/**
 * Runs the build command.
 * @param projectRoot - Root directory of the project
 * @param options - Build options
 */
export async function buildCommand(projectRoot: string, options: BuildOptions): Promise<void> {
  const buildType = options.ui ? 'UI-only' : 'Full';
  const brandInfo = options.brand ? ` [${options.brand}]` : '';
  intro(`FireForge Build (${buildType}${brandInfo})`);

  // Load configuration
  const config = await loadConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  validateBrandOverride(config.binaryName, options.brand);

  // Disk space pre-flight: a full Firefox build can be ~20 GB
  await checkDiskSpace(projectRoot, 20 * 1024 * 1024 * 1024, warn);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Toolchain preflight: compare the minimums the tree itself declares
  // (cbindgen / rust) against the host binaries mach configure will
  // resolve, and fail fast naming `fireforge bootstrap` instead of dying
  // ~8s into configure with mach's "./mach bootstrap" remediation text
  // (152.0b7 → 153.0b8 source-refresh drill). Fail-soft by design: only
  // a definitively parsed minimum vs a definitively probed host version
  // can fail here; anything uncertain proceeds to mach, where the
  // mach-error-hints translator still names the right remedy.
  const toolchainMismatches = await runToolchainPreflight(paths.engine);
  if (toolchainMismatches.length > 0) {
    throw new BuildError(
      formatToolchainMismatchMessage(toolchainMismatches),
      'toolchain preflight'
    );
  }

  const buildCheck = await hasBuildArtifacts(paths.engine);
  if (buildCheck.ambiguous && buildCheck.objDirs && buildCheck.objDirs.length > 0) {
    throw new AmbiguousBuildArtifactsError(buildCheck.objDirs);
  }
  const mismatchMessage = buildArtifactMismatchMessage(paths.engine, buildCheck, 'Build');
  if (mismatchMessage) {
    if (options.rewriteMozinfo && buildCheck.objDir) {
      // Safe-relocation rewrite path: patch mozinfo.json paths in place so
      // `mach configure` can regenerate the backend without scrubbing the
      // whole obj tree. The rewriter refuses anything that is not a pure
      // prefix-move; on refusal we surface the refusal reason alongside
      // the original mismatch guidance and abort.
      await rewriteAndReconfigure(paths.engine, buildCheck.objDir, mismatchMessage);
    } else {
      throw new GeneralError(mismatchMessage);
    }
  }
  if (options.ui) {
    if (!buildCheck.exists || !buildCheck.objDir) {
      const detail = buildCheck.objDir
        ? `Build artifacts incomplete in ${buildCheck.objDir}/`
        : 'No completed obj-* build artifacts found.';
      throw new GeneralError(
        `UI-only builds require a completed full build first. ${detail}\n\n` +
          'Run "fireforge build" and let it finish, then retry "fireforge build --ui".'
      );
    }
    const bundleCheck = await hasRunnableBundle(paths.engine, config.binaryName, buildCheck.objDir);
    if (!bundleCheck.runnable) {
      const expectedSuffix = bundleCheck.expectedPath
        ? ` Expected launchable binary at engine/${bundleCheck.expectedPath}.`
        : '';
      throw new GeneralError(
        `UI-only builds require a completed full build first.${expectedSuffix}\n\n` +
          'Freshly imported or partially built trees cannot use `mach build faster` yet. ' +
          'Run "fireforge build" and let it finish, then retry "fireforge build --ui".'
      );
    }
  }

  // Log brand info if specified
  if (options.brand) {
    verbose(`Building with brand: ${options.brand}`);
    // Future: Load brand-specific config from fireforge.json brands section
    info(`Brand: ${options.brand}`);
  }

  // Read the previous build baseline BEFORE prepareBuildEnvironment so the
  // auto-configure step there can detect moz.build-family changes since the
  // last successful build. The post-build audit below reuses the same
  // baseline to diff engine changes against dist artifacts.
  const previousBaseline = await readBuildBaseline(projectRoot);

  // Shared pre-flight: branding, Furnace, mozconfig, auto-configure
  await prepareBuildEnvironment(projectRoot, paths, config, { previousBaseline });

  const jobs = resolveJobCount(options, config.build?.jobs);

  // Run build
  info(`Starting ${buildType.toLowerCase()} build...`);
  if (jobs !== undefined) {
    info(`Using ${jobs} parallel jobs`);
  }
  info(''); // Empty line before build output

  const startTime = Date.now();
  let result: ProtectedMachBuildResult;

  try {
    // Hold the per-project build lock across the mach invocation so two
    // overlapping `fireforge build` / `fireforge build --ui` commands
    // against the same engine tree serialise instead of racing through
    // the same obj-*. 2026-04-21 eval: a `build --ui` launched during
    // an in-progress full build hit `No rule to make target 'XUL'` in
    // mach, which is the downstream consequence of an incomplete
    // backend — not a clue that a concurrent build was the cause. The
    // lock turns the second invocation's failure into an explicit
    // refusal naming the holder PID.
    result = await withBuildLock(projectRoot, async () => {
      if (options.ui) {
        return buildUI(paths.engine);
      }
      return build(paths.engine, jobs);
    });
  } catch (error: unknown) {
    throw new BuildError(
      'Build process failed to start',
      options.ui ? 'mach build faster' : 'mach build',
      error instanceof Error ? error : undefined
    );
  }

  const duration = Date.now() - startTime;
  const minutes = Math.floor(duration / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);
  const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  if (result.exitCode !== 0) {
    error(`Build failed after ${timeStr}`);
    const machCommand = options.ui ? 'mach build faster' : 'mach build';
    // When the protected dispatch exhausted its recognized-crash retry
    // budget, lead with the environmental-crash explanation so the
    // operator does not read a resource-monitor traceback as a build
    // regression.
    const crashPreamble = result.crashSignature
      ? `${buildHarnessCrashMessage(result.crashSignature, result.attempts, machCommand)}\n\n`
      : '';
    throw new BuildError(
      crashPreamble + buildFailureDiagnostics(result, paths.engine, buildCheck.objDir, machCommand),
      machCommand
    );
  }

  // Tool-managed branding edits that land on `browser/moz.configure`
  // before the build cause mach's post-build guard to print one of two
  // banners that read like build failures even though the build
  // completed cleanly:
  //
  //   1) "config.status is out of date with respect to ..."
  //   2) "Config object not found by mach. / Configure complete! /
  //      Be sure to run |mach build| to pick up any changes."
  //
  // 2026-04-21 eval covered (1); 2026-04-26 eval Finding 8 reproduced
  // (2) on a successful build. The pre-fix pattern only matched (1),
  // so operators on the (2) path saw mach's own "Configure complete!"
  // and "run |mach build|" lines unexplained between mach's
  // "Your build was successful!" and FireForge's own "Build completed
  // in Xm Ys" outro — a contradictory tail. Both shapes now route
  // through the same annotation, emitted BEFORE FireForge's outro so
  // the operator's last terminal line is the explanation, not the
  // confusing mach guard text.
  const staleConfigurePatterns: RegExp[] = [
    /config\.status is out of date/i,
    /Config object not found by mach\.[\s\S]*Configure complete!/i,
  ];
  const captured = `${result.stdout}\n${result.stderr}`;
  if (staleConfigurePatterns.some((p) => p.test(captured))) {
    info(
      'Note: mach printed a post-build "Configure complete!" / "config.status is out of date" ' +
        'banner. That is a known side effect of tool-managed branding edits applied before the ' +
        'build and does not mean the build is stale or that you need to rerun mach — the FireForge ' +
        'exit code is authoritative.'
    );
  }

  // Warn-only post-build audit: surfaces silent packaging drops (files
  // edited in engine/ but never registered for packaging) against the
  // previous-build baseline. Never fails the build; the worst case is a
  // warning an operator chooses to investigate.
  try {
    await auditBuildArtifacts(projectRoot, paths.engine, previousBaseline);
  } catch (auditError: unknown) {
    verbose(`Audit skipped: ${toError(auditError).message}`);
  }

  // Record a fresh baseline only on clean success so the next run audits
  // against this build's HEAD. A failed build keeps the prior baseline so
  // the next attempt still catches long-standing packaging drops.
  try {
    await writeBuildBaseline(projectRoot, paths.engine, config.binaryName);
  } catch (baselineError: unknown) {
    verbose(`Could not persist build baseline: ${toError(baselineError).message}`);
  }

  outro(`Build completed in ${timeStr}!`);
}

/** Registers the build command on the CLI program. */
export function registerBuild(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('build')
    .description('Build the browser (auto-applies Furnace components first)')
    .option('--ui', 'Fast UI-only rebuild')
    .option('-j, --jobs <n>', 'Number of parallel jobs', parseJobCount)
    .option('--brand <name>', 'Build specific brand')
    .option(
      '--rewrite-mozinfo',
      'On a mozinfo path mismatch, patch mozinfo.json paths in place and run mach configure instead of aborting with a clean-rebuild instruction. Refuses anything that is not a pure prefix-move.'
    )
    .addHelpText(
      'after',
      [
        '',
        'Furnace apply runs automatically before the build step, so edits in',
        'components/custom/ and components/overrides/ are propagated to the',
        'engine/ tree every time. The command prints a banner listing the',
        'components synced during the current invocation.',
        '',
        'If you want to preview the engine state without triggering a build,',
        'run `fireforge furnace apply` directly. For source-change-driven',
        'rebuild loops during development, use `fireforge watch`.',
        '',
        '--rewrite-mozinfo: when a workspace is moved to a new path, mozinfo.json',
        'still records the old topsrcdir/topobjdir and the build aborts with a',
        'delete-and-rebuild instruction. This flag patches those paths in place',
        'and runs mach configure — preserving up to ~20 GB of obj-* artefacts on',
        'a relocation. The rewriter refuses any change that is not a pure prefix',
        'move, in which case a clean rebuild is still required.',
      ].join('\n')
    )
    .action(
      withErrorHandling(
        async (options: {
          ui?: boolean;
          jobs?: number;
          brand?: string;
          rewriteMozinfo?: boolean;
        }) => {
          const projectRoot = getProjectRoot();
          await withEngineSessionLock(projectRoot, 'build', () =>
            buildCommand(projectRoot, pickDefined(options))
          );
        }
      )
    );
}
