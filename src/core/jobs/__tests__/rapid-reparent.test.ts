// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { isSameProcess, processIdentityAsync, signalOwnedProcess } from '../process.js';
import { finishOwnedProcesses, OwnedProcessTracker } from '../process-tracker.js';
import type { ProcessIdentity } from '../schema.js';

it.each(['node', 'python'])(
  'reports a rapidly reparented generic %s helper with no foothold, without signaling it',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'ff-reparent-fixture-'));
    const root = join(directory, 'slot');
    await mkdir(root);
    await mkdir(join(root, 'engine'));
    const marker = randomUUID();
    const state = join(directory, 'child.json');
    let helper: ProcessIdentity | undefined;
    let leader: ProcessIdentity | undefined;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); process.stdin.once('data',()=>{const child=spawn(process.env.FIXTURE_KIND==='node'?process.execPath:'python3',process.env.FIXTURE_KIND==='node'?['-e','setTimeout(()=>{},12000)']:['-B','-c','import time; time.sleep(12)'],{detached:true,cwd:process.env.FIXTURE_EXTERNAL_CWD,env:process.env,stdio:'ignore'});fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify({pid:child.pid}));child.unref();process.exit(0);});`;
      const parent = spawn(process.execPath, ['-e', script], {
        detached: true,
        cwd: root,
        env: {
          ...process.env,
          FIREFORGE_JOB_PHASE: marker,
          FIXTURE_KIND: kind,
          FIXTURE_STATE: state,
          FIXTURE_EXTERNAL_CWD: directory,
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const exited = once(parent, 'exit');
      leader = parent.pid === undefined ? undefined : await processIdentityAsync(parent.pid);
      if (!leader) throw new Error('Fixture parent birth unavailable');
      const ledger = join(directory, 'owned.json');
      const tracker = new OwnedProcessTracker(ledger, leader, root, marker);
      await tracker.start();
      parent.stdin.write('start');
      await exited;
      const pid = (JSON.parse(await readFile(state, 'utf8')) as { pid: number }).pid;
      for (let attempt = 0; attempt < 50 && !helper; attempt++) {
        helper = await processIdentityAsync(pid);
        if (!helper) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!helper) throw new Error('Fixture helper birth unavailable');
      // The sampler never saw the helper, so the ledger alone cannot veto it.
      const ledgerOnly = join(directory, 'ledger-only.json');
      await writeFile(ledgerOnly, await readFile(ledger));
      expect((await finishOwnedProcesses(ledgerOnly, root, leader.pid)).clean).toBe(true);
      const cleanup = await tracker.finish();
      // The marker finds it; with no foothold in the slot it is a daemon to report, not a veto.
      expect(cleanup.clean).toBe(true);
      expect(cleanup.detached?.some((entry) => entry.pid === pid)).toBe(true);
      expect(await isSameProcess(helper)).toBe(true); // The marker alone is never authority to kill.
    } finally {
      vi.useRealTimers();
      if (helper) await signalOwnedProcess(helper, 'SIGTERM');
      if (leader) await signalOwnedProcess(leader, 'SIGTERM');
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000
);
