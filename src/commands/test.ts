// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { isBrandingSetup, setupBranding } from '../core/branding.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { cleanStories } from '../core/furnace-stories.js';
import {
  buildArtifactMismatchMessage,
  buildUI,
  generateMozconfig,
  hasBuildArtifacts,
  testWithOutput,
} from '../core/mach.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { TestOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, spinner } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Strips the "engine/" prefix from a path if present.
 * Users may specify paths like "engine/browser/modules/..." from the project
 * root, but mach test expects paths relative to the engine directory.
 * @param testPath - Path as provided by the user
 * @returns Path relative to the engine directory
 */
function normalizeTestPath(testPath: string): string {
  if (testPath.startsWith('engine/')) {
    return testPath.slice('engine/'.length);
  }
  if (testPath.startsWith('engine\\')) {
    return testPath.slice('engine\\'.length);
  }
  return testPath;
}

async function assertTestPathsExist(engineDir: string, testPaths: string[]): Promise<void> {
  const missingPaths: string[] = [];

  for (const testPath of testPaths) {
    if (!(await pathExists(join(engineDir, testPath)))) {
      missingPaths.push(testPath);
    }
  }

  if (missingPaths.length === 0) {
    return;
  }

  throw new GeneralError(
    `Test path${missingPaths.length === 1 ? '' : 's'} not found under engine/: ${missingPaths.join(', ')}\n\n` +
      'If you expected these files to come from your patch stack, run "fireforge import" first.'
  );
}

function buildUnknownTestMessage(testPaths: string[]): string {
  return (
    `mach could not discover the requested test path${testPaths.length === 1 ? '' : 's'}: ${testPaths.join(', ')}\n\n` +
    'The file may exist, but Firefox does not currently resolve it as a runnable test.\n\n' +
    'Check the nearest test manifest (for example browser.toml or xpcshell.toml), confirm the file is listed under the correct test type, and make sure each parent moz.build registers that manifest before retrying.'
  );
}

function buildStaleBuildMessage(): string {
  return (
    'Firefox test runtime appears to be using stale build artifacts.\n\n' +
    'The failing output referenced missing branding or distribution resources, which usually means the current obj-* build does not match recent engine or branding changes.\n\n' +
    'Re-run "fireforge build --ui" or "fireforge test --build" and then retry.'
  );
}

function hasStaleBuildArtifactsSignal(output: string): boolean {
  return (
    /chrome:\/\/branding\/locale\/brand\.properties/i.test(output) ||
    /resource:\/\/\/modules\/distribution\.sys\.mjs/i.test(output) ||
    /browser\/branding\/[^/\s]+\/moz\.build/i.test(output)
  );
}

async function prepareIncrementalTestBuild(projectRoot: string): Promise<{
  engineDir: string;
}> {
  const config = await loadConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  const brandingConfig = {
    name: config.name,
    vendor: config.vendor,
    appId: config.appId,
    binaryName: config.binaryName,
  };

  if (!(await isBrandingSetup(paths.engine, brandingConfig))) {
    const brandingSpinner = spinner('Setting up branding...');
    try {
      await setupBranding(paths.engine, brandingConfig);
      brandingSpinner.stop('Branding configured');
    } catch (error: unknown) {
      brandingSpinner.error('Failed to set up branding');
      throw error;
    }
  }

  const mozconfigSpinner = spinner('Generating mozconfig...');
  try {
    await generateMozconfig(paths.configs, paths.engine, config);
    mozconfigSpinner.stop('mozconfig generated');
  } catch (error: unknown) {
    mozconfigSpinner.error('Failed to generate mozconfig');
    throw error;
  }

  await cleanStories(paths.engine);

  return { engineDir: paths.engine };
}

function handleNonZeroTestExit(
  result: { stdout: string; stderr: string; exitCode: number },
  normalizedPaths: string[]
): void {
  if (result.exitCode === 0 || result.exitCode === 130) return;
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (/UNKNOWN TEST\b/i.test(combinedOutput)) {
    throw new GeneralError(buildUnknownTestMessage(normalizedPaths));
  }
  if (hasStaleBuildArtifactsSignal(combinedOutput)) {
    throw new GeneralError(buildStaleBuildMessage());
  }
  if (
    /invalid filename/i.test(combinedOutput) ||
    /chrome:\/\/mochitests.*not found/i.test(combinedOutput)
  ) {
    info('Hint: The test file may not be registered in browser.toml or jar.mn.');
    info('Run "fireforge register <test-path>" to register it.');
  }
  throw new BuildError(
    `Tests failed with exit code ${result.exitCode}. Check the output above for details.`,
    'mach test'
  );
}

/**
 * Runs the test command to execute mach tests.
 * @param projectRoot - Root directory of the project
 * @param testPaths - Test file or directory paths
 * @param options - Test options
 */
export async function testCommand(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions = {}
): Promise<void> {
  intro('FireForge Test');

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Check for build artifacts before running tests
  const buildCheck = await hasBuildArtifacts(paths.engine);
  if (buildCheck.ambiguous && buildCheck.objDirs && buildCheck.objDirs.length > 0) {
    throw new AmbiguousBuildArtifactsError(buildCheck.objDirs);
  }
  const mismatchMessage = buildArtifactMismatchMessage(paths.engine, buildCheck, 'Tests');
  if (mismatchMessage) {
    throw new GeneralError(mismatchMessage);
  }
  if (!buildCheck.exists) {
    const detail = buildCheck.objDir
      ? `Build artifacts incomplete in ${buildCheck.objDir}/`
      : 'No build artifacts found (obj-*/ directory missing)';
    throw new GeneralError(
      `Tests require a completed build. ${detail}\n\n` +
        "Run 'fireforge build' first, then run 'fireforge test'."
    );
  }

  // Run incremental build if requested
  if (options.build) {
    const { engineDir } = await prepareIncrementalTestBuild(projectRoot);
    const s = spinner('Running incremental build...');
    const buildExitCode = await buildUI(engineDir);
    if (buildExitCode !== 0) {
      s.error('Pre-test build failed');
      throw new BuildError('Pre-test build failed', 'mach build faster');
    }
    s.stop('Build complete');
    info('');
  }

  // Normalize test paths (strip engine/ prefix if present)
  const normalizedPaths = testPaths.map(normalizeTestPath);
  await assertTestPathsExist(paths.engine, normalizedPaths);

  // Build extra args
  const extraArgs: string[] = [];

  if (options.headless) {
    extraArgs.push('--headless');
  }

  // Log what we're doing
  if (normalizedPaths.length > 0) {
    info(`Running tests: ${normalizedPaths.join(', ')}`);
  } else {
    info('Running all tests...');
  }
  info('');

  let result: Awaited<ReturnType<typeof testWithOutput>>;

  try {
    result = await testWithOutput(paths.engine, normalizedPaths, extraArgs);
  } catch (error: unknown) {
    throw new BuildError(
      'Test process failed to start',
      'mach test',
      error instanceof Error ? error : undefined
    );
  }

  handleNonZeroTestExit(result, normalizedPaths);
}

/** Registers the test command on the CLI program. */
export function registerTest(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('test [paths...]')
    .description('Run tests via mach test')
    .option('--headless', 'Run tests in headless mode')
    .option('--build', 'Run incremental UI build before testing')
    .action(
      withErrorHandling(
        async (paths: string[], options: { headless?: boolean; build?: boolean }) => {
          await testCommand(getProjectRoot(), paths, pickDefined(options));
        }
      )
    );
}
