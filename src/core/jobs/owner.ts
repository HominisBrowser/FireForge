// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { basename } from 'node:path';

import type { CancelAttribution } from './schema.js';

const sessionLabels = new Map<string, string>();

/** `<worktree>@<branch>` (or `<worktree>@<short HEAD>` detached) for this directory, or undefined outside git. */
function worktreeLabel(cwd: string): string | undefined {
  const git = (...args: string[]): string | undefined => {
    try {
      const out = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      return out === '' ? undefined : out;
    } catch {
      return undefined;
    }
  };
  const top = git('rev-parse', '--show-toplevel');
  if (top === undefined) return undefined;
  const branch =
    git('symbolic-ref', '--short', '-q', 'HEAD') ?? git('rev-parse', '--short', 'HEAD');
  return branch === undefined ? undefined : `${basename(top)}@${branch}`;
}

/**
 * A display label for who submitted a job. It grants nothing. `FIREFORGE_OWNER`
 * wins; otherwise the worktree and branch tell sessions apart, and outside git it
 * is `user@host`.
 */
export function ownerLabel(cwd: string = process.cwd()): string {
  const given = process.env['FIREFORGE_OWNER'];
  if (given !== undefined && given !== '') return given;
  let label = sessionLabels.get(cwd);
  if (label === undefined) {
    label = worktreeLabel(cwd) ?? `${userInfo().username}@${hostname()}`;
    sessionLabels.set(cwd, label);
  }
  return label;
}

/** Who is cancelling, as a client reports itself: its owner label (or `owner`), directory, pid and time. */
export function cancelAttribution(owner?: string): CancelAttribution {
  return {
    owner: owner ?? ownerLabel(),
    cwd: process.cwd(),
    pid: process.pid,
    at: new Date().toISOString(),
  };
}
