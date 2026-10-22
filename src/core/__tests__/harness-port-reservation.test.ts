// SPDX-License-Identifier: EUPL-1.2
/**
 * `--jobs` mochitest server ports: the placeholder listeners that make the
 * harness's busy-port probe move every instance, and the parse of the
 * ports each instance reported.
 */
import { createServer, type Server } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  createHarnessPortTracker,
  formatHarnessServerPorts,
  type HarnessServerPorts,
  recordHarnessServerPortLine,
  reserveHarnessServerPorts,
} from '../harness-port-reservation.js';

/** Listens on a free loopback port; the caller closes it. */
async function listenFree(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

async function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A free port: bound once, then released. */
async function freePort(): Promise<number> {
  const server = await listenFree();
  const port = portOf(server);
  await close(server);
  return port;
}

/** The harness's probe: true when a bind to `127.0.0.1:port` fails. */
async function inUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(true);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        resolve(false);
      });
    });
  });
}

describe('reserveHarnessServerPorts', () => {
  it('holds each port until released, so a bind probe sees it busy', async () => {
    const ports = [await freePort(), await freePort()];
    const reservation = await reserveHarnessServerPorts(ports);
    try {
      expect(reservation.held).toEqual(ports);
      for (const port of ports) expect(await inUse(port)).toBe(true);
    } finally {
      await reservation.release();
    }
    for (const port of ports) expect(await inUse(port)).toBe(false);
    await expect(reservation.release()).resolves.toBeUndefined();
  });

  it('skips a port something else already holds instead of failing', async () => {
    const holder = await listenFree();
    const busy = portOf(holder);
    const free = await freePort();
    const reservation = await reserveHarnessServerPorts([busy, free]);
    try {
      expect(reservation.held).toEqual([free]);
    } finally {
      await reservation.release();
      await close(holder);
    }
  });
});

describe('harness server port parsing', () => {
  it('reads fallback lines, and plain port lines, per server', () => {
    const ports: HarnessServerPorts = {};
    recordHarnessServerPortLine(
      '[job 2]  0:01.02 INFO HTTP test server port 8888 already in use, falling back to port 53001',
      ports
    );
    recordHarnessServerPortLine(
      'ssltunnel port 4443 already in use, falling back to port 53002',
      ports
    );
    recordHarnessServerPortLine('WebSocket server port 9988', ports);
    recordHarnessServerPortLine(
      'Marionette port 2828 already in use, falling back to port 1',
      ports
    );
    expect(ports).toEqual({ http: 53001, ssl: 53002, ws: 9988 });
    expect(formatHarnessServerPorts(ports)).toBe('http:53001,ssl:53002,ws:9988');
  });

  it('formats only known ports, and nothing when none is known', () => {
    expect(formatHarnessServerPorts({ ssl: 1 })).toBe('ssl:1');
    expect(formatHarnessServerPorts({})).toBeUndefined();
    expect(formatHarnessServerPorts(undefined)).toBeUndefined();
  });

  it('tracks lines split across chunks and streams, including an unterminated tail', () => {
    const tracker = createHarnessPortTracker();
    tracker.onChunk('stdout', 'HTTP test server port 8888 already in use, fall');
    tracker.onChunk('stderr', 'ssltunnel port 4443 already in use, falling back to port 2\n');
    tracker.onChunk('stdout', 'ing back to port 1\nWebSocket server port 9988 already in use, ');
    tracker.onChunk('stdout', 'falling back to port 3');
    expect(tracker.ports()).toEqual({ http: 1, ssl: 2, ws: 3 });
  });
});
