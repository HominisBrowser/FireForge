// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  hasRunnableBundle,
  testWithOutput,
  withBuildLock,
} from '../core/mach.js';
import {
  assertMarionettePortAvailable,
  extractForwardedMarionettePort,
  forwardedMachArgsIncludeMarionetteClient,
  shouldAutoForwardMarionettePortToMach,
} from '../core/marionette-port.js';
import {
  formatMarionettePreflightLine,
  reportMarionettePreflight,
  runMarionettePreflight,
} from '../core/marionette-preflight.js';
import {
  buildHarnessEarlyExitMessage,
  classifyHarnessEarlyExit,
} from '../core/test-harness-output.js';
import { checkStaleBuildForTest, formatStaleBuildWarning } from '../core/test-stale-check.js';
import { tryRepairStaleXpcshellTestSymlink } from '../core/test-stale-symlink.js';
import { findNearestXpcshellManifest } from '../core/xpcshell-appdir.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { TestOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { maybeInjectAppdirArg } from './test-appdir.js';

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

interface HarnessClassification {
  xpcshell: string[];
  nonXpcshell: string[];
}

async function classifyTestHarnesses(
  engineDir: string,
  normalizedPaths: readonly string[]
): Promise<HarnessClassification> {
  const result: HarnessClassification = { xpcshell: [], nonXpcshell: [] };
  for (const testPath of normalizedPaths) {
    const manifest = await findNearestXpcshellManifest(engineDir, testPath);
    if (manifest) {
      result.xpcshell.push(testPath);
    } else {
      result.nonXpcshell.push(testPath);
    }
  }
  return result;
}

function buildMixedHarnessMessage(classification: HarnessClassification): string {
  return (
    'FireForge cannot run xpcshell and browser/mochitest paths in the same mach invocation.\n\n' +
    'Split this into separate `fireforge test` commands so each manifest selects its own harness:\n' +
    `  - xpcshell: ${classification.xpcshell.join(', ')}\n` +
    `  - browser/mochitest: ${classification.nonXpcshell.join(', ')}`
  );
}

function filterRedundantXpcshellFlavorArgs(
  machArgs: readonly string[],
  classification: HarnessClassification
): string[] {
  if (classification.xpcshell.length === 0 || classification.nonXpcshell.length > 0) {
    return [...machArgs];
  }

  const filtered: string[] = [];
  for (let i = 0; i < machArgs.length; i += 1) {
    const arg = machArgs[i] ?? '';
    if (/^--flavor=xpcshell(?:-tests)?$/.test(arg)) {
      continue;
    }
    if (arg === '--flavor' && /^xpcshell(?:-tests)?$/.test(machArgs[i + 1] ?? '')) {
      i += 1;
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function hasStaleBuildArtifactsSignal(output: string): boolean {
  // Deliberately narrow: only fire on branding-specific resource paths
  // that are always a stale-artifact symptom. The earlier pattern also
  // matched `resource:///modules/distribution.sys.mjs`, which surfaced on
  // real packaging / module-resolution failures too (e.g. a fork's
  // `MyBrowserStore.sys.mjs` missing from the installed app dir after a
  // successful build). That false-positive pushed operators toward
  // "rebuild" advice for what was actually a module-registration issue.
  return (
    /chrome:\/\/branding\/locale\/brand\.properties/i.test(output) ||
    /browser\/branding\/[^/\s]+\/moz\.build/i.test(output)
  );
}

/**
 * Fork-module-not-registered signal. 2026-04-21 eval Finding #14:
 * a fork's test failed with `Failed to load resource:///modules/mybrowser/
 * MyBrowserStore.sys.mjs`. The branding pattern happened to also match
 * because the test harness printed a branding warning during its
 * teardown, and the stale-build branch won by precedence — telling the
 * operator to rebuild when the real fix is to register the module in
 * the fork's `browser/modules/<binary>/moz.build`. Match a
 * `resource:///modules/<binaryName>/` pattern so fork-owned module
 * failures surface the right diagnosis.
 */
function hasForkModuleSignal(output: string, binaryName: string): boolean {
  const pattern = new RegExp(
    `Failed to load resource:\\/\\/\\/modules\\/${binaryName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\/`,
    'i'
  );
  return pattern.test(output);
}

function buildForkModuleMessage(binaryName: string): string {
  return (
    `Test failed to load a fork-owned module at resource:///modules/${binaryName}/*.sys.mjs.\n\n` +
    'This is almost always a module-registration issue, not a stale build. The fork module directory is missing an entry that maps its file into the resource URI tree, so `ChromeUtils.importESModule` cannot resolve it.\n\n' +
    'Check that:\n' +
    `  - browser/modules/${binaryName}/moz.build lists the missing module in EXTRA_JS_MODULES.\n` +
    `  - browser/modules/moz.build references the ${binaryName}/ subdirectory (DIRS += [...]).\n` +
    '  - The last `fireforge build` (or `fireforge build --ui`) completed successfully against the current manifests. If the registration is new, the UI-faster build path may not pick it up — a full build may be required.\n\n' +
    'Use `fireforge register browser/modules/' +
    binaryName +
    '/<file>.sys.mjs` to add the EXTRA_JS_MODULES entry if it is missing.'
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
  const isMacos = process.platform === 'darwin';
  const macosNote = isMacos
    ? 'Detected: macOS host. On macOS the xpcshell harness binds `-a` to `<obj>/dist/<App>.app/Contents/Resources` by default and frequently ignores `--app-path` overrides when the `.app` bundle is present — the surest fix is the `<appname>-appdir` migration below rather than trying to force a different path.\n\n'
    : '';
  const triggerLines = injectionAttempted
    ? 'FireForge auto-injected `--app-path=<absolute>` against the resolved obj-dir before mach test ran, but the failure persists. The injected path either does not match the appdir layout your harness expects, or (on macOS) the harness bound `-a` to the `.app/Contents/Resources` default and ignored the override.\n\n'
    : 'Likely triggers:\n' +
      '  - The nearest xpcshell.toml sets `firefox-appdir = "browser"` but the harness reads `<appname>-appdir` instead — the literal `firefox-appdir` directive is silently ignored on rebranded forks (appname != "firefox").\n' +
      '  - FireForge could not find an xpcshell.toml above the test path, so the auto-injection never ran.\n\n';
  return (
    'xpcshell failed to load core resource:///modules/*.sys.mjs imports.\n\n' +
    'This is the canonical symptom of xpcshell running with the wrong app directory: the runtime resolves `resource:///modules/` against the parent of the expected app root, so every `ChromeUtils.importESModule("resource:///modules/…")` throws.\n\n' +
    macosNote +
    triggerLines +
    'Options:\n' +
    '  - Add `<appname>-appdir = "browser"` alongside `firefox-appdir = "browser"` in the xpcshell.toml [DEFAULT] so the harness reads the appname-keyed value directly. This is the most reliable fix on rebranded macOS builds.\n' +
    '  - Pass overrides through `fireforge test <path> --mach-arg="--app-path=<absolute>"` to inject the path verbatim (operator overrides always win over auto-injection, but see the macOS caveat above).\n' +
    '  - Remove `firefox-appdir = "browser"` from the xpcshell.toml [DEFAULT] and move browser-chrome dependencies into a browser-chrome mochitest (see `fireforge furnace create --test-style=browser-chrome`).\n' +
    '  - If the test only touches toolkit chrome (chrome://global/*), drop the `firefox-appdir` setting entirely — toolkit chrome is registered without it.'
  );
}

function buildHarnessSymlinkMessage(): string {
  return (
    'mach failed while preparing test harness symlinks before the requested tests ran.\n\n' +
    'This usually means the objdir contains stale harness setup from an earlier run. Re-run with `fireforge test --build` to refresh the harness state, or remove the stale harness symlink in the active obj-* directory before retrying.'
  );
}

async function resolveLaunchablePathForTests(
  engineDir: string,
  binaryName: string,
  objDir: string | undefined
): Promise<string | undefined> {
  if (!objDir) return undefined;
  const bundleCheck = await hasRunnableBundle(engineDir, binaryName, objDir);
  if (!bundleCheck.runnable) {
    const expectedSuffix = bundleCheck.expectedPath
      ? ` (expected at engine/${bundleCheck.expectedPath})`
      : '';
    throw new GeneralError(
      `Tests require a complete launchable build${expectedSuffix}. ` +
        'The obj-*/dist/ tree exists but the launchable binary is missing — typically the result of an interrupted or partially failed `fireforge build`.\n\n' +
        'Run "fireforge build" again and let it finish before retrying "fireforge test".'
    );
  }
  return bundleCheck.expectedPath;
}

async function runPreTestBuild(
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>,
  projectConfig: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  await withBuildLock(projectRoot, async () => {
    await prepareBuildEnvironment(projectRoot, paths, projectConfig);
    const s = spinner('Running incremental build...');
    const buildResult = await buildUI(paths.engine);
    if (buildResult.exitCode !== 0) {
      s.error('Pre-test build failed');
      throw new BuildError('Pre-test build failed', 'mach build faster');
    }
    s.stop('Build complete');
  });
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
  appdirInjectionAttempted: boolean,
  binaryName: string
): void {
  if (result.exitCode === 0 || result.exitCode === 130) return;
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (/UNKNOWN TEST\b/i.test(combinedOutput)) {
    throw new GeneralError(buildUnknownTestMessage(normalizedPaths));
  }
  const earlyExit = classifyHarnessEarlyExit(combinedOutput, normalizedPaths);
  if (earlyExit) {
    throw new GeneralError(buildHarnessEarlyExitMessage(earlyExit, normalizedPaths));
  }
  // Fork-owned module load failures must beat the branding stale-build
  // branch: 2026-04-21 eval (Finding #14) saw a fork's test fail with
  // `Failed to load resource:///modules/mybrowser/MyBrowserStore.sys.mjs`
  // while the harness teardown printed a branding warning that the old
  // stale-build pattern matched, so the operator was told to rebuild
  // when the real fix is to register the missing module.
  if (hasForkModuleSignal(combinedOutput, binaryName)) {
    throw new GeneralError(buildForkModuleMessage(binaryName));
  }
  // Branding-specific stale-build signals keep priority over the broader
  // xpcshell-appdir hint: when `chrome://branding/locale/brand.properties`
  // fails to resolve, the fix really is "rebuild", not "pass --app-path".
  // But the stale-build check is now narrower — it no longer matches
  // `resource:///modules/distribution.sys.mjs` alone, which was producing
  // false-positive rebuild advice on fork-custom module-load failures
  // (the eval saw this for `MyBrowserStore.sys.mjs`). Cases that once
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
    /FileExistsError/i.test(combinedOutput) &&
    /(mochitest|xpcshell|_tests)/i.test(combinedOutput)
  ) {
    throw new GeneralError(buildHarnessSymlinkMessage());
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

  // `hasBuildArtifacts` only confirms `obj-*/dist/` exists; a partial
  // build (linker failed, packaging step interrupted, etc.) can satisfy
  // that check without ever writing the launchable binary the marionette
  // preflight needs to spawn. `fireforge run` already uses
  // `hasRunnableBundle` to fail fast with a precise message; mirror that
  // here so `test --doctor` against an incomplete build surfaces the
  // missing-bundle path instead of a cryptic `Browser process exited
  // during spawn (exit code 1, signal none). stderr tail: (empty)`.
  const launchablePath = await resolveLaunchablePathForTests(
    paths.engine,
    projectConfig.binaryName,
    buildCheck.objDir
  );

  // Run incremental build if requested
  if (options.build) {
    await runPreTestBuild(projectRoot, paths, projectConfig);
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

  // Resolve the effective Marionette port. Operator precedence:
  //   1. `--marionette-port` (first-class option, parsed at the CLI layer)
  //   2. forwarded `--mach-arg --marionette-port=NNNN` /
  //      `--mach-arg --setpref=marionette.port=NNNN`
  //   3. fall back to `DEFAULT_MARIONETTE_PORT` semantics inside the probes
  //      (passed as `undefined`).
  // Without (2), an operator working around a stale listener via the
  // documented `--mach-arg --marionette-port=NNNN` workaround would still
  // hit the wrapper preflight refusing on 2828 before the forwarded arg
  // ever reached mach.
  const forwardedPort = options.machArg
    ? extractForwardedMarionettePort(options.machArg)
    : undefined;
  const effectivePort = options.marionettePort ?? forwardedPort;

  // Stale-browser probe: an interrupted earlier test run can leave a
  // Firefox/ForgeFresh/fork instance listening on the Marionette
  // control port, which breaks the next mach test launch with a
  // bind error that points nowhere near the real cause. Raise a
  // targeted refusal up front instead of letting mach surface the
  // generic bind failure. 2026-04-21 eval (Finding #20): a stale
  // `-marionette` process from `fresh/` poisoned a later test run in
  // the sibling `mybrowser/` workspace.
  await assertMarionettePortAvailable(effectivePort, { binaryName: projectConfig.binaryName });

  // `--doctor` runs a short marionette handshake probe. When test paths are
  // supplied the probe gates the mach test invocation (a FAIL bails out). When
  // no paths are supplied this is the only step — it's the fastest way to tell
  // marionette-wedged apart from test-discovery-failure.
  if (options.doctor) {
    // Write the "Running marionette preflight..." banner via
    // `process.stdout.write` directly before `info()` so non-TTY captures
    // always see the banner even if clack's renderer defers output in
    // pipe mode. `info()` is still called so TTY users keep the normal
    // clack box-drawing framing.
    process.stdout.write('Running marionette preflight...\n');
    info('Running marionette preflight...');
    const preflight =
      effectivePort !== undefined
        ? await runMarionettePreflight(paths.engine, { port: effectivePort })
        : await runMarionettePreflight(paths.engine);
    // 2026-04-24 eval Finding 7: the pre-0.18.1 code used
    // `success()` + `outro()` + a direct `process.stdout.write` as a
    // belt-and-suspenders but still reproducibly dropped the PASS summary
    // under non-TTY capture (observed: `tee`-wrapped eval output saw only
    // the intro). The fix writes the authoritative PASS/FAIL line via
    // `process.stdout.write` as the very first output after the probe
    // returns, so the captured stream has an unambiguous summary no
    // matter what clack does on top. The clack-rendered banner
    // (`info`/`warn`) is retained so TTY users keep the visual framing.
    const directLine = formatMarionettePreflightLine(preflight);
    process.stdout.write(`${directLine}\n`);
    process.stdout.write(
      `Marionette preflight environment: objdir=${buildCheck.objDir ?? '(none)'}; binary=${projectConfig.binaryName}; app=${launchablePath ? `engine/${launchablePath}` : '(unknown)'}; port=${effectivePort ?? 2828}; elapsed=${preflight.durationMs}ms\n`
    );
    reportMarionettePreflight(preflight);
    if (testPaths.length === 0) {
      if (!preflight.ok) {
        throw new GeneralError('Marionette preflight reported FAIL — see output above.');
      }
      success(directLine);
      outro('Test completed');
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
  const classification = await classifyTestHarnesses(paths.engine, normalizedPaths);
  if (classification.xpcshell.length > 0 && classification.nonXpcshell.length > 0) {
    throw new GeneralError(buildMixedHarnessMessage(classification));
  }
  const forwardedMachArgs =
    options.machArg && options.machArg.length > 0
      ? filterRedundantXpcshellFlavorArgs(options.machArg, classification)
      : [];

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
  if (forwardedMachArgs.length > 0) {
    extraArgs.push(...forwardedMachArgs);
  }

  // Auto-forward the Marionette port to mach when `--marionette-port` is
  // set. `--setpref=marionette.port=<n>` configures where the browser
  // listener binds; `--marionette=127.0.0.1:<n>` tells the mochitest harness
  // client to connect there (default client is 127.0.0.1:2828). xpcshell
  // ignores both for browser Marionette.
  //
  // Skip setpref forwarding when the operator already supplied an equivalent
  // arg via `--mach-arg` — duplicates would be confusing without changing
  // semantics. Skip when mach args explicitly request `--flavor=xpcshell`
  // (or `xpcshell-tests`): the preflight still honours `--marionette-port`,
  // but mach does not use the marionette.port pref on that harness. Any
  // other arg shape still forwards so toolkit widget paths and mixed suites
  // stay aligned with the probe without duplicate `--mach-arg` flags.
  //
  // Skip auto `--marionette=...` when `--mach-arg` already includes a client
  // `--marionette=...` (or two-token `--marionette host:port`).
  if (options.marionettePort !== undefined) {
    const operatorAlreadyForwarded = forwardedPort !== undefined;
    const machArgs = options.machArg ?? [];
    if (operatorAlreadyForwarded) {
      info(
        `--marionette-port=${options.marionettePort} set, but the same port is already forwarded via --mach-arg; skipping auto-forward.`
      );
    } else if (shouldAutoForwardMarionettePortToMach(machArgs)) {
      extraArgs.push(`--setpref=marionette.port=${options.marionettePort}`);
    } else {
      info(
        `--marionette-port=${options.marionettePort} applied to the preflight probe, but --flavor=xpcshell is set — mach is not auto-configured with --setpref=marionette.port or --marionette (xpcshell ignores the browser Marionette path). Pass --mach-arg --setpref=marionette.port=${options.marionettePort} explicitly if you still need mach to see the port.`
      );
    }

    if (
      shouldAutoForwardMarionettePortToMach(machArgs) &&
      !forwardedMachArgsIncludeMarionetteClient(machArgs)
    ) {
      extraArgs.push(`--marionette=127.0.0.1:${options.marionettePort}`);
    }
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

  if (
    result.exitCode !== 0 &&
    classification.xpcshell.length > 0 &&
    classification.nonXpcshell.length === 0
  ) {
    const repaired = await tryRepairStaleXpcshellTestSymlink(
      paths.engine,
      buildCheck.objDir,
      `${result.stdout}\n${result.stderr}`
    );
    if (repaired) {
      result = await testWithOutput(paths.engine, normalizedPaths, extraArgs);
    }
  }

  handleNonZeroTestExit(result, normalizedPaths, appdirInjection, projectConfig.binaryName);
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
    .option(
      '--marionette-port <port>',
      'Override the Marionette control port (default 2828) for the stale-browser probe, the --doctor preflight, and (unless --mach-arg includes --flavor=xpcshell) auto-forwarded mach args: --setpref=marionette.port=<n> (browser listener) and --marionette=127.0.0.1:<n> (mochitest client). Omits the client flag when --mach-arg already sets --marionette. Use when 2828 is busy or CI assigns another port.',
      (raw: string) => {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1 || n > 65535) {
          throw new GeneralError(`--marionette-port must be an integer in 1..65535 (got "${raw}")`);
        }
        return n;
      }
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
            marionettePort?: number;
          }
        ) => {
          await testCommand(getProjectRoot(), paths, pickDefined(options));
        }
      )
    );
}
