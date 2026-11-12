// SPDX-License-Identifier: EUPL-1.2
/**
 * The queue's state as data, for the `status` and `verify` commands (which
 * both modes share and which the `mode` layer wires): how the engine
 * compares with the queue, and whether the stored queue is sound.
 */
import { join } from 'node:path';

import { isRepository } from '../git/index.js';
import { FireForgeError } from '../kernel/errors.js';
import { listDir } from '../kernel/fs.js';
import type { PatchProject } from '../project/index.js';
import { patchProblems } from './apply.js';
import { classifyEngine, type EnginePath, projectQueue } from './baseline.js';
import { policyProblems } from './placement.js';
import { type Queue, readQueue } from './queue.js';
import { readSession, type SessionPatchStatus } from './session.js';

/** A paused or unfinished import or rebase, as status reports it. */
export interface SessionSummary {
  readonly kind: 'import' | 'rebase';
  /** Patches processed so far, of `total`. */
  readonly done: number;
  readonly total: number;
  /** The patch the session is paused on, with its status. */
  readonly current?: { readonly patch: string; readonly status: SessionPatchStatus };
  /** `.rej` files the paused patch left. */
  readonly rejects: readonly string[];
}

/** How the engine compares with the patch queue. */
export interface QueueStatus {
  readonly patches: number;
  readonly digest: string;
  /** The first patch that does not apply to the engine's HEAD, when one does not. */
  readonly failure?: { readonly patch: string; readonly message: string };
  readonly session?: SessionSummary;
  /** Every path the queue touches and every other changed path, sorted. */
  readonly paths: readonly EnginePath[];
}

/**
 * The engine against the queue baseline, path by path, and any paused session.
 *
 * @param project - A patch-mode project with an engine
 */
export async function queueStatus(project: PatchProject): Promise<QueueStatus> {
  const queue = await readQueue(project.paths.patches);
  const projection = await projectQueue(project, queue);
  const session = await readSession(project);
  const filenames = new Map(queue.patches.map((patch) => [patch.name, patch.filename]));
  const current = session?.patches[session.index];
  return {
    patches: queue.patches.length,
    digest: queue.digest,
    ...(projection.failure === undefined
      ? {}
      : { failure: { patch: projection.failure.patch, message: projection.failure.message } }),
    ...(session === undefined
      ? {}
      : {
          session: {
            kind: session.kind,
            done: Math.min(session.index, session.last + 1),
            total: session.last + 1,
            ...(current === undefined || session.index > session.last
              ? {}
              : {
                  current: {
                    patch: filenames.get(current.name) ?? current.name,
                    status: current.status,
                  },
                }),
            rejects: current?.rejects ?? [],
          },
        }),
    paths: await classifyEngine(project, projection),
  };
}

/** One integrity problem of the stored queue. */
export interface QueueProblem {
  /** Stable identifier: `queue-manifest-invalid`, `stray-patch-file`, `does-not-apply`, … */
  readonly code: string;
  /** The patch filename, when one patch is at fault. */
  readonly patch?: string;
  readonly message: string;
}

/** What {@link verifyQueue} found. */
export interface QueueVerification {
  readonly patches: number;
  readonly problems: readonly QueueProblem[];
  /** Whether the queue was replayed onto the engine (false without an engine). */
  readonly replayed: boolean;
}

async function strayFiles(queue: Queue): Promise<QueueProblem[]> {
  const known = new Set(queue.patches.map((patch) => patch.path));
  return (await listDir(queue.dir))
    .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.patch'))
    .filter((entry) => !known.has(join(queue.dir, entry.name)))
    .map((entry) => ({
      code: 'stray-patch-file',
      patch: entry.name,
      message: `${entry.name} is not listed in patches.json; add it to the manifest or delete it.`,
    }));
}

function bodyProblems(queue: Queue): QueueProblem[] {
  return queue.patches.flatMap((patch): QueueProblem[] => {
    if (patch.diff.files.length === 0) {
      return [
        {
          code: 'empty-patch',
          patch: patch.filename,
          message: `${patch.filename} changes no file.`,
        },
      ];
    }
    return patchProblems(patch.diff).map((problem) => ({
      code: problem.reason.startsWith('path') ? 'unsafe-path' : 'binary-stub',
      patch: patch.filename,
      message: `${patch.filename}: ${problem.path} ${problem.reason}`,
    }));
  });
}

/**
 * Checks the stored queue: the manifest reads, every listed body exists and
 * parses, no stray patch files, no unsafe paths or content-less binary
 * sections, the ordering half of `patchPolicy` holds, and (with an engine)
 * the queue replays onto the engine's HEAD
 * without any patch replacing an upstream file.
 *
 * @param project - A patch-mode project
 */
export async function verifyQueue(project: PatchProject): Promise<QueueVerification> {
  let queue: Queue;
  try {
    queue = await readQueue(project.paths.patches);
  } catch (error: unknown) {
    if (!(error instanceof FireForgeError)) throw error;
    return {
      patches: 0,
      problems: [{ code: error.code, message: error.message }],
      replayed: false,
    };
  }
  const problems = [
    ...(await strayFiles(queue)),
    ...bodyProblems(queue),
    ...policyProblems(project.config.patchPolicy, queue.patches, queue.retired).map((message) => ({
      code: 'patch-policy',
      message,
    })),
  ];
  if (!(await isRepository(project.paths.engine))) {
    return { patches: queue.patches.length, problems, replayed: false };
  }
  const projection = await projectQueue(project, queue);
  for (const step of projection.steps) {
    for (const path of step.replaced) {
      problems.push({
        code: 'replaces-upstream-file',
        patch: step.patch,
        message: `${step.patch} creates ${path}, which upstream already has; re-export it so it modifies the file.`,
      });
    }
  }
  if (projection.failure !== undefined) {
    const { patch, conflicts, message } = projection.failure;
    const named = conflicts.map((conflict) => `${conflict.path} (${conflict.reason})`).join(', ');
    problems.push({
      code: 'does-not-apply',
      patch,
      message: `${patch} does not apply after the patches before it${named === '' ? `: ${message}` : `: ${named}`}`,
    });
  }
  return { patches: queue.patches.length, problems, replayed: true };
}
