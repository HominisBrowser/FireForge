// SPDX-License-Identifier: EUPL-1.2
/**
 * Process-level stdio concerns for the entry point: a reader that closes the
 * pipe early, and output still queued when the process is about to exit.
 */

/** The slice of a writable stream the drain wait needs. */
export interface DrainableStream {
  readonly destroyed: boolean;
  readonly writableFinished: boolean;
  readonly writableLength: number;
  on(event: 'drain' | 'error' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'error' | 'close', listener: () => void): unknown;
}

let brokenPipeHandled = false;

/**
 * Treats a closed output pipe (`fireforge status | head`) as a clean end
 * instead of an unhandled stream error. Any other stream error is rethrown.
 */
export function handleBrokenPipe(): void {
  if (brokenPipeHandled) return;
  brokenPipeHandled = true;
  const onError = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') throw error;
    process.exitCode = 0;
  };
  process.stdout.on('error', onError);
  process.stderr.on('error', onError);
}

function flushed(stream: DrainableStream): boolean {
  return stream.destroyed || stream.writableFinished || stream.writableLength === 0;
}

function drain(stream: DrainableStream, timeoutMs: number): Promise<void> {
  if (flushed(stream)) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      stream.off('drain', onDrain);
      stream.off('error', settle);
      stream.off('close', settle);
      resolve();
    };
    const onDrain = (): void => {
      if (flushed(stream)) settle();
    };
    const timer = setTimeout(settle, timeoutMs);
    stream.on('drain', onDrain);
    // A destroyed pipe can never drain and must not stall the exit behind it.
    stream.on('error', settle);
    stream.on('close', settle);
  });
}

/**
 * Waits, at most `timeoutMs`, for stdout and stderr to hand their queued
 * writes to the operating system. `process.exit` discards whatever a pipe
 * still has queued, which truncates a large `--json` document mid-object.
 * Never rejects.
 *
 * @param timeoutMs - The bound; a stalled reader cannot wedge the exit
 * @param streams - The streams to wait for
 */
export async function drainStdio(
  timeoutMs: number,
  streams: readonly DrainableStream[] = [process.stdout, process.stderr]
): Promise<void> {
  await Promise.all(streams.map((stream) => drain(stream, timeoutMs)));
}
