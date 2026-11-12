// SPDX-License-Identifier: EUPL-1.2
/**
 * The host around a test run: what a killed earlier run of this workspace
 * left behind, the ports a browser harness binds, and the helpers this run
 * started that escaped its process group.
 *
 * Authority comes from the workspace lease: while a command holds it, no
 * other FireForge run uses this engine, so a harness process of this engine
 * whose parent has died, or that carries this engine's run marker, is a
 * leftover and is terminated by exact identity (pid and birth). Anything
 * else (another workspace's live suite, an unrelated listener) is never
 * signalled: it is waited for under `--wait-lock`, or the run is refused
 * naming it.
 *
 * Every harness process inherits two environment markers: the run's id, and
 * the engine it runs in. A helper that detaches into a session of its own
 * (xpcshell's `moz-http2.js` server) leaves the process group but keeps its
 * environment, which is how teardown still finds it.
 */
import { createServer } from 'node:net';

import { PROGRESS_EVERY_MS, PROGRESS_FIRST_MS } from '../kernel/lock.js';
import { info, verbose, warn } from '../kernel/log.js';
import {
  commandNamesRoot,
  listProcesses,
  type ProcessIdentity,
  run,
  snapshotProcesses,
  terminateByIdentity,
} from '../kernel/process/index.js';
import { formatDuration, sleep } from '../kernel/time.js';
import { refusal } from './plan.js';

/** Environment variable naming the run a harness process belongs to. */
export const RUN_MARKER = 'FIREFORGE_TEST_RUN';
/** Environment variable naming the engine a harness process runs in. */
export const ENGINE_MARKER = 'FIREFORGE_TEST_ENGINE';

const GRACE_MS = 1_500;

/** The workspace directories that identify its processes. */
export interface HostWorkspace {
  engineDir: string;
  objDir: string;
}

/** A process as a decision about it saw it. */
export interface HostProcess extends ProcessIdentity {
  parent: number;
  command: string;
}

const HELPER_BINARY = /^(?:xpcshell|ssltunnel|http3server|moz-http2)(?:\.exe)?$/;
const HELPER_INTERPRETER = /^(?:python[\d.]*|Python|node)(?:\.exe)?$/;
const HELPER_SCRIPT =
  /(?:^|[/\\])(?:pywebsocket\w*\.py|websocket_server\.py|websocketprocessbridge\.py|moz-http2\.js|http2_server\.js|httpd\.js|server\.js|runtests\.py|runxpcshelltests\.py)$/;

const basename = (token: string): string =>
  token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);

/**
 * Whether a command line is a harness process: a helper binary, an
 * interpreter running a helper script, or a browser started for a harness.
 *
 * @param command - A process command line
 */
export function isHarnessCommand(command: string): boolean {
  const [exe, first] = command.trim().split(/\s+/);
  if (exe === undefined) return false;
  if (HELPER_BINARY.test(basename(exe))) return true;
  if (first !== undefined && HELPER_INTERPRETER.test(basename(exe)) && HELPER_SCRIPT.test(first)) {
    return true;
  }
  return (
    /\s-marionette(?:\s|$)/.test(command) ||
    /\s-profile(?:\s|=)\S*(?:mochitest|rust_mozprofile|fireforge-)/.test(command)
  );
}

/** Whether a listing row carries `NAME=value` in its environment. */
export function carriesMarker(listing: string, name: string, value: string): boolean {
  const needle = ` ${name}=${value}`;
  for (let at = listing.indexOf(needle); at !== -1; at = listing.indexOf(needle, at + 1)) {
    const after = listing[at + needle.length];
    if (after === undefined || /\s/.test(after)) return true;
  }
  return false;
}

const namesWorkspace = (command: string, workspace: HostWorkspace): boolean =>
  commandNamesRoot(command, workspace.engineDir) || commandNamesRoot(command, workspace.objDir);

/** This process and its ancestors, which are never leftovers. */
function ancestors(parents: ReadonlyMap<number, number>): Set<number> {
  const chain = new Set<number>();
  for (
    let pid: number | undefined = process.pid;
    pid !== undefined && pid > 1 && !chain.has(pid);
  ) {
    chain.add(pid);
    pid = parents.get(pid);
  }
  return chain;
}

/**
 * The live processes a predicate selects, with exact identities, from one
 * snapshot and two listings: command lines alone, and with the environment.
 */
async function selectProcesses(
  select: (entry: { parent: number; command: string; environment: string }) => boolean
): Promise<HostProcess[] | undefined> {
  if (process.platform === 'win32') return [];
  const snapshot = await snapshotProcesses();
  if (snapshot === undefined) return undefined;
  const commands = new Map(
    (await listProcesses(['pid', 'command'])).map((row) => [row.pid, row.command])
  );
  const environments = new Map(
    (await listProcesses(['pid', 'command'], { environment: true })).map((row) => [
      row.pid,
      row.command,
    ])
  );
  const excluded = ancestors(new Map([...snapshot].map(([pid, entry]) => [pid, entry.parent])));
  const selected: HostProcess[] = [];
  for (const [pid, entry] of snapshot) {
    const command = commands.get(pid);
    if (command === undefined || excluded.has(pid)) continue;
    if (select({ parent: entry.parent, command, environment: environments.get(pid) ?? '' })) {
      selected.push({ pid, start: entry.start, parent: entry.parent, command });
    }
  }
  return selected;
}

/**
 * Whether a process is a leftover of an earlier run of this workspace: it
 * carries this engine's marker, or it is a harness process naming this
 * workspace whose parent has died.
 */
function isLeftover(
  entry: { parent: number; command: string; environment: string },
  workspace: HostWorkspace
): boolean {
  if (carriesMarker(entry.environment, ENGINE_MARKER, workspace.engineDir)) return true;
  return (
    entry.parent === 1 &&
    isHarnessCommand(entry.command) &&
    namesWorkspace(entry.command, workspace)
  );
}

/**
 * Terminates what killed earlier runs of this workspace left running. Call
 * it only while holding the workspace.
 *
 * @param workspace - The engine and object directory
 * @returns How many processes were terminated
 */
export async function reapLeftovers(workspace: HostWorkspace): Promise<number> {
  const leftovers = await selectProcesses((entry) => isLeftover(entry, workspace));
  if (leftovers === undefined) {
    verbose('The process table could not be read; leftovers of earlier runs were not looked for.');
    return 0;
  }
  if (leftovers.length === 0) return 0;
  const rows = leftovers.map((entry) => `PID ${entry.pid}: ${entry.command.slice(0, 120)}`);
  info(
    `Terminating ${leftovers.length} process(es) an earlier test run of this workspace left behind:\n  ${rows.join('\n  ')}`
  );
  const { signalled, survivors } = await terminateByIdentity(leftovers, GRACE_MS);
  for (const survivor of survivors)
    warn(`PID ${survivor.pid} survived SIGKILL; inspect it by hand.`);
  return signalled.length - survivors.length;
}

/**
 * Terminates what this run started that outlived its harness: processes
 * carrying the run's marker whose command line names the workspace. Then
 * checks that nothing carrying the marker survives.
 *
 * @param workspace - The engine and object directory
 * @param runId - The run's marker value
 * @returns How many were terminated, and the survivors
 */
export async function sweepRun(
  workspace: HostWorkspace,
  runId: string
): Promise<{ reaped: number; survivors: HostProcess[] }> {
  const ours = (entry: { environment: string }): boolean =>
    carriesMarker(entry.environment, RUN_MARKER, runId);
  const strays = await selectProcesses(
    (entry) => ours(entry) && namesWorkspace(entry.command, workspace)
  );
  const { signalled, survivors } = await terminateByIdentity(strays ?? [], GRACE_MS);
  if (signalled.length > 0) {
    verbose(
      `Terminated ${signalled.length} harness helper(s) that outlived the harness: PID ${signalled.map((entry) => entry.pid).join(', ')}.`
    );
  }
  const left = (await selectProcesses(ours)) ?? [];
  for (const entry of left) {
    warn(
      `A process of this test run is still alive: PID ${entry.pid} (${entry.command.slice(0, 120)}).`
    );
  }
  return { reaped: signalled.length - survivors.length, survivors: left };
}

/** Marionette's default control port. */
const MARIONETTE_PORT = 2828;
/** The ports desktop mochitest's servers bind: HTTP, ssltunnel, WebSocket. */
const SERVER_PORTS = [8888, 4443, 9988] as const;

/**
 * Reads the listener pids of `lsof -F p` output.
 *
 * @param output - What lsof printed
 */
export function parseLsofPids(output: string): number[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .filter((line) => /^p\d+$/.test(line))
        .map((line) => Number(line.slice(1)))
    ),
  ];
}

/** The process listening on a loopback TCP port, or undefined when none is (or lsof is missing). */
async function portHolder(port: number): Promise<HostProcess | undefined> {
  let pids: number[];
  try {
    const result = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      timeoutMs: 10_000,
    });
    pids = parseLsofPids(result.stdout);
  } catch {
    return undefined;
  }
  const pid = pids[0];
  if (pid === undefined) return undefined;
  const snapshot = await snapshotProcesses();
  const [row] = await listProcesses(['pid', 'ppid', 'command'], { pids: [pid] });
  const start = snapshot?.get(pid)?.start;
  if (row === undefined || start === undefined) return undefined;
  return { pid, start, parent: row.ppid, command: row.command };
}

/** Whether the engine's mochitest harness moves a busy server port to a free one by itself. */
export function harnessFallsBack(runtests: string | undefined): {
  servers: boolean;
  marionette: boolean;
} {
  const fallsBack = runtests !== undefined && /falling back to port/.test(runtests);
  return {
    servers: fallsBack && /\("httpPort",/.test(runtests) && /_port_in_use\(port\)/.test(runtests),
    marionette: fallsBack && /_port_in_use\(marionette_port\)/.test(runtests),
  };
}

/** A free loopback TCP port, chosen by the kernel. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** How {@link preparePorts} treats a port another process holds. */
export interface PortOptions {
  /** `auto`: step aside for a foreign holder where the harness can move. */
  ports: 'fixed' | 'auto';
  /** What the engine's harness can move by itself. */
  fallback: { servers: boolean; marionette: boolean };
  /** How long to wait for a foreign holder to let go, in milliseconds. */
  waitMs: number;
}

/**
 * Makes the ports a browser harness binds usable: a leftover of this
 * workspace is terminated, a foreign holder is waited for or, under
 * `auto`, stepped around (Marionette moves to a free port FireForge picks;
 * a server port only where the harness falls back by itself).
 *
 * @param workspace - The engine and object directory
 * @param options - See {@link PortOptions}
 * @returns The mach arguments that move Marionette, if it moved
 * @throws `port-busy` naming the holder when the wait expires
 */
export async function preparePorts(
  workspace: HostWorkspace,
  options: PortOptions
): Promise<string[]> {
  const startedAt = Date.now();
  const deadline = startedAt + options.waitMs;
  let lastProgress = startedAt;
  const args: string[] = [];
  for (const port of [MARIONETTE_PORT, ...SERVER_PORTS]) {
    for (;;) {
      const holder = await portHolder(port);
      if (holder === undefined) break;
      if (holder.parent === 1 && namesWorkspace(holder.command, workspace)) {
        info(
          `Port ${port} is held by PID ${holder.pid}, left behind by an earlier run of this workspace; terminating it.`
        );
        await terminateByIdentity([holder], GRACE_MS);
        continue;
      }
      if (options.ports === 'auto' && port === MARIONETTE_PORT) {
        const moved = await freePort();
        info(`Marionette port ${port} is held by PID ${holder.pid}; this run uses port ${moved}.`);
        args.push(`--setpref=marionette.port=${moved}`, `--marionette=127.0.0.1:${moved}`);
        break;
      }
      if (options.ports === 'auto' && options.fallback.servers) {
        info(
          `Port ${port} is held by PID ${holder.pid}; the harness moves this run to a free port.`
        );
        break;
      }
      if (Date.now() >= deadline) {
        throw refusal(
          'port-busy',
          `Port ${port} is held by PID ${holder.pid}, which is not a leftover of this workspace: ${holder.command.slice(0, 200)}`,
          'Stop it, allow a longer wait with --wait-lock <seconds>, or set test.mochitestPorts to "auto".'
        );
      }
      if (
        Date.now() - lastProgress >=
        (lastProgress === startedAt ? PROGRESS_FIRST_MS : PROGRESS_EVERY_MS)
      ) {
        lastProgress = Date.now();
        info(
          `Waiting for port ${port}, held by PID ${holder.pid} (${holder.command.slice(0, 120)}): ` +
            `${formatDuration(Date.now() - startedAt)} of up to ${formatDuration(options.waitMs)}.`
        );
      }
      await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
    }
  }
  return args;
}
