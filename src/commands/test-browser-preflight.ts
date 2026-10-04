// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { reportOrphanedHarnessProcesses } from '../core/harness-orphans.js';
import {
  assertMarionettePortAvailable,
  ensureLaunchableBrowserNotRunning,
  ensureMarionettePortAvailable,
  extractForwardedMarionettePort,
  forwardedMachArgsIncludeMarionetteClient,
  shouldAutoForwardMarionettePortToMach,
} from '../core/marionette-port.js';
import {
  formatMarionettePreflightLine,
  reportMarionettePreflight,
  runMarionettePreflight,
} from '../core/marionette-preflight.js';
import { ensureMochitestServerPortAvailable } from '../core/mochitest-server-port.js';
import { waitForPreflight } from '../core/preflight-wait.js';
import { GeneralError } from '../errors/base.js';
import type { TestOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { info, outro, verbose } from '../utils/logger.js';
import { resolveWaitLockSeconds } from '../utils/options.js';
import { addVerdictRunCount, emitFailVerdict, emitPassVerdict } from './test-verdict.js';

/**
 * Runs the `--doctor` marionette handshake probe. With no test paths the
 * probe is the entire command (returns `'stop'` after reporting). With
 * paths it gates the mach invocation, where a FAIL throws before mach runs.
 */
export async function runDoctorPreflight(args: {
  engineDir: string;
  effectivePort: number | undefined;
  hasTestPaths: boolean;
  objDir: string | undefined;
  binaryName: string;
  launchablePath: string | undefined;
}): Promise<'stop' | 'continue'> {
  const { engineDir, effectivePort, hasTestPaths, objDir, binaryName, launchablePath } = args;
  // Non-TTY captures need the banner even if clack's renderer defers output
  // in pipe mode. TTY users need the clack framing. Gated rather than
  // written twice: the unconditional pair printed the same line twice on a
  // terminal.
  if (process.stdout.isTTY) {
    info('Running marionette preflight...');
  } else {
    process.stdout.write('Running marionette preflight...\n');
  }
  const preflight =
    effectivePort !== undefined
      ? await runMarionettePreflight(engineDir, { port: effectivePort })
      : await runMarionettePreflight(engineDir);
  // The authoritative PASS/FAIL line is written with `process.stdout.write`
  // as the first output after the probe returns, because clack's renderer
  // can drop the summary under non-TTY capture.
  //
  // Gated on non-TTY: unconditional, it stacks with the two clack renderings
  // below and the same line appears three times on a terminal. Captured
  // streams are exactly where this branch still fires.
  const directLine = formatMarionettePreflightLine(preflight);
  if (!process.stdout.isTTY) {
    process.stdout.write(`${directLine}\n`);
  }
  process.stdout.write(
    `Marionette preflight environment: objdir=${objDir ?? '(none)'}; binary=${binaryName}; app=${launchablePath ? `engine/${launchablePath}` : '(unknown)'}; port=${effectivePort ?? 2828}; elapsed=${preflight.durationMs}ms\n`
  );
  reportMarionettePreflight(preflight);
  if (!hasTestPaths) {
    if (!preflight.ok) {
      emitFailVerdict('preflight');
      throw new GeneralError('Marionette preflight reported FAIL — see output above.');
    }
    // Doctor-only runs end here, so they carry their own verdict line
    // (reason=preflight on failure). With test paths the verdict comes
    // from the actual harness run downstream.
    emitPassVerdict();
    outro('Test completed');
    return 'stop';
  }
  if (!preflight.ok) {
    emitFailVerdict('preflight');
    throw new GeneralError(
      'Marionette preflight reported FAIL — see output above. Aborting before mach test runs.'
    );
  }
  return 'continue';
}

/**
 * Auto-forwards `--marionette-port` to mach (`--setpref=marionette.port`
 * for the listener, `--marionette=127.0.0.1:<n>` for the mochitest
 * client), skipping each piece the operator already forwarded via
 * `--mach-arg` and the xpcshell flavor that ignores the pref entirely.
 * Mutates `extraArgs` in place.
 */
export function appendMarionetteForwardingArgs(
  extraArgs: string[],
  options: TestOptions,
  forwardedPort: number | undefined,
  xpcshellOnly = false
): void {
  // Auto-forward the Marionette port to mach when `--marionette-port` is set.
  // `--setpref=marionette.port=<n>` configures where the browser listener
  // binds. `--marionette=127.0.0.1:<n>` tells the mochitest harness client to
  // connect there (default client is 127.0.0.1:2828). xpcshell ignores both
  // for browser Marionette.
  //
  // Skip setpref forwarding when the operator already supplied an equivalent
  // arg via `--mach-arg`: duplicates would confuse without changing
  // semantics. Skip when mach args explicitly request `--flavor=xpcshell` (or
  // `xpcshell-tests`): the preflight still honours `--marionette-port`, but
  // mach does not use the marionette.port pref on that harness. Any other arg
  // shape still forwards so toolkit widget paths and mixed suites stay
  // aligned with the probe without duplicate `--mach-arg` flags.
  //
  // Skip auto `--marionette=...` when `--mach-arg` already includes a client
  // `--marionette=...` (or two-token `--marionette host:port`).
  if (options.marionettePort === undefined) return;
  if (xpcshellOnly) {
    // Manifest classification says every requested path is xpcshell.
    // xpcshell ignores the browser Marionette path entirely, and forwarding
    // the mochitest client flags here makes mach reject the dispatch.
    info(
      `--marionette-port=${options.marionettePort} applied to the preflight probe only: the requested paths are xpcshell-only, and xpcshell ignores the browser Marionette port. Not forwarding --setpref=marionette.port or --marionette to mach.`
    );
    return;
  }
  {
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
}

async function ensureTestMarionettePortAvailable(
  port: number | undefined,
  binaryName: string,
  options: TestOptions,
  skip: { xpcshellOnly: boolean; doctor: boolean }
): Promise<void> {
  // Refuse a stale listener before mach surfaces a generic bind failure.
  // This also recognizes a fork-branded browser via binaryName.
  if (skip.xpcshellOnly && !skip.doctor) {
    // xpcshell does not bind the browser Marionette port, so a developer's
    // interactive browser holding 2828 must not kill an xpcshell run.
    // --doctor keeps the preflight: its probe launches a
    // Marionette browser regardless of the requested harness.
    const message =
      'Skipping the Marionette stale-port preflight: all requested paths are xpcshell ' +
      '(xpcshell does not bind the browser Marionette port).';
    if (options.marionettePort !== undefined || options.killStaleMarionette === true) {
      info(message);
    } else {
      verbose(message);
    }
    return;
  }
  if (options.killStaleMarionette === true) {
    await ensureMarionettePortAvailable(port, { binaryName, killStaleBrowser: true });
    return;
  }
  await assertMarionettePortAvailable(port, { binaryName });
}

/** Prepares profile overlays and browser/port ownership preconditions. */
export async function ensureTestBrowserEnvironment(
  engineDir: string,
  launchablePath: string | undefined,
  xpcshellOnly: boolean,
  projectConfig: FireForgeConfig,
  options: TestOptions,
  objDir: string | undefined
): Promise<{ forwardedPort: number | undefined; effectivePort: number | undefined }> {
  // A timed-out mochitest can leave the built app alive after its Marionette
  // listener has disappeared. The port probe cannot see that case, but the
  // survivor can still steal focus and wedge every later headed run.
  if (!xpcshellOnly && launchablePath) {
    await waitForPreflight(
      () =>
        ensureLaunchableBrowserNotRunning(join(engineDir, launchablePath), {
          killStaleBrowser: options.killStaleMarionette === true,
        }),
      options.waitBrowser === undefined ? undefined : resolveWaitLockSeconds(options.waitBrowser)
    );
  }
  // Packaging-only runs must protect a running objdir, but do not bind any
  // harness ports or launch tests, so peer listeners cannot block packaging.
  if (options.buildOnly) return { forwardedPort: undefined, effectivePort: undefined };
  // A zombie mochitest httpd squatting the server port makes a fresh
  // browser connect to a server that cannot serve this run's manifest,
  // which surfaces as a 370s "Ran 0 checks" stall naming nothing. xpcshell
  // does not use the httpd, so an xpcshell-only run is never blocked by it.
  if (!xpcshellOnly) {
    await waitForPreflight(
      () =>
        ensureMochitestServerPortAvailable(undefined, {
          engineDir,
          killStaleServer: options.killStaleMarionette === true,
        }),
      options.waitPort === undefined ? undefined : resolveWaitLockSeconds(options.waitPort)
    );
  }
  // Helpers that outlived an earlier run (httpd, pywebsocket, ssltunnel,
  // moz-http2) slow every later run without appearing in its output. Both
  // harnesses are affected, so this census is not gated on xpcshellOnly.
  // Reaping is opt-in per invocation (--reap-orphans) or per repo
  // (test.reapOrphans: "reap"); a reap is stamped on the verdict line so a
  // green after one is not mistaken for a green on a quiet machine.
  const census = await reportOrphanedHarnessProcesses(objDir, {
    reap: options.reapOrphans === true || projectConfig.test?.reapOrphans === 'reap',
  });
  addVerdictRunCount('orphans-reaped', census.reaped);
  const forwardedPort = options.machArg
    ? extractForwardedMarionettePort(options.machArg)
    : undefined;
  const effectivePort = options.marionettePort ?? forwardedPort;
  await waitForPreflight(
    () =>
      ensureTestMarionettePortAvailable(effectivePort, projectConfig.binaryName, options, {
        xpcshellOnly,
        doctor: options.doctor === true,
      }),
    options.waitPort === undefined ? undefined : resolveWaitLockSeconds(options.waitPort)
  );
  return { forwardedPort, effectivePort };
}
