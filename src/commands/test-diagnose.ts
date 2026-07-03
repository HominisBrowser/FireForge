// SPDX-License-Identifier: EUPL-1.2
/**
 * Failure diagnosis for `fireforge test`: maps captured mach output to
 * actionable operator messages (unknown test paths, stale build artifacts,
 * fork-module registration, xpcshell appdir, harness symlinks, mochitest
 * branding interactions), and applies harness-run verdicts from
 * `test-harness-crash.ts` for single and sharded invocations. Split out of
 * `test.ts` to keep both files within the per-file line budget.
 */

import { buildHarnessCrashMessage, buildNoTestsRanMessage } from '../core/test-harness-crash.js';
import {
  buildHarnessEarlyExitMessage,
  classifyHarnessEarlyExit,
  completePostRebuildFailureContext,
  type PostRebuildFailureContext,
  prependPostRebuildFailureContext,
} from '../core/test-harness-output.js';
import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import { info } from '../utils/logger.js';
import type { TestRunOutcome } from './test-run.js';

function buildUnknownTestMessage(testPaths: string[]): string {
  return (
    `mach could not discover the requested test path${testPaths.length === 1 ? '' : 's'}: ${testPaths.join(', ')}\n\n` +
    'The file may exist, but Firefox does not currently resolve it as a runnable test.\n\n' +
    'Check the nearest test manifest (for example browser.toml or xpcshell.toml), confirm the file is listed under the correct test type, and make sure each parent moz.build registers that manifest before retrying.'
  );
}

function buildStaleBuildMessage(postRebuild: boolean): string {
  if (postRebuild) {
    return (
      'Firefox test runtime still reported stale-artifact-shaped resource failures after the rebuild completed.\n\n' +
      'FireForge already ran the requested rebuild before this focused test, so treat the remaining failure as a real runtime, registration, routing, or test-contract regression rather than another stale deployed-artifact-only blocker.\n\n' +
      'Check the first post-rebuild failure above and the raw mach output for the concrete path or module that still fails.'
    );
  }

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

/**
 *
 */
function handleNonZeroTestExit(
  result: { stdout: string; stderr: string; exitCode: number },
  normalizedPaths: string[],
  appdirInjectionAttempted: boolean,
  binaryName: string,
  postRebuildContext: PostRebuildFailureContext | undefined
): void {
  if (result.exitCode === 0 || result.exitCode === 130) return;
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const failureContext = postRebuildContext
    ? completePostRebuildFailureContext(postRebuildContext, combinedOutput)
    : undefined;
  const withContext = (message: string): string =>
    prependPostRebuildFailureContext(message, failureContext);
  const throwGeneral = (message: string): never => {
    throw new GeneralError(withContext(message));
  };
  if (/UNKNOWN TEST\b/i.test(combinedOutput)) {
    throwGeneral(buildUnknownTestMessage(normalizedPaths));
  }
  const earlyExit = classifyHarnessEarlyExit(combinedOutput, normalizedPaths);
  if (earlyExit) {
    throwGeneral(buildHarnessEarlyExitMessage(earlyExit, normalizedPaths));
  }
  // Fork-owned module load failures must beat the branding stale-build
  // branch: 2026-04-21 eval (Finding #14) saw a fork's test fail with
  // `Failed to load resource:///modules/mybrowser/MyBrowserStore.sys.mjs`
  // while the harness teardown printed a branding warning that the old
  // stale-build pattern matched, so the operator was told to rebuild
  // when the real fix is to register the missing module.
  if (hasForkModuleSignal(combinedOutput, binaryName)) {
    throwGeneral(buildForkModuleMessage(binaryName));
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
    throwGeneral(buildStaleBuildMessage(Boolean(failureContext)));
  }
  if (hasXpcshellAppdirSignal(combinedOutput)) {
    throwGeneral(buildXpcshellAppdirMessage(appdirInjectionAttempted));
  }
  if (hasMochitestHttp3ServerSignal(combinedOutput)) {
    throwGeneral(buildMochitestHttp3ServerMessage());
  }
  if (
    /FileExistsError/i.test(combinedOutput) &&
    /(mochitest|xpcshell|_tests)/i.test(combinedOutput)
  ) {
    throwGeneral(buildHarnessSymlinkMessage());
  }
  if (
    /invalid filename/i.test(combinedOutput) ||
    /chrome:\/\/mochitests.*not found/i.test(combinedOutput)
  ) {
    info('Hint: The test file may not be registered in browser.toml or jar.mn.');
    info('Run "fireforge register <test-path>" to register it.');
  }
  throw new BuildError(
    withContext(
      `Tests failed with exit code ${result.exitCode}. Check the output above for details.`
    ),
    'mach test'
  );
}

/**
 * Applies the harness-run verdict for a single (non-sharded) invocation:
 * exhausted harness-crash retries and silent zero-TEST-START runs are
 * harness problems with their own messages; everything else flows into
 * the regular non-zero-exit diagnosis chain.
 */
export function finalizeSingleRunOutcome(
  outcome: TestRunOutcome,
  normalizedPaths: string[],
  binaryName: string,
  postRebuildContext: PostRebuildFailureContext | undefined
): void {
  if (outcome.verdict.kind === 'harness-crash' && outcome.verdict.signature) {
    throw new GeneralError(buildHarnessCrashMessage(outcome.verdict.signature, outcome.attempts));
  }
  if (outcome.verdict.kind === 'tests-ran-ok') {
    // The verdict is authoritative over the raw exit code: a completed
    // green embedded summary overrides a non-zero exit caused by harness
    // noise (field report: fully green --no-shard runs exited 1, forcing
    // operators to parse embedded summaries by hand).
    if (outcome.verdict.greenSummaryOverride) {
      info(
        `Note: mach exited ${outcome.result.exitCode}, but the embedded suite summary completed ` +
          'green (Unexpected results: 0). FireForge treats the run as passed; the non-zero exit ' +
          'came from non-fatal harness noise (resource-monitor degradation / telemetry).'
      );
    }
    return;
  }
  if (outcome.verdict.kind === 'no-tests' && outcome.result.exitCode === 0) {
    // The silent false green: exit 0 plus a "Passed: 0"-style summary with
    // zero TEST-START lines must fail, not pass.
    throw new GeneralError(buildNoTestsRanMessage(0, normalizedPaths));
  }
  handleNonZeroTestExit(
    outcome.result,
    normalizedPaths,
    outcome.appdirInjectionAttempted,
    binaryName,
    postRebuildContext
  );
}

/**
 * Shard-mode adapter over {@link handleNonZeroTestExit}: produces the
 * diagnosis text as a string (to warn per shard) instead of throwing, so
 * later shards still run and the aggregate error stays singular.
 */
export function diagnoseShardOutcome(
  outcome: TestRunOutcome,
  path: string,
  binaryName: string,
  postRebuildContext: PostRebuildFailureContext | undefined
): string | undefined {
  if (outcome.verdict.kind === 'no-tests' && outcome.result.exitCode === 0) {
    return buildNoTestsRanMessage(0, [path]);
  }
  try {
    handleNonZeroTestExit(
      outcome.result,
      [path],
      outcome.appdirInjectionAttempted,
      binaryName,
      postRebuildContext
    );
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
