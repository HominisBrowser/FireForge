// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { withEngineSessionLock } from '../core/engine-session-lock.js';
import { GeneralError, LockContentionError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { TestOptions } from '../types/commands/index.js';
import {
  addWaitLockOption,
  commanderArgParser,
  pickDefined,
  resolveWaitLockSeconds,
  stringListOption,
} from '../utils/options.js';
import { parsePositiveIntegerFlag } from '../utils/validation.js';
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
  'Mixed xpcshell and browser/mochitest paths run as two consecutive',
  'mach invocations (xpcshell first) under one lock hold and one',
  'verdict; with --build, one pre-test build packages both halves.',
  '--repeat <n> and --negative-control <diff> run under one lock hold',
  'too. Each sub-run prints a FIREFORGE-RUN: line (its own verdict',
  'plus run=<i>/<n>) before the single aggregate verdict.',
  '',
  'A dev objdir symlinks chrome JS/CSS and widget files into engine/,',
  'so the browser reads engine/ sources when it loads them, after the',
  'build step: an edit made while a suite runs reaches that suite, and',
  'a hand-made neuter must stay until the verdict line, not until',
  '"Build complete", since one restored early is gone for later',
  'shards. --negative-control applies its diff after the build and',
  'restores it byte-exact only after the run, before the lock is',
  'released.',
  '',
  'Machine-readable verdict: every run (single, sharded, --canary,',
  '--doctor) ends with exactly one raw stdout line',
  '  FIREFORGE-VERDICT: PASS|FAIL [reason=crash|harness-arguments|test-failures|',
  '  no-tests|preflight|inconclusive|lock-timeout|killed] [checks=<n>]',
  '  [unexpected=<n>] [started=<n>/<m> first-unstarted=<path>]',
  '  [shards=<p>/<t>] [(<note>)] [shuffle=<seed>]',
  '  [runs=<p>/<n>] [control=caught|missed|inconclusive]',
  '  [furnace-applied=<names>|furnace-apply=skipped] [log=<path>]',
  "control= is a negative control's outcome: caught (went red on test",
  'failures, as a control should; exit 0), missed (stayed green; exit',
  '5) or inconclusive.',
  'shuffle=<seed> is the seed a --shuffle run exported to the harness.',
  "log=<path> names this run's complete output, written to",
  '.fireforge/logs/ as the run streams, so a piped or truncated run',
  'still leaves a re-readable artifact.',
  'The status follows the harness classifier, not the raw exit code:',
  'a crash-classified run says FAIL reason=crash even at exit 0, and',
  'a green-summary-override pass says PASS despite a non-zero mach',
  'exit. An exit-0 run is still FAIL reason=test-failures when its',
  'summary reports unexpected results, the browser shut down mid-test,',
  'or a requested file never started; started=/first-unstarted= then',
  'name how far it got and where a re-run has to pick up.',
  'reason=preflight covers any failure before the harness ran',
  '(missing/stale build, invalid paths, port conflicts, config',
  'errors); reason=inconclusive means engine/ or perf power source',
  'changed while tests ran, so the result cannot be trusted;',
  'reason=lock-timeout means the run never started because another',
  'engine-mutating command held the lock past the wait budget;',
  'reason=killed means a signal terminated the run before it reached',
  'any other outcome (written from the signal handler). A sharded',
  'aggregate reason is the most structural failing shard (crash,',
  'then no-tests, then test-failures). Count keys are omitted when',
  'the embedded summary did not print them. A trailing parenthetical',
  'is an advisory note, never part of the status: "(harness teardown',
  'noise ignored)" marks a clean suite whose only residue was the',
  'recognized upstream mozsystemmonitor teardown traceback, and',
  '"(headed run stalled with the display asleep)" marks a no-output',
  'stall whose display was measured asleep. Key on this line',
  'instead of mach internals.',
  '',
  'Lock-free checks run before the engine lock is requested: a missing',
  'launchable binary (with the build that left it missing, when one is',
  'recorded), the named-file checkJs pass of --build, and the',
  '--wait-browser/--wait-port budgets. Each is re-checked once under the',
  'lock.',
].join('\n');

function registerTestMultiRunOptions(test: Command): Command {
  return test
    .option(
      '--repeat <n>',
      'Run the same paths n times under one engine-lock hold (a --build builds once); prints each run and aggregates runs=<passed>/<n> on the verdict',
      commanderArgParser((raw: string) => parsePositiveIntegerFlag('--repeat', raw))
    )
    .option(
      '--negative-control <diff>',
      'Apply this reviewed git diff (engine/ or components/ sources; project-relative path) after the pre-test build and right before dispatch, restore it byte-exact after the run (also on failure, SIGINT and SIGTERM) before the lock is released, and report control=caught|missed|inconclusive on the verdict'
    )
    .option(
      '--auto-ports',
      "Let a browser run proceed when the mochitest server or Marionette port is held by something that is not this checkout's own: the engine's harness falls back to a free port itself. Same as test.mochitestPorts: \"auto\". This checkout's own leftovers are still refused."
    );
}

function registerTestSharingOptions(test: Command): Command {
  return test
    .option(
      '--wait-browser [seconds]',
      'Wait for this objdir browser before any deployment/build (default 60)',
      commanderArgParser((raw: string) => resolveWaitLockSeconds(raw))
    )
    .option(
      '--wait-port [seconds]',
      'Wait for the mochitest and Marionette ports (default 60)',
      commanderArgParser((raw: string) => resolveWaitLockSeconds(raw))
    )
    .option(
      '--restart-between-tests',
      "Forward mochitest's --restart-between-tests: restart the browser between test files to expose undocumented cross-file dependencies (the shape a manifest's standalone key asks for). Mochitest dispatch only."
    )
    .option(
      '--keep-log <path>',
      "Also write this run's log to <path> (a directory receives it under its own name), outside .fireforge/logs/ retention. FIREFORGE_LOG_KEEP sets a session default."
    )
    .option(
      '--profile-file <source=destination>',
      'Merge a file into the harness profile, e.g. sheet.css=chrome/userChrome.css. Repeatable.',
      ...stringListOption()
    );
}

/** Pre-test build options that shape the coverage claim and the Furnace step. */
function registerTestBuildOptions(test: Command): Command {
  return test
    .option(
      '--extend-coverage',
      'With --build/--build-only and explicit paths, refuse instead of dropping any earlier packaging claim. Scoped builds keep each earlier path by default while its own staging inputs (manifest directory and the fixtures its manifest names) and engine/mozconfig are unchanged; this flag turns a drop into a refusal before the build.'
    )
    .option(
      '--no-furnace-apply',
      'With --build/--build-only, skip the Furnace apply so the build packages engine/ as it stands; names the components whose undeployed components/ edits it leaves out'
    );
}

/** Registers the test command on the CLI program. */
export function registerTest(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const test = program
    .command('test [paths...]')
    .description('Run tests via mach test')
    .option('--headless', 'Run tests in headless mode')
    .option(
      '--full-output',
      "Pass mozbuild's full verbosity through for the TEST phase. mozbuild quiets terminal output to warnings and errors when it detects a coding agent, which removes TEST_START and console INFO — the lines a hang or stall diagnosis needs. This unsets that detection for test dispatches only; the build phase stays quiet."
    )
    .option('--build', 'Run incremental UI build before testing')
    .option(
      '--build-only',
      'Run the scoped pre-test build (packaging exactly [paths...], mixed harnesses allowed) and exit without dispatching tests — one build covers both harness halves, then run each half without --build'
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
      "Terminate a recognized stale browser from this objdir, one holding the Marionette port, or this checkout's own leftover mochitest httpd before running tests. Never touches another checkout's live harness."
    )
    .option(
      '--reap-orphans',
      'Terminate harness helper processes (httpd, pywebsocket, ssltunnel, moz-http2) from this objdir that survived an earlier run. The census itself runs on every test dispatch and is report-only; this flag (or test.reapOrphans: "reap" in fireforge.json) opts into the kill. Reaps are stamped on the verdict line as orphans-reaped=<n>.'
    )
    .option(
      '--pgid-file <path>',
      'Write the harness process-group id (mach is the group leader) to this file on every spawn, so a supervisor that had to SIGKILL fireforge can still take the whole harness tree with "kill -- -$(cat <path>)". Removed when the run ends normally.'
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
      '--shuffle [seed]',
      'Shuffle isolated mochitest path arguments in a repeatable seeded order (fresh seed when omitted). Native mach --shuffle within each invocation remains unseeded. Export FIREFORGE_SHUFFLE_SEED for custom task code and stamp shuffle=<seed> on the verdict. --no-shard disables the seeded argument permutation. A path-shaped argument right after the flag (browser_x.js, dir/) is a test path, not a seed.',
      commanderArgParser((raw: string) => parsePositiveIntegerFlag('--shuffle', raw))
    )
    .option(
      '--harness-retries <n>',
      `Retry budget for recognized harness crashes (resource-monitor tracebacks, pre-test hangs, post-green shutdown re-entry). 0 disables retries. Default: ${DEFAULT_HARNESS_RETRIES}.`,
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
  addWaitLockOption(
    registerTestBuildOptions(registerTestMultiRunOptions(registerTestSharingOptions(test)))
  ).action(
    withErrorHandling(
      async (
        paths: string[],
        options: Pick<TestOptions, 'keepLog' | 'restartBetweenTests'> & {
          headless?: boolean;
          fullOutput?: boolean;
          build?: boolean;
          buildOnly?: boolean;
          extendCoverage?: boolean;
          refuseUnexportedDrift?: boolean;
          furnaceApply?: boolean;
          auto?: boolean;
          allowStaleBuild?: boolean;
          allowStaleComponents?: boolean;
          killStaleMarionette?: boolean;
          reapOrphans?: boolean;
          pgidFile?: string;
          canary?: string | boolean;
          doctor?: boolean;
          machArg?: string[];
          marionettePort?: number;
          harnessRetries?: number;
          genericMachTest?: boolean;
          shard?: boolean;
          perfSamples?: string;
          shuffle?: number | boolean;
          waitLock?: number | boolean;
          waitBrowser?: number | boolean;
          waitPort?: number | boolean;
          profileFile?: string[];
        } & Pick<TestOptions, 'repeat' | 'negativeControl' | 'autoPorts'>
      ) => {
        const projectRoot = getProjectRoot();
        // Fallback for a verdict testCommand did not emit (it takes the lock).
        resetVerdictEmission();
        try {
          await testCommand(projectRoot, paths, pickDefined(options), (body) =>
            withEngineSessionLock(projectRoot, 'test', body, {
              waitLockSeconds: resolveWaitLockSeconds(options.waitLock),
            })
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
