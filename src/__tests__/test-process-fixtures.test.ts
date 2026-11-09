// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createTempProject, removeTempProject, setInteractiveMode } from '../test-utils/index.js';
import { runCapturedProcess } from '../test-utils/spawned-process.js';
import { execSmokeRun } from '../utils/process.js';
import { type ProcessBirth, processIdentity, sameProcess } from '../utils/process-birth.js';

it.each([false, true])(
  'restores exact TTY descriptors and absence after a thrown fixture (%s)',
  (present) => {
    const streams = [process.stdin, process.stdout];
    const originals = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    try {
      for (const stream of streams) {
        if (present)
          Object.defineProperty(stream, 'isTTY', { configurable: true, get: () => false });
        else Reflect.deleteProperty(stream, 'isTTY');
      }
      const before = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
      const restore = setInteractiveMode(true);
      try {
        expect(process.stdin.isTTY).toBe(true);
        throw new Error('fixture failure');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error);
      } finally {
        restore();
      }
      expect(streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'))).toEqual(
        before
      );
    } finally {
      streams.forEach((stream, i) => {
        const descriptor = originals[i];
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else Reflect.deleteProperty(stream, 'isTTY');
      });
    }
  }
);

it('kills a hanging child before rejecting so its fixture can be removed safely', async () => {
  const root = await createTempProject('ff-hanging-fixture-');
  try {
    await expect(
      runCapturedProcess(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { writeFileSync } from 'node:fs';
      writeFileSync('child.pid', String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 100);
    `,
        ],
        { cwd: root, timeoutMs: 500, graceMs: 100 }
      )
    ).rejects.toMatchObject({ name: 'ExecTimeoutError' });
    const pid = Number(await readFile(join(root, 'child.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await removeTempProject(root);
  }
});

it('captures both pipes completely and reports a real spawn failure', async () => {
  const root = await createTempProject('ff-captured-fixture-');
  try {
    expect(
      await runCapturedProcess(
        process.execPath,
        [
          '-e',
          'process.stdout.write("payload"); process.stderr.write("diagnostic"); process.exitCode=7;',
        ],
        { cwd: root }
      )
    ).toEqual({ exitCode: 7, stdout: 'payload', stderr: 'diagnostic' });
    await expect(
      runCapturedProcess(join(root, 'missing-executable'), [], { cwd: root })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await removeTempProject(root);
  }
});

it.skipIf(process.platform === 'win32')(
  'reaps a descendant observed while its leader was alive without waiting for inherited pipe close',
  async () => {
    const root = await createTempProject('ff-observed-descendant-');
    try {
      const started = Date.now();
      const result = await runCapturedProcess(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { spawn } from 'node:child_process';
        const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},100)'], { stdio: ['ignore', process.stdout, process.stderr] });
        process.stdout.write(String(child.pid));
        setTimeout(() => process.exit(0), 800);
      `,
        ],
        { cwd: root, timeoutMs: 5000, graceMs: 100 }
      );
      expect(result.exitCode).toBe(0);
      expect(processIdentity(Number(result.stdout))).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await removeTempProject(root);
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'keeps a clean exit when a self-detached process holds the pipes, and leaves that process alone',
  async () => {
    const root = await createTempProject('ff-detached-descendant-');
    let helper: ProcessBirth | undefined;
    try {
      const started = Date.now();
      const result = await execSmokeRun(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { detached: true, stdio: ['ignore', process.stdout, process.stderr] });
        writeFileSync('child.pid', String(child.pid));
        setTimeout(() => process.exit(0), 600);
      `,
        ],
        { cwd: root, smokeTimeoutMs: 15_000, killGraceMs: 50 }
      );
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.pipesHeld).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
      helper = processIdentity(Number(await readFile(join(root, 'child.pid'), 'utf8')));
      expect(helper).toBeDefined();
    } finally {
      if (helper && sameProcess(helper)) process.kill(helper.pid, 'SIGKILL');
      await removeTempProject(root);
    }
  }
);
