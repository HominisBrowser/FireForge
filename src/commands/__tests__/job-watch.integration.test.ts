// SPDX-License-Identifier: EUPL-1.2
/** `job watch` against a real host: real captures, a real supervisor, real slots and the fake mach. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { captureAuthoredSnapshot } from '../../core/authored/index.js';
import {
  type HostFixture,
  hostFixture,
  lintClean,
  removeHostFixture,
} from '../../core/jobs/__tests__/host-fixture.js';
import { readJob } from '../../core/jobs/client.js';
import type { JobView } from '../../core/jobs/schema.js';
import { CommandError, InvalidArgumentError } from '../../errors/base.js';
import { ExitCode } from '../../errors/codes.js';
import { registerJob } from '../job.js';
import { jobVerdict } from '../job-support.js';
import { watchJobs, type WatchJobsOptions } from '../job-watch.js';
import type { InputWatcher, WatchTarget } from '../job-watch-inputs.js';

/** The watcher the command itself arms, so a CLI run is driven the same way. */
const cliWatch = vi.hoisted(() => ({ target: undefined as WatchTarget | undefined }));
vi.mock('../job-watch-inputs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../job-watch-inputs.js')>()),
  defaultInputWatcher: (target: WatchTarget) => {
    cliWatch.target = target;
    return Promise.resolve({ backend: 'test watcher', close: () => undefined });
  },
}));

const cliTarget = (): WatchTarget | undefined => cliWatch.target;

const TEST = 'browser/themes/test/browser_watch.js';
let f: HostFixture;

const passing = (body = 'tabs'): string => lintClean(`add_task(() => ok(true, '${body}'));\n`);

async function writeTest(text: string): Promise<void> {
  await mkdir(dirname(join(f.project, 'src', TEST)), { recursive: true });
  await writeFile(join(f.project, 'src', TEST), text);
}

/** A test that holds the harness open while `hold` exists. */
async function holdingTest(hold: string): Promise<void> {
  await writeFile(hold, 'hold');
  await writeTest(lintClean(`// fake-mach-hold ${hold}\nadd_task(() => ok(true, 'held'));\n`));
}

/** What the running watch has said, for a failure to show. */
let said: () => string = () => '';

async function until(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
  for (let waited = 0; !(await check()); waited += 50) {
    if (waited > 150_000) throw new Error(`Never: ${what}\n${said()}`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface Watching {
  verdicts: JobView[];
  notes: string[];
  done: Promise<JobView | undefined>;
  save: (...paths: string[]) => void;
  submitted: () => string[];
}

function watching(options: Partial<WatchJobsOptions> = {}): Watching {
  const verdicts: JobView[] = [];
  const notes: string[] = [];
  let target: WatchTarget | undefined;
  const watcher: InputWatcher = (given) => {
    target = given;
    return Promise.resolve({ backend: 'test watcher', close: () => undefined });
  };
  const done = watchJobs(
    {
      namespace: f.namespace,
      projectRoot: f.project,
      build: 'ui',
      tests: [TEST],
      check: false,
      slot: 'auto',
      paths: [],
      debounceMs: 100,
      supersede: true,
      ...options,
    },
    {
      watcher,
      verdict: (job) => verdicts.push(job),
      note: (line) => notes.push(line),
      stopSettleMs: 60_000,
    }
  );
  said = () => notes.join('\n');
  live.push(done);
  return {
    verdicts,
    notes,
    done,
    save: (...paths) => {
      if (target === undefined) throw new Error('The watch is not armed yet');
      target.onChange(paths);
    },
    submitted: () => notes.filter((line) => / submitted for snapshot /.test(line)),
  };
}

const stop = (signal: NodeJS.Signals = 'SIGINT'): void => {
  process.emit(signal, signal);
};

/** The job a note says was submitted, waited on until its test step runs. */
async function heldInTest(id: string): Promise<void> {
  await until('the job reaches its test step', async () => {
    const job = await readJob(f.namespace, id);
    return job.state === 'running' && job.phase?.index === job.request.steps.length - 1;
  });
}

const submittedId = (line: string | undefined): string =>
  /^Job (\S+) submitted/.exec(line ?? '')?.[1] ?? '';

interface CliRun {
  done: Promise<{ out: string; error?: Error }>;
  /** What the command has written to stderr so far. */
  err: () => string;
}

function cliRun(...args: string[]): CliRun {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerJob(program, {
    getProjectRoot: () => f.project,
    withErrorHandling:
      <T extends unknown[]>(handler: (...values: T) => Promise<void>) =>
      (...values: T) =>
        handler(...values),
  });
  let out = '';
  let err = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const writeErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  const done = program
    .parseAsync(['node', 'fireforge', 'job', 'watch', ...args])
    .then(
      () => ({ out }),
      (error: unknown) => ({ out, error: error as Error })
    )
    .finally(() => {
      write.mockRestore();
      writeErr.mockRestore();
    });
  said = () => err;
  live.push(done);
  return { done, err: () => err };
}

const cli = (...args: string[]): CliRun['done'] => cliRun(...args).done;

beforeAll(async () => {
  f = await hostFixture();
  vi.stubEnv('FIREFORGE_COORDINATOR', f.namespace);
  vi.stubEnv('FIREFORGE_TOOLCHAINS', f.toolchains);
  const init = await f.cli(f.project, ['host', 'init', '--slots', '2', '--from-engine', f.donor]);
  expect(init.code, init.stdout + init.stderr).toBe(0);
  // A UI build extends a full one, which a host builds once.
  const full = await f.cli(f.project, ['job', 'run', '--build', 'full']);
  expect(full.code, full.stdout + full.stderr).toBe(0);
  await writeTest(passing());
}, 240_000);

/** Watches a test started; one that failed before its stop is stopped here, so the next starts clean. */
const live: Array<Promise<unknown>> = [];
afterEach(async () => {
  const pending = live.splice(0);
  const state = { open: true };
  void Promise.allSettled(pending).then(() => {
    state.open = false;
  });
  await settle(0);
  if (state.open) stop();
  await Promise.allSettled(pending);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await removeHostFixture(f);
}, 120_000);

describe.skipIf(process.platform === 'win32')('fireforge job watch', () => {
  it('runs the checkout at once, keeps the slot it got, and an edit runs again with a verdict line', async () => {
    const w = watching();
    await until('the first verdict', () => w.verdicts.length === 1);
    const first = w.verdicts[0];
    expect(first?.state, w.notes.join('\n')).toBe('passed');
    expect(first?.request.slot).toBeUndefined();
    expect(jobVerdict(first as JobView)).toMatch(/^\S+ passed slot=\S+ owner=/);
    expect(w.notes).toContain(
      `Keeping slot ${first?.slot ?? ''} for the next jobs, so its object directory stays warm`
    );
    expect(w.notes[0]).toMatch(
      /^Watching src, \.fireforge-sources, fireforge\.json, .* with test watcher/
    );
    expect(first?.request.steps.map((step) => step.command)).toEqual(['build', 'test']);

    await writeTest(passing('edited'));
    w.save(`src/${TEST}`);
    await until('the second verdict', () => w.verdicts.length === 2);
    const second = w.verdicts[1];
    expect(second?.state).toBe('passed');
    // Pinned: the second job names the slot the first one got.
    expect(second?.request.slot).toBe(first?.slot);
    expect(second?.slot).toBe(first?.slot);
    // An ordinary job: the request is what `job run --slot` would submit, keyed by its content.
    expect(second?.request.key).toMatch(/^auto-[a-f0-9]{40}$/);

    stop();
    expect((await w.done)?.id).toBe(second?.id);
  }, 300_000);

  it('submits nothing for an unchanged save, an editor temporary, an ignored file or a path outside the capture', async () => {
    const w = watching();
    await until('the first verdict', () => w.verdicts.length === 1);
    w.save(`src/${TEST}`);
    await until('the unchanged note', () =>
      w.notes.some((line) => /unchanged: nothing submitted/.test(line))
    );
    const unchanged = w.notes.filter((line) => /unchanged/.test(line)).length;
    await writeFile(join(f.project, 'src/browser/.new.js.swp'), 'swap');
    w.save(
      'src/browser/.new.js.swp',
      'src/browser/new.js~',
      'README.md',
      'engine/obj/x',
      'node_modules/a/b.js'
    );
    await settle(800);
    expect(w.notes.filter((line) => /unchanged/.test(line)).length).toBe(unchanged);
    expect(w.submitted()).toHaveLength(1);
    expect(w.verdicts).toHaveLength(1);
    await rm(join(f.project, 'src/browser/.new.js.swp'));
    stop();
    expect((await w.done)?.state).toBe('passed');
  }, 300_000);

  it('refuses a capture with a changed file outside the selection, until --allow-dirty-root leaves it out', async () => {
    const ignore = join(f.project, '.gitignore');
    const original = await readFile(ignore, 'utf8');
    await writeFile(ignore, `${original}# changed outside the selection\n`);
    try {
      const refused = watching();
      await until('the capture refusal', () =>
        refused.notes.some((line) => /authored-dirty-input: \.gitignore/.test(line))
      );
      expect(refused.submitted()).toHaveLength(0);
      stop();
      await refused.done;
      const allowed = watching({ allowDirtyRoot: true });
      await until('the first verdict', () => allowed.verdicts.length === 1);
      expect(allowed.verdicts[0]?.state).toBe('passed');
      expect(allowed.notes.join('\n')).toMatch(
        /Using committed bytes for changed files.*\.gitignore/
      );
      stop();
      await allowed.done;
    } finally {
      await writeFile(ignore, original);
    }
  }, 300_000);

  it('coalesces rapid edits into one capture of the last one', async () => {
    const w = watching({ debounceMs: 400 });
    await until('the first verdict', () => w.verdicts.length === 1);
    for (let edit = 0; edit < 5; edit += 1) {
      await writeTest(passing(`rapid ${String(edit)}`));
      w.save(`src/${TEST}`);
      await settle(30);
    }
    await until('the second verdict', () => w.verdicts.length === 2);
    await settle(600);
    expect(w.submitted()).toHaveLength(2);
    const latest = await captureAuthoredSnapshot({
      projectRoot: f.project,
      pristineRepository: f.pristine,
      retain: false,
    });
    expect(w.verdicts[1]?.request.sourceId).toBe(latest.id);
    stop();
    await w.done;
  }, 300_000);

  it('supersedes a running job with a newer capture: the old one is cancelled and the new one passes', async () => {
    const hold = join(f.directory, 'hold-supersede');
    await holdingTest(hold);
    const w = watching();
    await until('a submission', () => w.submitted().length === 1);
    const held = submittedId(w.submitted()[0]);
    await heldInTest(held);
    await writeTest(passing('superseding'));
    w.save(`src/${TEST}`);
    await until('two verdicts', () => w.verdicts.length === 2);
    expect(w.verdicts.map((job) => [job.id === held, job.state])).toEqual([
      [true, 'cancelled'],
      [false, 'passed'],
    ]);
    expect(w.notes.some((line) => line.includes('superseded by a newer capture'))).toBe(true);
    await rm(hold, { force: true });
    stop();
    // The cancel was this watch's own: the exit reads the job that ran to its end.
    expect((await w.done)?.state).toBe('passed');
  }, 300_000);

  it('with --no-supersede lets the running job finish, then runs the newest change once', async () => {
    const hold = join(f.directory, 'hold-wait');
    await holdingTest(hold);
    const w = watching({ supersede: false });
    await until('a submission', () => w.submitted().length === 1);
    const held = submittedId(w.submitted()[0]);
    await heldInTest(held);
    await writeTest(passing('waiting 1'));
    w.save(`src/${TEST}`);
    await writeTest(passing('waiting 2'));
    w.save(`src/${TEST}`);
    await until('the deferred note', () =>
      w.notes.some((line) => line.startsWith('Changed while job'))
    );
    await settle(500);
    expect(w.submitted()).toHaveLength(1);
    expect(w.notes.filter((line) => line.startsWith('Changed while job'))).toHaveLength(1);
    await rm(hold);
    await until('two verdicts', () => w.verdicts.length === 2);
    expect(w.verdicts.map((job) => [job.id === held, job.state])).toEqual([
      [true, 'passed'],
      [false, 'passed'],
    ]);
    expect(w.submitted()).toHaveLength(2);
    stop('SIGTERM');
    await w.done;
  }, 300_000);

  it('on Ctrl-C cancels the job in flight and exits with the last finished job’s code; a red names its step', async () => {
    const marker = join(f.directory, 'red');
    await writeFile(marker, 'red');
    await writeTest(
      lintClean(`// fake-mach-red-while ${marker}\nadd_task(() => ok(true, 'red'));\n`)
    );
    cliWatch.target = undefined;
    const running = cliRun('--test', TEST, '--debounce', '50', '--owner', 'watcher');
    await until('the red step note', () =>
      / went red at step 1 \(test\): fireforge job logs \S+ prints that step/.test(running.err())
    );
    const hold = join(f.directory, 'hold-stop');
    await holdingTest(hold);
    cliTarget()?.onChange([`src/${TEST}`]);
    await until('the held job', async () => {
      const ids = [...running.err().matchAll(/job watch: Job (\S+) submitted/g)].map(
        (m) => m[1] ?? ''
      );
      if (ids.length !== 2) return false;
      const job = await readJob(f.namespace, ids[1] ?? '');
      return job.state === 'running' && job.phase?.index === 1;
    });
    stop();
    const result = await running.done;
    expect(running.err()).toContain('SIGINT: cancelling job');
    await rm(hold, { force: true });
    await rm(marker, { force: true });
    expect(result.error).toBeInstanceOf(CommandError);
    expect((result.error as CommandError).exitCode).toBe(ExitCode.JOB_FAILED);
    const lines = result.out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\S+ failed slot=\S+ owner=watcher .*logs="fireforge job logs \S+"/);
    expect(lines[1]).toMatch(/^\S+ cancelled slot=\S+ owner=watcher/);
    await writeTest(passing());
  }, 300_000);

  it('refuses flags that cannot mean anything together', async () => {
    for (const [args, flag] of [
      [['--build', 'fast'], '--build'],
      [['--headed'], '--test'],
      [['--repeat', '2'], '--test'],
      [['--build', 'none'], '--build'],
      [['--test', TEST, '--debounce', '-1'], '--debounce'],
    ] as const) {
      const { error } = await cli(...args);
      expect(error, args.join(' ')).toBeInstanceOf(InvalidArgumentError);
      expect(error?.message).toContain(flag);
    }
  });
});
