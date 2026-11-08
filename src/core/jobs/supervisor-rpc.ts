// SPDX-License-Identifier: EUPL-1.2
import type { Socket } from 'node:net';

import { toError } from '../../utils/errors.js';
import type { RpcRequest } from './protocol.js';

/** A request has to arrive this quickly. The wait for its reply is the handler's business. */
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_CHARACTERS = 16 * 1024 * 1024;

/**
 * Reads one newline-terminated request and writes its reply. A client that
 * connects and leaves, as a liveness probe does, gets a plain close.
 *
 * @param socket - The accepted connection
 * @param handle - Answers the request; a rejection becomes a refusal reply
 */
export function serveConnection(
  socket: Socket,
  handle: (request: RpcRequest) => Promise<unknown>
): void {
  let data = '';
  let answered = false;
  socket.setEncoding('utf8');
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => undefined);
  socket.on('end', () => {
    if (!answered) socket.end();
  });
  socket.on('data', (chunk: string) => {
    data += chunk;
    if (data.length > MAX_REQUEST_CHARACTERS) {
      socket.destroy();
      return;
    }
    if (!data.endsWith('\n')) return;
    answered = true;
    socket.removeAllListeners('data');
    socket.setTimeout(0);
    void Promise.resolve()
      .then(() => handle((JSON.parse(data) as { request: RpcRequest }).request))
      .then(
        (value) => socket.end(`${JSON.stringify({ ok: true, value })}\n`),
        (error: unknown) => {
          const { message, name } = toError(error);
          socket.end(`${JSON.stringify({ ok: false, error: message, errorName: name })}\n`);
        }
      );
  });
}
