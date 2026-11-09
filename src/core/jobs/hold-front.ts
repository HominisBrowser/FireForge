// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { listProcesses } from '../../utils/process-list.js';

const runFile = promisify(execFile);

/** How often the browser is looked at, and raised if it has lost the front. */
const POLL_MS = 2_000;
/** A raise takes effect asynchronously, so its result is read this much later. */
const SETTLE_MS = 500;
/** A browser still starting has no window to raise, so one miss in a row proves nothing. */
const FAILURES_IN_A_ROW = 3;
const TOOL_TIMEOUT_MS = 5_000;

/**
 * Asks AppKit, by process ID, to activate one application. This is no Apple Event,
 * so it needs no Automation grant and cannot reach any other process.
 */
const RAISE_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  return !app.isNil() && app.activateWithOptions($.NSApplicationActivateAllWindows) ? "raised" : "refused";
}`;

/** What holding the front needs from the host, so a fixture can stand in for WindowServer. */
export interface FrontTools {
  /** The frontmost application's process ID, or undefined when the host will not say. */
  frontmost: () => Promise<number | undefined>;
  /** Asks for this process to come to the front. */
  raise: (pid: number) => Promise<boolean>;
  /** Every process's ID, parent and command line. */
  processes: () => Promise<ReadonlyArray<{ pid: number; ppid: number; args: string }>>;
}

/** The real host's tools: `lsappinfo`, AppKit and the process table. */
export const hostFrontTools: FrontTools = {
  frontmost: async () => {
    try {
      const { stdout: asn } = await runFile('/usr/bin/lsappinfo', ['front'], {
        encoding: 'utf8',
        timeout: TOOL_TIMEOUT_MS,
      });
      const { stdout } = await runFile('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn.trim()], {
        encoding: 'utf8',
        timeout: TOOL_TIMEOUT_MS,
      });
      const pid = /"?pid"?\s*=\s*(\d+)/.exec(stdout)?.[1];
      return pid === undefined ? undefined : Number(pid);
    } catch {
      return undefined;
    }
  },
  raise: async (pid) => {
    try {
      const { stdout } = await runFile(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', RAISE_SCRIPT, String(pid)],
        { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS }
      );
      return stdout.trim() === 'raised';
    } catch {
      return false;
    }
  },
  processes: () => listProcesses(['pid', 'ppid', 'args']),
};

/** How holding the browser in front went, which the step's verdict and evidence carry. */
export interface FrontReport {
  /** The browser this phase started, once one was seen. */
  browser?: number;
  raises: number;
  /** Raises that did not leave the browser frontmost. */
  failures: number;
  /** Why the hold failed, when it did. */
  failed?: string;
}

/**
 * The main executable of an application a slot built, as a process's command line
 * starts: its helper processes and anything naming the path in an argument do not match.
 */
export function isSlotBrowser(args: string, slotRoot: string): boolean {
  const engine = `${slotRoot}/engine/`;
  return (
    args.startsWith(engine) &&
    /^obj-[^/]+\/dist\/[^/]+\.app\/Contents\/MacOS\/[^/\s]+(?:\s|$)/.test(args.slice(engine.length))
  );
}

/** The browser this phase started: a descendant of this process, so nothing else can be raised. */
export function ownedBrowser(
  processes: ReadonlyArray<{ pid: number; ppid: number; args: string }>,
  root: number,
  slotRoot: string
): number | undefined {
  const owned = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of processes)
      if (owned.has(entry.ppid) && !owned.has(entry.pid)) {
        owned.add(entry.pid);
        grew = true;
      }
  }
  return processes.find(
    (entry) => entry.pid !== root && owned.has(entry.pid) && isSlotBrowser(entry.args, slotRoot)
  )?.pid;
}

export interface FrontHold {
  /** Stops watching and says how it went. */
  finish: () => Promise<FrontReport>;
}

/**
 * Keeps a phase's own browser frontmost while it runs. Whether the raise took is
 * read back rather than assumed, because the host may decline to activate an
 * application for a background process. Raises that keep not taking, or a browser
 * never seen, are a failed hold: the window was not known to be in front.
 */
export function holdFront(
  options: { root: number; slotRoot: string; pollMs?: number; settleMs?: number },
  tools: FrontTools = hostFrontTools
): FrontHold {
  const report: FrontReport = { raises: 0, failures: 0 };
  const state = { stopped: false };
  let inARow = 0;
  let wake: (() => void) | undefined;
  const pause = (ms: number): Promise<void> =>
    new Promise((settle) => {
      if (state.stopped) {
        settle();
        return;
      }
      const timer = setTimeout(settle, ms);
      wake = () => {
        clearTimeout(timer);
        settle();
      };
    });
  const tick = async (): Promise<void> => {
    const browser = ownedBrowser(await tools.processes(), options.root, options.slotRoot);
    if (browser === undefined) return;
    report.browser = browser;
    if ((await tools.frontmost()) === browser) {
      inARow = 0;
      return;
    }
    report.raises += 1;
    const asked = await tools.raise(browser);
    await pause(options.settleMs ?? SETTLE_MS);
    if (state.stopped) return;
    if (asked && (await tools.frontmost()) === browser) {
      inARow = 0;
      return;
    }
    report.failures += 1;
    inARow += 1;
    if (inARow >= FAILURES_IN_A_ROW)
      report.failed ??= `The browser (pid ${String(browser)}) could not be brought to the front ${String(inARow)} times in a row, so what ran behind it does not count`;
  };
  const watching = (async () => {
    while (!state.stopped) {
      await tick().catch((error: unknown) => {
        report.failed ??= `Holding the front failed: ${String(error)}`;
      });
      await pause(options.pollMs ?? POLL_MS);
    }
  })();
  return {
    finish: async () => {
      state.stopped = true;
      wake?.();
      await watching;
      if (report.browser === undefined) report.failed ??= 'No browser of this phase was ever seen';
      return report;
    },
  };
}
