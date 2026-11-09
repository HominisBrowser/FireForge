// SPDX-License-Identifier: EUPL-1.2
/** `host status` and `host prune` against a real temporary namespace. */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerHost } from '../host.js';

let ns: string;
let writes: string[];

async function run(...args: string[]): Promise<string> {
  writes = [];
  const program = new Command().exitOverride();
  registerHost(program, { getProjectRoot: () => ns, withErrorHandling: (handler) => handler });
  await program.parseAsync(['node', 'fireforge', 'host', ...args, '--namespace', ns]);
  return writes.join('');
}

async function config(extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(ns, 'config.json'),
    JSON.stringify({ schemaVersion: 1, idleMs: 100, capacity: { cpu: 4 }, ...extra })
  );
}

async function artifact(id: string, kilobytes: number, daysOld: number): Promise<void> {
  const directory = join(ns, 'artifacts', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'step-0-execution.json'), 'x'.repeat(kilobytes * 1024));
  const then = new Date(Date.now() - daysOld * 86_400_000);
  await utimes(directory, then, then);
}

beforeEach(async () => {
  ns = await mkdtemp(join(tmpdir(), 'fireforge-host-health-'));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(ns, { recursive: true, force: true });
});

describe('host status', () => {
  it('reports free disk and what the coordinator holds, without a warning when there is room', async () => {
    await config({ diskLowGib: 1 });
    await artifact('old', 8, 1);
    const text = await run('status');
    expect(text).toMatch(/Disk: [\d.]+ GiB free of [\d.]+ GiB \(low below /);
    expect(text).toContain('Job artifacts:');
    expect(text).not.toContain('Warning');
  });

  it('warns when free space is below the threshold', async () => {
    await config({ diskLowGib: 100_000_000 });
    const text = await run('status');
    expect(text).toMatch(
      /Warning: free disk is below .* GiB; steps that run now may fail from disk pressure/
    );
    expect(text).toContain('fireforge host prune');
  });
});

describe('host prune', () => {
  it('removes artifacts no job names once they are old, prints what it freed, and keeps younger ones', async () => {
    await config();
    await artifact('left-over', 16, 3);
    await artifact('fresh', 16, 0);
    const dry = await run('prune', '--dry-run');
    expect(dry).toContain('would remove left-over (orphan)');
    expect(await readdir(join(ns, 'artifacts'))).toContain('left-over');
    const text = await run('prune');
    expect(text).toContain('removed left-over (orphan)');
    expect(text).toMatch(/Freed [\d.]+ GiB from 1 job; artifacts now/);
    expect((await readdir(join(ns, 'artifacts'))).sort()).toEqual(['fresh']);
  });
});
