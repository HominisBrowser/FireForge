// SPDX-License-Identifier: EUPL-1.2
/**
 * Bounded stdio drain for delayed process exits.
 *
 * `process.exit()` discards whatever is still queued in an async writable —
 * and stdout IS async when it is a pipe, with a 64 KiB kernel buffer on
 * macOS/Linux. The observed failure: `status --json --fail-on` writes a
 * 176 KB payload, the refusal makes `bin/fireforge.ts` exit non-zero, and a
 * piped consumer receives exactly 65 536 bytes. The bin entry point awaits
 * this helper before every delayed exit; the helper itself never calls
 * `process.exit` (the process-boundary test keeps that a bin-only right).
 */

/**
 * The structural slice of `Writable` the drain wait needs — accepted instead
 * of `NodeJS.WriteStream` so unit tests can drive synthetic streams.
 */
export interface DrainableStream {
  readonly destroyed: boolean;
  readonly writableFinished: boolean;
  readonly writableLength: number;
  on(event: 'drain' | 'error' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'error' | 'close', listener: () => void): unknown;
}

/** True when nothing the process is about to lose remains queued. */
function isFlushed(stream: DrainableStream): boolean {
  return stream.destroyed || stream.writableFinished || stream.writableLength === 0;
}

/**
 * Resolves once `stream` has drained its queued writes, and always within
 * `timeoutMs`. Never rejects: `'error'` and `'close'` (an EPIPE'd pipe —
 * `installBrokenPipeHandler` already swallows the error itself) resolve
 * immediately, because a destroyed pipe can never drain and must not stall
 * the exit behind it.
 */
function waitForStreamDrain(stream: DrainableStream, timeoutMs: number): Promise<void> {
  if (isFlushed(stream)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      stream.off('drain', onDrain);
      stream.off('error', settle);
      stream.off('close', settle);
      resolve();
    };
    const onDrain = (): void => {
      if (isFlushed(stream)) {
        settle();
      }
    };
    const timer = setTimeout(settle, timeoutMs);
    stream.on('drain', onDrain);
    stream.on('error', settle);
    stream.on('close', settle);
  });
}

/**
 * Waits (bounded by `timeoutMs`) for every given stream — stdout and stderr
 * by default — to drain. Resolution is unconditional; the caller exits
 * either way, the bound only decides how much queued output survives.
 */
export async function waitForStdioDrain(
  timeoutMs: number,
  streams: readonly DrainableStream[] = [process.stdout, process.stderr]
): Promise<void> {
  await Promise.all(streams.map((stream) => waitForStreamDrain(stream, timeoutMs)));
}
