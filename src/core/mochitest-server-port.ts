// SPDX-License-Identifier: EUPL-1.2
/**
 * Mochitest HTTP server port preflight.
 *
 * The mochitest harness serves its test manifest from an xpcshell-hosted
 * httpd (`server.js`) on `127.0.0.1:8888`. When a previous run is killed
 * between browser launch and teardown, that server can survive (sometimes
 * wedged at 100% CPU and unkillable by the harness's own SIGKILL) and it
 * keeps the port.
 *
 * The next run then does something much worse than failing: its fresh
 * browser connects to the zombie server, which cannot serve the new
 * manifest, so the run stalls between browser startup and `TEST_START` and
 * dies on the 370 s no-output timeout with `Ran 0 checks`. Nothing in that
 * signature names the port, so the failure survives fresh builds and reads
 * as a defect in the change under test. One downstream report spent a
 * multi-hour bisect on it before `lsof -nP -iTCP:8888` gave the answer in
 * one line.
 *
 * `--kill-stale-marionette` never covered this: it clears the browser and
 * the Marionette control port, and the httpd is neither. This preflight is
 * the missing half, and it reuses {@link probeMarionettePort}, which is
 * port-generic, rather than growing a second probe.
 */
import { GeneralError } from '../errors/base.js';
import { exec } from '../utils/process.js';
import { type MarionettePortHolder, probeMarionettePort } from './marionette-port.js';

/** Default port the mochitest harness binds its httpd to. */
export const DEFAULT_MOCHITEST_SERVER_PORT = 8888;

/**
 * True when the holder is recognizably the mochitest harness's own
 * `server.js`, launched from an objdir.
 *
 * Both halves are required. `server.js` alone is one of the most common
 * filenames there is, and a developer's unrelated Node service must never
 * be mistaken for harness debris and offered up for termination. So the
 * command line must also show the xpcshell/objdir provenance that only the
 * harness's httpd has.
 */
export function isMochitestServerHolder(holder: MarionettePortHolder): boolean {
  const line = holder.commandLine;
  if (!/\bserver\.js\b/.test(line)) return false;
  return /\bxpcshell\b/.test(line) || /\/obj-[^/\s]*\//.test(line) || /\b_tests\b/.test(line);
}

/**
 * Refuses a mochitest dispatch when the harness's server port is held. It
 * terminates the holder first only for a recognized stale harness httpd,
 * and only when the operator opted in.
 *
 * An unrecognized listener is a refusal too, never a kill. Refusing is the
 * kinder outcome: mochitest cannot bind the port either way, so the choice
 * is between a one-line refusal now and a 370 s stall whose signature says
 * nothing about ports. But FireForge has no business killing a process it
 * cannot attribute to the harness.
 *
 * Best effort: {@link probeMarionettePort} reports an
 * unprobeable port as free, so a host without `lsof` runs exactly as before.
 *
 * @param port - Port to probe (default {@link DEFAULT_MOCHITEST_SERVER_PORT})
 * @param options - `killStaleServer` opts into terminating a recognized holder
 */
export async function ensureMochitestServerPortAvailable(
  port: number = DEFAULT_MOCHITEST_SERVER_PORT,
  options: { killStaleServer?: boolean } = {}
): Promise<void> {
  const probe = await probeMarionettePort(port);
  if (!probe.inUse || !probe.holder) return;
  const holder = probe.holder;
  const recognized = isMochitestServerHolder(holder);

  if (recognized && options.killStaleServer === true) {
    try {
      if (process.platform === 'win32') {
        await exec('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Stop-Process -Id ${holder.pid} -Force`,
        ]);
      } else {
        process.kill(holder.pid, 'SIGTERM');
      }
      return;
    } catch {
      // Fall through to the refusal: a wedged httpd is exactly the case
      // that ignores SIGTERM, and reporting it is more useful than
      // pretending the port is now free.
    }
  }

  throw new GeneralError(describeMochitestServerRefusal(port, holder, recognized));
}

/**
 * Builds the operator-facing refusal. Exported for direct unit testing.
 *
 * @param port - The probed port
 * @param holder - The listener found on it
 * @param recognized - Whether it is the harness's own `server.js`
 */
export function describeMochitestServerRefusal(
  port: number,
  holder: MarionettePortHolder,
  recognized: boolean
): string {
  const killHint =
    process.platform === 'win32'
      ? `Stop-Process -Id ${holder.pid} -Force`
      : `kill -9 ${holder.pid}`;
  const evidence =
    `The mochitest server port ${port} is already held by ${holder.command} ` +
    `(PID ${holder.pid}).\n` +
    `  command: ${holder.commandLine}\n` +
    "  A browser launched now would connect to THAT server, which cannot serve this run's " +
    'manifest — the run would stall before TEST_START and die on the no-output timeout with ' +
    '"Ran 0 checks".\n';

  if (recognized) {
    return (
      evidence +
      "  This is the mochitest harness's own server.js, so it is debris from an interrupted run. " +
      'Retry with "--kill-stale-marionette" to have FireForge stop it, or stop it yourself with ' +
      `"${killHint}" (a wedged httpd can ignore SIGTERM).`
    );
  }
  return (
    evidence +
    "  This is NOT the mochitest harness's server.js, so FireForge will not offer to kill it. " +
    `Stop the holder yourself with "${killHint}" if it is yours, or free the port, then retry. ` +
    `Diagnose with "lsof -nP -iTCP:${port}".`
  );
}
