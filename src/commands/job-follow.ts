// SPDX-License-Identifier: EUPL-1.2
/**
 * Staying attached to a job a person is watching: its log streams to the
 * terminal while it runs, and Ctrl-C cancels it the way `job cancel` does, so
 * the slot is settled and audited as after any other cancel.
 */
import { wantsMachineOutput } from '../cli-usage-error.js';
import { cancelJob, readJobLogs, waitForJob } from '../core/jobs/client.js';
import { markedStep } from '../core/jobs/job-view.js';
import { type JobView, terminal } from '../core/jobs/schema.js';
import { toError } from '../utils/errors.js';
import { waitReporter } from './job-support.js';

/** How often the job's state is read between log reads. */
const POLL_MS = 250;
/** The most one log read takes. */
const LOG_CHUNK = 262_144;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type Signal = (typeof SIGNALS)[number];

/** Where a followed job writes: the log to `out`, what the follower itself says to `note`. */
export interface FollowOutput {
  out: (text: string) => void;
  note: (line: string) => void;
}

const terminalOutput = (): FollowOutput => ({
  // Under --json, stdout is the one document, so the log goes to stderr.
  out: (text) => {
    (wantsMachineOutput() ? process.stderr : process.stdout).write(text);
  },
  note: (line) => {
    process.stderr.write(`${line}\n`);
  },
});

/** Writes whole lines as they complete, and a step's marker as a short heading. */
function lineWriter(out: (text: string) => void): {
  write: (text: string) => void;
  flush: () => void;
} {
  let held = '';
  const emit = (line: string): void => {
    const step = markedStep(line);
    out(
      step === undefined
        ? `${line}\n`
        : `--- step ${String(step.index)}: ${[step.command, ...step.args].join(' ')}\n`
    );
  };
  return {
    write: (text) => {
      const lines = (held + text).split('\n');
      held = lines.pop() ?? '';
      lines.forEach(emit);
    },
    flush: () => {
      if (held !== '') out(held);
      held = '';
    },
  };
}

/** Reads the log from `offset` to its current end, writing each chunk. Returns the new end. */
async function drain(
  namespace: string,
  jobId: string,
  offset: number,
  write: (text: string) => void
): Promise<number> {
  for (let at = offset; ;) {
    const chunk = await readJobLogs(namespace, jobId, at, LOG_CHUNK);
    write(chunk.text);
    if (chunk.nextOffset <= at || chunk.nextOffset >= chunk.totalBytes) return chunk.nextOffset;
    at = chunk.nextOffset;
  }
}

/**
 * Takes SIGINT and SIGTERM from the process's own handlers while a job is
 * followed. The first one calls `onFirst`; a second one hands the signal back
 * to those handlers, which end the process. The job's cancel already stands.
 *
 * @returns What gives the handlers back. Calling it twice is harmless.
 */
function holdSignals(onFirst: (signal: Signal) => void): () => void {
  const saved = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)] as const));
  let seen = false;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const signal of SIGNALS) {
      process.off(signal, handler);
      for (const listener of saved.get(signal) ?? []) process.on(signal, listener);
    }
  };
  function handler(signal: Signal): void {
    if (!seen) {
      seen = true;
      onFirst(signal);
      return;
    }
    restore();
    process.kill(process.pid, signal);
  }
  for (const signal of SIGNALS) {
    process.removeAllListeners(signal);
    process.on(signal, handler);
  }
  return restore;
}

/**
 * Follows a job to its end: its log streams as it is written, and the first
 * SIGINT or SIGTERM cancels it. A second one stops following at once, leaving
 * the cancel to finish on its own.
 *
 * @returns The job, in a terminal state
 */
export async function followJob(
  namespace: string,
  jobId: string,
  output: FollowOutput = terminalOutput()
): Promise<JobView> {
  const lines = lineWriter(output.out);
  const release = holdSignals((signal) => {
    output.note(
      `Job ${jobId}: ${signal}, cancelling. The slot is settled and audited as after any cancel; ${signal === 'SIGINT' ? 'Ctrl-C' : signal} again stops waiting, and the cancel stands`
    );
    // This client submitted the job, whatever label it ran under.
    cancelJob(namespace, jobId, { force: true }).catch((error: unknown) => {
      output.note(`Job ${jobId}: the cancel was refused: ${toError(error).message}`);
    });
  });
  let offset = 0;
  let blocked: string | undefined;
  const report = waitReporter(output.note);
  try {
    for (;;) {
      const job = await waitForJob(
        namespace,
        jobId,
        POLL_MS,
        (reason) => {
          if (reason !== blocked) output.note(`Job ${jobId} waiting: ${reason}`);
          blocked = reason;
        },
        report
      );
      offset = await drain(namespace, jobId, offset, lines.write);
      if (terminal(job.state)) {
        lines.flush();
        return job;
      }
    }
  } finally {
    release();
  }
}
