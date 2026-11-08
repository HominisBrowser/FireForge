// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { holdKeepAwake } from '../keep-awake.js';

const platform = process.platform;
const directories: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** A real process that records its arguments and pid, standing in for the tool on any host. */
async function stub(body: string): Promise<{ binary: string; record: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'fireforge-keep-awake-'));
  directories.push(directory);
  const record = join(directory, 'record');
  const binary = join(directory, 'caffeinate');
  await writeFile(binary, `#!/bin/sh\n${body}\necho "$$ $*" > '${record}'\nexec sleep 600\n`, {
    mode: 0o755,
  });
  return { binary, record };
}

const started = async (record: string): Promise<{ pid: number; args: string }> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const text = await readFile(record, 'utf8').catch(() => '');
    if (text.endsWith('\n')) {
      const [pid, ...args] = text.trim().split(' ');
      return { pid: Number(pid), args: args.join(' ') };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The stand-in never started');
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(platform === 'win32')('a keep-awake hold', () => {
  it('names this process to wait on, and is gone once released', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { binary, record } = await stub('');
    const hold = holdKeepAwake(binary);
    const { pid, args } = await started(record);
    expect(args).toBe(`-disu -w ${String(process.pid)}`);
    expect(alive(pid)).toBe(true);
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/^FIREFORGE-KEEP-AWAKE: pid=\d+\n$/));
    await hold?.release();
    expect(alive(pid)).toBe(false);
    // Releasing twice is harmless: there is nothing left to signal.
    await hold?.release();
  });

  it('escalates when the tool ignores a polite signal, so the phase never ends with it', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { binary, record } = await stub("trap '' TERM");
    const hold = holdKeepAwake(binary);
    const { pid } = await started(record);
    await hold?.release();
    expect(alive(pid)).toBe(false);
  });

  it('is a diagnostic when the tool cannot start, and costs the step nothing', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const hold = holdKeepAwake(join(tmpdir(), 'fireforge-no-such-caffeinate'));
    await hold?.release();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('Keep-awake is not held'));
  });

  it('holds nothing where there is nothing to hold', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(holdKeepAwake()).toBeUndefined();
  });
});
