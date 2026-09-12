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
import { isExplicitAbsolutePath, isPathInsideRoot } from '../utils/paths.js';
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
 * How a recognized harness httpd relates to the checkout about to run.
 *
 * `this-checkout` is debris from one of OUR interrupted runs and may be
 * offered for termination. `foreign-checkout` is the same harness serving a
 * LIVE run in a sibling worktree: `server.js` plus objdir provenance is
 * exactly what a peer's in-flight suite looks like, and the only thing
 * separating the two is whose objdir the command line points into.
 * `unrecognized` is not the harness at all.
 */
export type MochitestServerHolderClass = 'this-checkout' | 'foreign-checkout' | 'unrecognized';

/**
 * Classifies the holder against this project's engine directory. Every
 * absolute path on the command line is tested with {@link isPathInsideRoot}
 * (a token test, not a substring test, so `/a/hominis/engine` does not claim
 * a holder living under `/a/hominis-2/engine`). On POSIX the command line is
 * the full `ps -o args=` output, so the objdir path is always present for a
 * harness httpd; a holder whose paths all lie elsewhere belongs to another
 * checkout.
 *
 * @param holder - The listener found on the port
 * @param engineDir - Absolute engine directory of THIS project
 */
export function classifyMochitestServerHolder(
  holder: MarionettePortHolder,
  engineDir: string
): MochitestServerHolderClass {
  if (!isMochitestServerHolder(holder)) return 'unrecognized';
  const absoluteTokens = holder.commandLine.split(/\s+/).filter(isExplicitAbsolutePath);
  return absoluteTokens.some((token) => isPathInsideRoot(engineDir, token))
    ? 'this-checkout'
    : 'foreign-checkout';
}

/**
 * The objdir a foreign holder is serving from, for the refusal text: the
 * first absolute command-line token with an `obj-…` segment, cut at that
 * segment. Falls back to the first absolute token, then to a placeholder.
 */
export function describeHolderObjdir(commandLine: string): string {
  const tokens = commandLine.split(/\s+/).filter(isExplicitAbsolutePath);
  for (const token of tokens) {
    const match = /^(.*?[/\\]obj-[^/\\]*)(?:[/\\]|$)/.exec(token);
    if (match?.[1]) return match[1];
  }
  return tokens[0] ?? '(no path visible on the command line)';
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
 * A recognized httpd from ANOTHER checkout is a refusal and never a kill
 * either, flag or no flag: it is a peer's live suite, not our debris. The
 * browser-side probe draws the same line for a bare launch it cannot
 * attribute; this one can attribute, because the objdir is on the command
 * line, so it names the other checkout instead of offering `kill -9`.
 *
 * @param port - Port to probe (default {@link DEFAULT_MOCHITEST_SERVER_PORT})
 * @param options - `engineDir` is this project's absolute engine directory,
 *   the ownership boundary; `killStaleServer` opts into terminating a holder
 *   recognized as THIS checkout's debris
 */
export async function ensureMochitestServerPortAvailable(
  port: number = DEFAULT_MOCHITEST_SERVER_PORT,
  options: { engineDir: string; killStaleServer?: boolean }
): Promise<void> {
  const probe = await probeMarionettePort(port);
  if (!probe.inUse || !probe.holder) return;
  const holder = probe.holder;
  const holderClass = classifyMochitestServerHolder(holder, options.engineDir);

  if (holderClass === 'this-checkout' && options.killStaleServer === true) {
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

  throw new GeneralError(describeMochitestServerRefusal(port, holder, holderClass));
}

/**
 * Builds the operator-facing refusal. Exported for direct unit testing.
 *
 * @param port - The probed port
 * @param holder - The listener found on it
 * @param holderClass - Whose harness `server.js` it is, if it is one at all
 */
export function describeMochitestServerRefusal(
  port: number,
  holder: MarionettePortHolder,
  holderClass: MochitestServerHolderClass
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

  if (holderClass === 'this-checkout') {
    return (
      evidence +
      "  This is the mochitest harness's own server.js from THIS checkout's objdir, so it is " +
      'debris from an interrupted run. Retry with "--kill-stale-marionette" to have FireForge ' +
      `stop it, or stop it yourself with "${killHint}" (a wedged httpd can ignore SIGTERM).`
    );
  }
  if (holderClass === 'foreign-checkout') {
    // No kill hint on this branch, on purpose: the PID is a peer's live
    // suite, and "kill -9 <pid>" is exactly the instruction that would have
    // destroyed it.
    return (
      evidence +
      `  This is a mochitest httpd from ANOTHER checkout: ${describeHolderObjdir(holder.commandLine)}. ` +
      'It is serving a live run there, so FireForge will not stop it and "--kill-stale-marionette" ' +
      'will not either. Wait for that run to finish or free the port yourself, then retry. ' +
      `Diagnose with "lsof -nP -iTCP:${port}".`
    );
  }
  return (
    evidence +
    "  This is NOT the mochitest harness's server.js, so FireForge will not offer to kill it. " +
    `Stop the holder yourself with "${killHint}" if it is yours, or free the port, then retry. ` +
    `Diagnose with "lsof -nP -iTCP:${port}".`
  );
}
