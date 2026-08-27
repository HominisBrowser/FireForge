// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { withEngineSessionLock } from '../core/engine-session-lock.js';
import { GeneralError, LockContentionError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import {
  addWaitLockOption,
  commanderArgParser,
  pickDefined,
  resolveWaitLockSeconds,
  stringListOption,
} from '../utils/options.js';
import { testCommand } from './test.js';
import { DEFAULT_HARNESS_RETRIES } from './test-run.js';
import { emitFailVerdict, resetVerdictEmission, verdictEmitted } from './test-verdict.js';

const TEST_HELP_TEXT = [
  '',
  '[paths...] semantics: a directory argument selects EXACTLY that',
  'directory. FireForge enumerates the test files of exactly that',
  'directory and passes the explicit file list to mach, because mach',
  'resolves test paths by string prefix and a bare directory name',
  'silently sweeps in sibling directories sharing the prefix (e.g.',
  'foo also running foo-extras) — an explicit file list cannot',
  'prefix-match anything. The directory still runs as ONE mach',
  'invocation (one browser instance), so cross-file state carries',
  'within it. When prefix-named siblings exist, the excluded',
  'directories are listed with their test-file counts; pass them as',
  'separate paths to include them.',
  '',
  'Multiple path arguments shard into sequential isolated harness',
  'runs (one browser instance per argument) by default, which does',
  'not exercise cross-argument state; --no-shard restores the',
  'combined single-instance invocation.',
  '',
  'Machine-readable verdict: every run (single, sharded, --canary,',
  '--doctor) ends with exactly one raw stdout line',
  '  FIREFORGE-VERDICT: PASS|FAIL [reason=crash|test-failures|',
  '  no-tests|preflight|inconclusive|lock-timeout] [checks=<n>]',
  '  [unexpected=<n>] [shards=<p>/<t>] [(<note>)]',
  'The status follows the harness classifier, not the raw exit code:',
  'a crash-classified run says FAIL reason=crash even at exit 0, and',
  'a green-summary-override pass says PASS despite a non-zero mach',
  'exit. reason=preflight covers any failure before the harness ran',
  '(missing/stale build, invalid paths, port conflicts, config',
  'errors); reason=inconclusive means engine/ changed while the',
  'tests ran, so the harness result cannot be trusted;',
  'reason=lock-timeout means the run never started because another',
  'engine-mutating command held the lock past the wait budget. A sharded',
  'aggregate reason is the most structural failing shard (crash,',
  'then no-tests, then test-failures). Count keys are omitted when',
  'the embedded summary did not print them. A trailing parenthetical',
  'is an advisory note, never part of the status: "(harness teardown',
  'noise ignored)" marks a clean suite whose only residue was the',
  'recognized upstream mozsystemmonitor teardown traceback, and',
  '"(headed run stalled with the display asleep)" marks a no-output',
  'stall whose display was measured asleep. Key on this line',
  'instead of mach internals.',
].join('\n');

/** Registers the test command on the CLI program. */
export function registerTest(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const test = program
    .command('test [paths...]')
    .description('Run tests via mach test')
    .option('--headless', 'Run tests in headless mode')
    .option('--build', 'Run incremental UI build before testing')
    .option(
      '--build-only',
      'Run the scoped pre-test build (packaging exactly [paths...], mixed harnesses allowed) and exit without dispatching tests — one build covers both harness halves, then run each half without --build'
    )
    .option(
      '--extend-coverage',
      'With --build/--build-only and explicit paths, union those paths into the recorded test-packaging coverage instead of replacing it, so an earlier scoped build stays covered. Refused when the build anchor moved (engine HEAD, mozconfig, or a previously fingerprinted packageable file changed).'
    )
    .option(
      '--refuse-unexported-drift',
      'With --build/--build-only, refuse (instead of warning) when the pre-test build would overwrite engine content recorded in neither a patch body nor the pristine baseline — the same belt as "fireforge build --refuse-unexported-drift", armable from the scripted "test --build" shape the hazard actually shows up in'
    )
    .option('--auto', 'Forward mach test --auto. Valid only when no explicit paths are provided.')
    .option(
      '--allow-stale-build',
      'Allow tests to run even when packageable engine files changed since the last successful FireForge build'
    )
    .option(
      '--allow-stale-components',
      'Run tests despite components.conf changes that only a full "fireforge build" compiles in (the packaged child process will resolve the OLD StaticComponents table)'
    )
    .option(
      '--kill-stale-marionette',
      'Terminate a recognized stale browser from this objdir or one holding the Marionette port before running tests'
    )
    .option(
      '--canary [path]',
      'Run one short browser-chrome harness canary. Uses test.canaryPath from fireforge.json when no path is supplied.'
    )
    .option(
      '--doctor',
      'Run a marionette handshake preflight before tests (exit 1 on FAIL). With no paths, runs the preflight only.'
    )
    .option(
      '--mach-arg <arg>',
      'Forward this argument verbatim to `mach test` (repeatable). Escape valve for upstream xpcshell/mochitest flags FireForge does not model.',
      ...stringListOption()
    )
    .option(
      '--harness-retries <n>',
      `Retry budget for recognized harness crashes (resource-monitor tracebacks, pre-test hangs, post-green shutdown re-entry). 0 disables retries. Default: ${String(DEFAULT_HARNESS_RETRIES)}.`,
      commanderArgParser((raw: string) => {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 0 || n > 10) {
          throw new GeneralError(`--harness-retries must be an integer in 0..10 (got "${raw}")`);
        }
        return n;
      })
    )
    .option(
      '--generic-mach-test',
      'Force dispatch through generic `mach test` instead of the suite-specific `mach xpcshell-test` / `mach mochitest` a single-suite run auto-selects (the suite-specific commands skip the mozlog resource monitor that crashes `mach test` on some hosts).'
    )
    .option(
      '--no-shard',
      'Run multiple test paths in one combined mach invocation instead of sequential per-file shards (isolated instances do not exercise cross-file state, so use this to reproduce cross-file pollution bugs)'
    )
    .option(
      '--perf-samples <path>',
      'Publish a perf-sample artifact path to the harness via <BINARYNAME>_PERF_SAMPLE_JSON (resolved against the project root)'
    )
    .option(
      '--marionette-port <port>',
      'Override the Marionette control port (default 2828) for the stale-browser probe, the --doctor preflight, and (unless --mach-arg includes --flavor=xpcshell) auto-forwarded mach args: --setpref=marionette.port=<n> (browser listener) and --marionette=127.0.0.1:<n> (mochitest client). Omits the client flag when --mach-arg already sets --marionette. Use when 2828 is busy or CI assigns another port.',
      commanderArgParser((raw: string) => {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1 || n > 65535) {
          throw new GeneralError(`--marionette-port must be an integer in 1..65535 (got "${raw}")`);
        }
        return n;
      })
    )
    .addHelpText('after', TEST_HELP_TEXT);
  addWaitLockOption(test).action(
    withErrorHandling(
      async (
        paths: string[],
        options: {
          headless?: boolean;
          build?: boolean;
          buildOnly?: boolean;
          extendCoverage?: boolean;
          refuseUnexportedDrift?: boolean;
          auto?: boolean;
          allowStaleBuild?: boolean;
          allowStaleComponents?: boolean;
          killStaleMarionette?: boolean;
          canary?: string | boolean;
          doctor?: boolean;
          machArg?: string[];
          marionettePort?: number;
          harnessRetries?: number;
          genericMachTest?: boolean;
          shard?: boolean;
          perfSamples?: string;
          waitLock?: number | boolean;
        }
      ) => {
        const projectRoot = getProjectRoot();
        // The engine session lock is acquired outside testCommand's own
        // exactly-one-verdict guarantee, so a lock failure must emit here or
        // the run ends with no FIREFORGE-VERDICT line at all.
        resetVerdictEmission();
        try {
          await withEngineSessionLock(
            projectRoot,
            'test',
            () => testCommand(projectRoot, paths, pickDefined(options)),
            { waitLockSeconds: resolveWaitLockSeconds(options.waitLock) }
          );
        } catch (error: unknown) {
          if (!verdictEmitted()) {
            emitFailVerdict(error instanceof LockContentionError ? 'lock-timeout' : 'preflight');
          }
          throw error;
        }
      }
    )
  );
}
