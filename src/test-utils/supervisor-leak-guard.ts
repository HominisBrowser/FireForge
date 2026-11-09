// SPDX-License-Identifier: EUPL-1.2
/**
 * Vitest global setup: a test run that leaves a coordinator supervisor running
 * fails. A supervisor exits on its own when idle or when its namespace goes, so
 * one still alive after that grace means a test left a job unfinished in a
 * namespace it never deleted.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** A supervisor process, as `ps` names it. */
export interface RunningSupervisor {
  pid: number;
  namespace: string;
}

/** Longer than the idle time a test namespace uses, and than a heartbeat. */
const GRACE_MS = 45_000;
const POLL_MS = 500;

/** Reads supervisors out of `ps -o pid=,command=` output. */
export function parseSupervisors(output: string): RunningSupervisor[] {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s.*\/supervisor-main\.[jt]s\s+(\S.*)$/.exec(line);
    return match?.[1] === undefined || match[2] === undefined
      ? []
      : [{ pid: Number(match[1]), namespace: match[2].trim() }];
  });
}

/** Supervisors of namespaces under this host's temporary directory, which only a test creates. */
function testSupervisors(): RunningSupervisor[] {
  const output = execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const roots = [tmpdir(), realpathSync(tmpdir())];
  return parseSupervisors(output).filter((entry) =>
    roots.some((root) => entry.namespace.startsWith(`${root}/`))
  );
}

/**
 * The supervisors in `after` that were not in `before`.
 *
 * @param before - Those already running when this run started, which are not its doing
 */
export function leakedSupervisors(
  before: readonly RunningSupervisor[],
  after: readonly RunningSupervisor[]
): RunningSupervisor[] {
  const known = new Set(before.map((entry) => entry.pid));
  return after.filter((entry) => !known.has(entry.pid));
}

/** Vitest's global setup hook: remembers who is running, and returns the check for the end of the run. */
export default function setup(): () => Promise<void> {
  const before = testSupervisors();
  return async () => {
    const deadline = Date.now() + GRACE_MS;
    let leaked = leakedSupervisors(before, testSupervisors());
    while (leaked.length > 0 && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, POLL_MS));
      leaked = leakedSupervisors(before, testSupervisors());
    }
    if (leaked.length > 0)
      throw new Error(
        `This test run left supervisors running, which means a test left a job unfinished in a namespace it kept: ${leaked
          .map((entry) => `pid ${entry.pid} on ${entry.namespace}`)
          .join('; ')}`
      );
  };
}
