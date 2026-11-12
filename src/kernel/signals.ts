// SPDX-License-Identifier: EUPL-1.2
/**
 * What happens between SIGINT, SIGTERM or SIGHUP and the process exiting.
 *
 * `finally` blocks do not run across `process.exit`, so anything that must
 * happen on an interrupt (stop children, undo a half-made change, release a
 * lock) registers here, and the process entry drives the pipeline without
 * knowing who registered. The phases run in this order:
 *
 *  1. `announce`  synchronously, in the signal's own tick, before anything
 *                 that can stall: a final line saying the run was killed.
 *  2. `stop`      in parallel: forward the signal to children and wait for
 *                 them.
 *  3. `rollback`  undo journaled changes. After `stop`, so no child is still
 *                 writing the files being restored.
 *  4. `restore`   put back temporary alterations while the locks are still
 *                 held, so the next holder never sees them.
 *  5. `release`   release locks.
 *  6. `finish`    close logs, remove scratch directories.
 *
 * Every handler is bounded and its failure is logged, never thrown: nothing
 * registered here can keep the process from exiting. A phase starts only once
 * every handler of the phase before it has finished. When one has not
 * finished within its bound, everything up to `finish` is skipped: a child
 * may still be writing, or an undo may still be restoring, so no undo starts
 * and no lock is released. The journal stays for the next run, and the locks
 * are taken over once this process is gone. A second signal while the
 * pipeline runs exits at once.
 */
import { ExitCode, toError } from './errors.js';
import { warn } from './log.js';
import { settlesWithin } from './time.js';

/** The signals the pipeline reacts to. */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** When a handler runs. See the module description for the order. */
export type ShutdownPhase = 'announce' | 'stop' | 'rollback' | 'restore' | 'release' | 'finish';

type Handler = (signal: ShutdownSignal) => void | Promise<void>;

interface Registration {
  handler: Handler;
  timeoutMs: number;
}

/** The phases that run in order after `announce`, each only if the one before finished. */
const PHASES: readonly ShutdownPhase[] = ['stop', 'rollback', 'restore', 'release'];

/** Default bound on one handler. */
const HANDLER_TIMEOUT_MS = 15_000;

const handlers = new Map<ShutdownPhase, Set<Registration>>();
const forceHandlers = new Set<() => void>();
let running: Promise<void> | undefined;

/**
 * Registers work for one phase of an interrupt.
 *
 * @param phase - When to run; `announce` handlers must be synchronous
 * @param handler - The work. May reject; the rejection is logged
 * @param options - `timeoutMs` bounds the handler (default 15 s)
 * @returns A function that removes the registration
 */
export function onShutdown(
  phase: ShutdownPhase,
  handler: Handler,
  options: { timeoutMs?: number } = {}
): () => void {
  const registration = { handler, timeoutMs: options.timeoutMs ?? HANDLER_TIMEOUT_MS };
  let set = handlers.get(phase);
  if (set === undefined) {
    set = new Set();
    handlers.set(phase, set);
  }
  set.add(registration);
  return () => {
    handlers.get(phase)?.delete(registration);
  };
}

/**
 * Registers synchronous work for the moment a second signal forces the exit:
 * the last chance to kill a child outright.
 *
 * @param handler - Must not throw and cannot wait
 * @returns A function that removes the registration
 */
export function onForceExit(handler: () => void): () => void {
  forceHandlers.add(handler);
  return () => {
    forceHandlers.delete(handler);
  };
}

/** Whether an interrupt is being handled. */
export function isShuttingDown(): boolean {
  return running !== undefined;
}

/** Runs one handler within its bound. Returns false when it did not finish in time. */
async function runBounded(
  phase: ShutdownPhase,
  registration: Registration,
  signal: ShutdownSignal
): Promise<boolean> {
  let failure: unknown;
  const work = Promise.resolve()
    .then(() => registration.handler(signal))
    .catch((error: unknown) => {
      failure = error;
    });
  if (!(await settlesWithin(work, registration.timeoutMs))) {
    warn(`A ${phase} step did not finish within ${registration.timeoutMs} ms of ${signal}.`);
    return false;
  }
  if (failure !== undefined) {
    warn(`A ${phase} step failed after ${signal}: ${toError(failure).message}`);
  }
  return true;
}

async function runPhase(phase: ShutdownPhase, signal: ShutdownSignal): Promise<boolean> {
  const work = [...(handlers.get(phase) ?? [])].map((registration) =>
    runBounded(phase, registration, signal)
  );
  return (await Promise.all(work)).every(Boolean);
}

async function pipeline(signal: ShutdownSignal): Promise<void> {
  for (const registration of handlers.get('announce') ?? []) {
    try {
      void registration.handler(signal);
    } catch {
      // A diagnostic never keeps the process from exiting.
    }
  }
  for (const phase of PHASES) {
    if (!(await runPhase(phase, signal))) {
      warn('Leaving the remaining undo and lock release to the next run.');
      break;
    }
  }
  await runPhase('finish', signal);
}

/**
 * Runs the interrupt pipeline. Never rejects. A second call joins the first.
 *
 * @param signal - The signal that arrived
 */
export function runShutdown(signal: ShutdownSignal): Promise<void> {
  running ??= pipeline(signal);
  return running;
}

/**
 * Forgets a finished pipeline, so one process can exercise it more than once.
 * Registrations are kept.
 */
export function resetShutdown(): void {
  running = undefined;
}

/** How the process entry ends the process. Only it may call `process.exit`. */
export interface ExitHooks {
  /** Ends the process once the pipeline has run. May flush output first. */
  exit: (code: number) => void;
  /** Ends the process immediately, for a second signal. */
  forceExit: (code: number) => void;
}

const EXIT_CODES: Record<ShutdownSignal, number> = {
  SIGINT: ExitCode.USER_CANCELLED,
  SIGTERM: ExitCode.TERMINATED,
  // A closed terminal ends the command the way a request to stop does.
  SIGHUP: ExitCode.TERMINATED,
};

/**
 * Installs the SIGINT, SIGTERM and SIGHUP listeners. The first signal runs
 * the pipeline and then exits with 130 (SIGINT) or 143. A signal that arrives while the
 * pipeline is running runs the force handlers and exits at once.
 *
 * @param hooks - See {@link ExitHooks}
 * @returns A function that removes the listeners
 */
export function installSignalHandlers(hooks: ExitHooks): () => void {
  const listeners = (Object.keys(EXIT_CODES) as ShutdownSignal[]).map((signal) => {
    const listener = (): void => {
      if (isShuttingDown()) {
        for (const handler of forceHandlers) {
          try {
            handler();
          } catch {
            // The exit below is what the user asked for.
          }
        }
        hooks.forceExit(EXIT_CODES[signal]);
        return;
      }
      void runShutdown(signal).finally(() => {
        hooks.exit(EXIT_CODES[signal]);
      });
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  };
}
