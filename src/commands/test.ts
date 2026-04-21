// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  testWithOutput,
} from '../core/mach.js';
import { assertMarionettePortAvailable } from '../core/marionette-port.js';
import { reportMarionettePreflight, runMarionettePreflight } from '../core/marionette-preflight.js';
import { checkStaleBuildForTest, formatStaleBuildWarning } from '../core/test-stale-check.js';
import {
  operatorAlreadySetAppPath,
  resolveXpcshellAppdirArg,
  type XpcshellAppdirOutcome,
} from '../core/xpcshell-appdir.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { TestOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { stripEnginePrefix } from '../utils/paths.js';

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
  // Deliberately narrow: only fire on branding-specific resource paths
  // that are always a stale-artifact symptom. The earlier pattern also
  // matched `resource:///modules/distribution.sys.mjs`, which surfaced on
  // real packaging / module-resolution failures too (e.g. a fork's
  // `HominisStore.sys.mjs` missing from the installed app dir after a
  // successful build). That false-positive pushed operators toward
  // "rebuild" advice for what was actually a module-registration issue.
  return (
    /chrome:\/\/branding\/locale\/brand\.properties/i.test(output) ||
    /browser\/branding\/[^/\s]+\/moz\.build/i.test(output)
  );
}

// Detects the broader xpcshell symptom where every `resource:///modules/...`
// import fails — the signature of xpcshell running with the wrong app-dir on
// a manifest that sets `firefox-appdir = "browser"`. Checked AFTER the
// stale-build signal (which matches the narrower `distribution.sys.mjs`
// path) so the more specific diagnosis wins when both patterns apply.
function hasXpcshellAppdirSignal(output: string): boolean {
  return /Failed to load resource:\/\/\/modules\//i.test(output);
}

function buildXpcshellAppdirMessage(injectionAttempted: boolean): string {
  const triggerLines = injectionAttempted
    ? 'FireForge auto-injected `--app-path=<absolute>` against the resolved obj-dir before mach test ran, but the failure persists. The injected path either does not match the appdir layout your harness expects, or the harness was built against a layout FireForge cannot probe (omni.ja-packed tree, alternate `dist/` shape).\n\n'
    : 'Likely triggers:\n' +
      '  - The nearest xpcshell.toml sets `firefox-appdir = "browser"` but the harness reads `<appname>-appdir` instead — the literal `firefox-appdir` directive is silently ignored on rebranded forks (appname != "firefox").\n' +
      '  - FireForge could not find an xpcshell.toml above the test path, so the auto-injection never ran.\n\n';
  return (
    'xpcshell failed to load core resource:///modules/*.sys.mjs imports.\n\n' +
    'This is the canonical symptom of xpcshell running with the wrong app directory: the runtime resolves `resource:///modules/` against the parent of the expected app root, so every `ChromeUtils.importESModule("resource:///modules/…")` throws.\n\n' +
    triggerLines +
    'Options:\n' +
    '  - Add `<appname>-appdir = "browser"` alongside `firefox-appdir = "browser"` in the xpcshell.toml [DEFAULT] so the harness reads the appname-keyed value directly.\n' +
    '  - Pass overrides through `fireforge test <path> --mach-arg="--app-path=<absolute>"` to inject the path verbatim (operator overrides always win over auto-injection).\n' +
    '  - Remove `firefox-appdir = "browser"` from the xpcshell.toml [DEFAULT] and move browser-chrome dependencies into a browser-chrome mochitest (see `fireforge furnace create --test-style=browser-chrome`).\n' +
    '  - If the test only touches toolkit chrome (chrome://global/*), drop the `firefox-appdir` setting entirely — toolkit chrome is registered without it.'
  );
}

// Detects the `AttributeError: 'MochitestDesktop' object has no attribute
// 'http3Server'` teardown crash. The attribute is lazy-initialized inside
// harness code paths that presume chrome://branding resolves correctly; a
// missing or miswired branding registration short-circuits the setup and
// leaves the cleanup path looking up an attribute that was never assigned.
function hasMochitestHttp3ServerSignal(output: string): boolean {
  return /'MochitestDesktop' object has no attribute 'http3Server'/.test(output);
}

function buildMochitestHttp3ServerMessage(): string {
  return (
    "Mochitest raised `AttributeError: 'MochitestDesktop' object has no attribute 'http3Server'`.\n\n" +
    'This is almost always a symptom of `chrome://branding` not registering correctly in your fork — the mochitest harness lazy-initializes `http3Server` only after branding resolves, and a missing branding registration short-circuits setup. The cleanup path then trips the AttributeError, masking the real error.\n\n' +
    'Check that:\n' +
    "  - Your fork's branding directory is listed in `browser/branding/moz.build` (or equivalent) and ships a `brand.properties` / `brand.ftl`.\n" +
    '  - `chrome://branding/locale/brand.properties` resolves at runtime (try `fireforge run` and inspect the Browser Console).\n' +
    "  - The `BROWSER_CHROME_MANIFESTS` entry for your fork's chrome.manifest is registered.\n\n" +
    'This is an upstream Firefox harness interaction; FireForge can only diagnose it.'
  );
}

function handleNonZeroTestExit(
  result: { stdout: string; stderr: string; exitCode: number },
  normalizedPaths: string[],
  appdirInjectionAttempted: boolean
): void {
  if (result.exitCode === 0 || result.exitCode === 130) return;
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (/UNKNOWN TEST\b/i.test(combinedOutput)) {
    throw new GeneralError(buildUnknownTestMessage(normalizedPaths));
  }
  // Branding-specific stale-build signals keep priority over the broader
  // xpcshell-appdir hint: when `chrome://branding/locale/brand.properties`
  // fails to resolve, the fix really is "rebuild", not "pass --app-path".
  // But the stale-build check is now narrower — it no longer matches
  // `resource:///modules/distribution.sys.mjs` alone, which was producing
  // false-positive rebuild advice on fork-custom module-load failures
  // (the eval saw this for `HominisStore.sys.mjs`). Cases that once
  // landed on `distribution.sys.mjs` fall through to xpcshell-appdir,
  // which is the more useful diagnosis in practice for `Failed to load
  // resource:///modules/…`.
  if (hasStaleBuildArtifactsSignal(combinedOutput)) {
    throw new GeneralError(buildStaleBuildMessage());
  }
  if (hasXpcshellAppdirSignal(combinedOutput)) {
    throw new GeneralError(buildXpcshellAppdirMessage(appdirInjectionAttempted));
  }
  if (hasMochitestHttp3ServerSignal(combinedOutput)) {
    throw new GeneralError(buildMochitestHttp3ServerMessage());
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

  // Load the project config once so both the build and the port
  // probe have access to `binaryName` (the port probe uses it to
  // recognise a fork-branded browser holding the Marionette port).
  const projectConfig = await loadConfig(projectRoot);

  // Run incremental build if requested
  if (options.build) {
    await prepareBuildEnvironment(projectRoot, paths, projectConfig);
    const s = spinner('Running incremental build...');
    const buildExitCode = await buildUI(paths.engine);
    if (buildExitCode !== 0) {
      s.error('Pre-test build failed');
      throw new BuildError('Pre-test build failed', 'mach build faster');
    }
    s.stop('Build complete');
    info('');
  } else {
    // Stale-build preflight — when --build was NOT requested, detect
    // packageable engine edits since the last successful `fireforge build`
    // and warn UP-FRONT. Without this, edits to chrome / packaged resources
    // surface only as a cryptic `NS_ERROR_FILE_NOT_FOUND` inside xpcshell
    // after mach test has already launched (see motivating case in
    // `core/test-stale-check.ts`). The check is warn-only so a fork that
    // rebuilt out-of-band (no FireForge-recorded baseline update) is not
    // blocked from running tests.
    const stale = await checkStaleBuildForTest(projectRoot, paths.engine);
    if (stale.stale) {
      warn(formatStaleBuildWarning(stale));
    }
  }

  // Stale-browser probe: an interrupted earlier test run can leave a
  // Firefox/ForgeFresh/Hominis instance listening on the Marionette
  // control port, which breaks the next mach test launch with a
  // bind error that points nowhere near the real cause. Raise a
  // targeted refusal up front instead of letting mach surface the
  // generic bind failure. 2026-04-21 eval (Finding #20): a stale
  // `-marionette` process from `fresh/` poisoned a later test run in
  // the sibling `hominis/` workspace.
  await assertMarionettePortAvailable(undefined, { binaryName: projectConfig.binaryName });

  // `--doctor` runs a short marionette handshake probe. When test paths are
  // supplied the probe gates the mach test invocation (a FAIL bails out). When
  // no paths are supplied this is the only step — it's the fastest way to tell
  // marionette-wedged apart from test-discovery-failure.
  if (options.doctor) {
    info('Running marionette preflight...');
    const preflight = await runMarionettePreflight(paths.engine);
    reportMarionettePreflight(preflight);
    if (testPaths.length === 0) {
      if (!preflight.ok) {
        throw new GeneralError('Marionette preflight reported FAIL — see output above.');
      }
      // Close the intro frame explicitly. Without an outro, clack's
      // grouped-output mode left the PASS line hanging inside an
      // unclosed tree — in the eval's non-TTY capture the info line
      // itself failed to render, so `test --doctor` looked like it had
      // exited silently after the spinner start line. The outro also
      // gives scripts a deterministic "done" marker to parse.
      outro(`Marionette preflight: PASS (${preflight.durationMs}ms)`);
      return;
    }
    if (!preflight.ok) {
      throw new GeneralError(
        'Marionette preflight reported FAIL — see output above. Aborting before mach test runs.'
      );
    }
  }

  // Normalize test paths (strip engine/ prefix if present). Uses the
  // shared `stripEnginePrefix` helper so `test`, `register`, `lint`, and
  // `export` all accept the same prefix forms. Also trim to match the
  // previous case-insensitive + leading-whitespace-tolerant contract.
  const normalizedPaths = testPaths.map((p) => stripEnginePrefix(p).trim());
  await assertTestPathsExist(paths.engine, normalizedPaths);

  // Build extra args
  const extraArgs: string[] = [];

  if (options.headless) {
    extraArgs.push('--headless');
  }

  // --mach-arg is a verbatim passthrough for upstream mach/xpcshell/mochitest
  // flags FireForge does not model directly (see the xpcshell appdir hint
  // above for the motivating case). Appended AFTER --headless so mach sees
  // the FireForge-managed flags first and the escape-valve ones last, which
  // keeps the override precedence predictable.
  if (options.machArg && options.machArg.length > 0) {
    extraArgs.push(...options.machArg);
  }

  // xpcshell appdir auto-injection — see src/core/xpcshell-appdir.ts for the
  // full motivation. On rebranded forks (appname != "firefox") the upstream
  // harness silently ignores `firefox-appdir = "browser"` directives in the
  // xpcshell.toml, so every `resource:///modules/…` import throws. We probe
  // the nearest manifest, compute the absolute appdir under obj-*/dist/, and
  // inject `--app-path=<abs>` so the harness uses the right root. Operator
  // overrides via `--mach-arg=--app-path=…` always win — we skip injection
  // when the operator already passed one.
  const appdirInjection = await maybeInjectAppdirArg(
    paths.engine,
    normalizedPaths,
    buildCheck.objDir,
    extraArgs
  );

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

  handleNonZeroTestExit(result, normalizedPaths, appdirInjection);
}

/**
 * Resolves and (when applicable) appends an `--app-path=<abs>` arg to
 * `extraArgs`. Returns true iff the arg was injected. The logging branches
 * mirror the {@link XpcshellAppdirOutcome} variants so an operator can tell
 * from the test output whether FireForge tried to help and what it found.
 */
async function maybeInjectAppdirArg(
  engineDir: string,
  normalizedPaths: readonly string[],
  objDir: string | undefined,
  extraArgs: string[]
): Promise<boolean> {
  if (!objDir) return false;
  if (operatorAlreadySetAppPath(extraArgs)) return false;
  const outcome: XpcshellAppdirOutcome = await resolveXpcshellAppdirArg(
    engineDir,
    normalizedPaths,
    objDir
  );
  switch (outcome.kind) {
    case 'none':
      return false;
    case 'mismatch':
      warn(
        `xpcshell appdir auto-injection skipped — multiple test paths resolved to different app dirs (${outcome.values.join(', ')}). Pass --mach-arg=--app-path=<abs> to disambiguate.`
      );
      return false;
    case 'unresolved':
      warn(
        `xpcshell appdir auto-injection skipped — manifest at ${outcome.manifestPath} requests appdir "${outcome.relativeAppdir}" but no matching directory exists under ${objDir}/dist/. Build artifacts may be stale.`
      );
      return false;
    case 'injected':
      extraArgs.push(`--app-path=${outcome.result.appPath}`);
      info(
        `xpcshell appdir auto-injected: --app-path=${outcome.result.appPath} (from ${outcome.result.manifestPath} firefox-appdir=${outcome.result.relativeAppdir}).`
      );
      return true;
  }
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
    .option(
      '--doctor',
      'Run a marionette handshake preflight before tests (exit 1 on FAIL). With no paths, runs the preflight only.'
    )
    .option(
      '--mach-arg <arg>',
      'Forward this argument verbatim to `mach test` (repeatable). Escape valve for upstream xpcshell/mochitest flags FireForge does not model.',
      (value: string, acc: string[]) => {
        acc.push(value);
        return acc;
      },
      [] as string[]
    )
    .action(
      withErrorHandling(
        async (
          paths: string[],
          options: {
            headless?: boolean;
            build?: boolean;
            doctor?: boolean;
            machArg?: string[];
          }
        ) => {
          await testCommand(getProjectRoot(), paths, pickDefined(options));
        }
      )
    );
}
