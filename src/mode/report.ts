// SPDX-License-Identifier: EUPL-1.2
/**
 * `status` and `verify` as one report shape, whichever storage the project
 * keeps its owned changes in.
 */
import type { ProjectMode } from '../config/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import type { Project } from '../project/index.js';
import { type EnginePath, queueStatus, verifyQueue } from '../queue/index.js';
import { sourceStatus, verifySource } from '../source/index.js';
import { componentGroups } from './changes.js';
import { pinnedPristine, requireEngine } from './pristine.js';

/** One thing that is not as it should be. */
export type Problem = {
  /** Stable identifier: `unexported`, `unmanaged`, `stale-record`, `does-not-apply`, … */
  code: string;
  /** The engine path or patch it is about, when it is about one. */
  subject?: string;
  message: string;
  /** What to do about it. */
  hint?: string;
};

/** One owned path the storage accounts for. */
export type OwnedEntry = {
  path: string;
  /** The ID of the group that owns it. */
  group: string;
};

/**
 * One group of owned paths, by the ID that `patchLint.waivers`,
 * `patchPolicy.scopeRules` and `patchPolicy.reservedRanges` name it by: a
 * patch's file name, a component of upstream changes, a group of created
 * files, or the files a Furnace component deploys.
 */
export type GroupEntry = {
  id: string;
  kind: 'patch' | 'component' | 'created' | 'furnace';
  /** How many owned paths it holds. */
  paths: number;
};

/** What `status` reports. */
export type StatusReport = {
  mode: ProjectMode;
  owned: OwnedEntry[];
  /** The groups of the owned paths, in application order. */
  groups: GroupEntry[];
  /** Everything unaccounted for. Empty when the project is clean. */
  pending: Problem[];
};

const PENDING: Readonly<
  Partial<Record<EnginePath['state'], (path: string) => Omit<Problem, 'subject'>>>
> = {
  modified: (path) => ({
    code: 'unexported',
    message: 'edited since its patch was written',
    hint: `fireforge re-export, or fireforge discard ${path}`,
  }),
  unmanaged: (path) => ({
    code: 'unmanaged',
    message: 'changed, and no patch holds it',
    hint: `fireforge export ${path}, or fireforge discard ${path}`,
  }),
  unapplied: () => ({
    code: 'unapplied',
    message: 'the queue changes it, and the engine holds the upstream state',
    hint: 'fireforge import',
  }),
  outdated: () => ({
    code: 'outdated',
    message: 'the engine still holds what an earlier import wrote, and the queue has moved on',
    hint: 'fireforge import',
  }),
  missing: (path) => ({
    code: 'missing',
    message: 'absent from the engine, where the queue leaves a file',
    hint: `fireforge discard ${path}`,
  }),
};

/**
 * The owned changes and anything unaccounted for: in patch mode edits no
 * patch holds and a queue that is not applied; in source mode undeclared
 * upstream edits and stale records.
 *
 * @param project - The project
 */
export async function status(project: Project): Promise<StatusReport> {
  if (project.mode === 'source') {
    const report = await sourceStatus(project, await pinnedPristine(project));
    return {
      mode: 'source',
      owned: report.owned.map((entry) => ({ path: entry.path, group: entry.group })),
      groups: [
        ...report.groups.map((group) => ({ ...group })),
        ...(await componentGroups(project)).map((group) => ({
          id: group.id,
          kind: 'furnace' as const,
          paths: group.paths.length,
        })),
      ],
      pending: report.problems.map((problem) => ({
        code: problem.kind,
        subject: problem.path,
        message: problem.message,
        hint: problem.hint,
      })),
    };
  }
  await requireEngine(project);
  const report = await queueStatus(project);
  const pending: Problem[] = [];
  if (report.session !== undefined) {
    const { kind, done, total, current } = report.session;
    pending.push({
      code: 'session-paused',
      ...(current === undefined ? {} : { subject: current.patch }),
      message: `the ${kind} is unfinished at patch ${done} of ${total}`,
      hint: `fireforge ${kind} --continue`,
    });
  }
  if (report.failure !== undefined) {
    pending.push({
      code: 'does-not-apply',
      subject: report.failure.patch,
      message: report.failure.message,
      hint: 'fireforge import',
    });
  }
  for (const entry of report.paths) {
    const describe = PENDING[entry.state];
    if (describe !== undefined) pending.push({ subject: entry.path, ...describe(entry.path) });
  }
  const owned = report.paths.flatMap((entry) =>
    entry.owners[0] === undefined ? [] : [{ path: entry.path, group: entry.owners[0] }]
  );
  const sizes = new Map<string, number>();
  for (const entry of owned) sizes.set(entry.group, (sizes.get(entry.group) ?? 0) + 1);
  return {
    mode: 'patches',
    owned,
    groups: [...sizes]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, paths]) => ({ id, kind: 'patch', paths })),
    pending,
  };
}

/** What `verify` reports. */
export type VerifyReport = {
  mode: ProjectMode;
  /** Empty when the storage is sound. */
  problems: Problem[];
};

/**
 * The integrity of the storage: the manifest and queue in patch mode, the
 * override records and owned files against the pristine repository in
 * source mode.
 *
 * @param project - The project
 */
export async function verify(project: Project): Promise<VerifyReport> {
  if (project.mode === 'source') {
    const problems = await verifySource(project, await pinnedPristine(project));
    return {
      mode: 'source',
      problems: problems.map((problem) => ({
        code: problem.kind,
        subject: problem.path,
        message: problem.message,
        hint: problem.hint,
      })),
    };
  }
  const { problems } = await verifyQueue(project);
  return {
    mode: 'patches',
    problems: problems.map((problem) => ({
      code: problem.code,
      ...(problem.patch === undefined ? {} : { subject: problem.patch }),
      message: problem.message,
    })),
  };
}

const STORAGE = {
  patches: {
    sound: 'The patch queue is sound.',
    name: 'patch queue',
    exitCode: ExitCode.PATCH_ERROR,
  },
  source: {
    sound: 'The owned files and records are sound.',
    name: 'owned files and records',
    exitCode: ExitCode.CONFIG_ERROR,
  },
} as const;

/**
 * How a verify report ends: the line for a sound storage, or the failure.
 *
 * @param report - From {@link verify}
 */
export function verifyOutcome(
  report: VerifyReport
): { sound: string } | { failure: FireForgeError } {
  const storage = STORAGE[report.mode];
  if (report.problems.length === 0) return { sound: storage.sound };
  return {
    failure: new FireForgeError(
      'verify-failed',
      `${report.problems.length} problem(s) in the ${storage.name}.`,
      {
        exitCode: storage.exitCode,
        hint: 'Fix each problem listed above, then run "fireforge verify" again.',
      }
    ),
  };
}
