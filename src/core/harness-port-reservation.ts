// SPDX-License-Identifier: EUPL-1.2
/**
 * Mochitest server ports for `fireforge test --jobs <n>`: placeholder
 * listeners that push every parallel harness instance onto its own ports,
 * and the parse of the ports each instance actually took.
 *
 * Desktop `mach mochitest` has no `--http-port`, `--ssl-port` or
 * `--websocket-port`. Its `startServers` (`testing/mochitest/runtests.py`)
 * bind-probes the HTTP server, ssltunnel and WebSocket ports (8888, 4443,
 * 9988) and moves only a busy one to a free port; see
 * `harness-port-fallback.ts`. Instances started at the same moment all
 * pass that probe on a free 8888, then race to bind it: the losers die with
 * `could not start server on port 8888` before any test runs. Holding the
 * three ports for the whole parallel run makes every instance's probe fail,
 * so each one falls back to an OS-assigned port of its own.
 */

import { createServer, type Server } from 'node:net';

/** Which mochitest server a port belongs to, as the verdict line names it. */
export type HarnessServerPortKey = 'http' | 'ssl' | 'ws';

/** One server port `startServers` probes, with its default and log label. */
interface HarnessServerPortSpec {
  key: HarnessServerPortKey;
  /** The engine default (`DEFAULT_PORTS` in mozprofile). */
  port: number;
  /** How `startServers` names it in the "falling back" line. */
  label: string;
}

/**
 * The ports `startServers` probes, in the order it probes them. Desktop
 * mochitest cannot configure them, so the engine defaults are the ports.
 */
const HARNESS_SERVER_PORTS: readonly HarnessServerPortSpec[] = [
  { key: 'http', port: 8888, label: 'HTTP test server' },
  { key: 'ssl', port: 4443, label: 'ssltunnel' },
  { key: 'ws', port: 9988, label: 'WebSocket server' },
];

/** Placeholder listeners held for a parallel run. */
export interface HarnessPortReservation {
  /** Ports this process now holds. A port that was already busy is not listed. */
  held: number[];
  /** Closes every placeholder. Safe to call more than once. */
  release(): Promise<void>;
}

/** Listens on `127.0.0.1:port`, or resolves undefined when the bind fails. */
async function holdPort(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      // Nothing should connect: the harness only probes with a bind. Anyone
      // who does gets a closed socket instead of a hang.
      socket.destroy();
    });
    server.once('error', () => {
      resolve(undefined);
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.unref();
      resolve(server);
    });
  });
}

/**
 * Holds a placeholder listener on `127.0.0.1` on each mochitest server
 * port, so the harness's busy-port probe moves every instance elsewhere.
 * A port that cannot be bound is skipped, not refused: whatever holds it
 * already makes the probe fail, which is all the placeholder is for (the
 * preflight has already ruled out this checkout's own stale httpd).
 *
 * @param ports - Ports to hold (default: {@link HARNESS_SERVER_PORTS})
 */
export async function reserveHarnessServerPorts(
  ports: readonly number[] = HARNESS_SERVER_PORTS.map((spec) => spec.port)
): Promise<HarnessPortReservation> {
  const servers = (await Promise.all(ports.map(holdPort))).filter(
    (server): server is Server => server !== undefined
  );
  const held = servers.map((server) => {
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  let released = false;
  return {
    held,
    async release() {
      if (released) return;
      released = true;
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => {
                resolve();
              });
            })
        )
      );
    },
  };
}

/** The server ports one harness invocation reported, by server. */
export type HarnessServerPorts = Partial<Record<HarnessServerPortKey, number>>;

const PORT_LINE_PATTERN =
  /\b(HTTP test server|ssltunnel|WebSocket server) port (\d+)(?: already in use, falling back to port (\d+))?/;

/**
 * Records the port one output line reports, if it reports one: the
 * fallback port of a "falling back" line, or the port itself otherwise.
 *
 * @param line - One line of harness output
 * @param into - Collected ports; a later line for the same server wins
 */
export function recordHarnessServerPortLine(line: string, into: HarnessServerPorts): void {
  const match = PORT_LINE_PATTERN.exec(line);
  if (match === null) return;
  const spec = HARNESS_SERVER_PORTS.find((entry) => entry.label === match[1]);
  const port = Number.parseInt(match[3] ?? match[2] ?? '', 10);
  if (spec !== undefined && Number.isInteger(port)) into[spec.key] = port;
}

/** Collects server ports from streamed output chunks. */
export interface HarnessPortTracker {
  onChunk(stream: 'stdout' | 'stderr', chunk: string): void;
  /** The ports seen so far, including an unterminated last line. */
  ports(): HarnessServerPorts;
}

/**
 * A tracker over the full output stream. The ports are printed at harness
 * start, so the capped capture tail a long run keeps would lose them.
 */
export function createHarnessPortTracker(): HarnessPortTracker {
  const collected: HarnessServerPorts = {};
  const pending = { stdout: '', stderr: '' };
  return {
    onChunk(stream, chunk) {
      const lines = `${pending[stream]}${chunk}`.split(/\r?\n/);
      pending[stream] = lines.pop() ?? '';
      for (const line of lines) recordHarnessServerPortLine(line, collected);
    },
    ports() {
      const result = { ...collected };
      recordHarnessServerPortLine(pending.stdout, result);
      recordHarnessServerPortLine(pending.stderr, result);
      return result;
    },
  };
}

/**
 * The `http:N,ssl:N,ws:N` value of a `ports=` key, in probe order, or
 * undefined when no port is known.
 */
export function formatHarnessServerPorts(
  ports: HarnessServerPorts | undefined
): string | undefined {
  if (ports === undefined) return undefined;
  const parts = HARNESS_SERVER_PORTS.flatMap(({ key }) =>
    ports[key] === undefined ? [] : [`${key}:${ports[key]}`]
  );
  return parts.length > 0 ? parts.join(',') : undefined;
}
