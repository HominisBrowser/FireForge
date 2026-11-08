// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CoverageSession, finishJsCoverage, prepareJsCoverage } from '../test-js-coverage.js';
import {
  browserCoverageApi,
  contentCoverageScript,
  xpcshellCoverageHead,
  xpcshellCoverageWrapper,
} from '../test-js-coverage-scripts.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ff-js-coverage-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

interface ProcessMessage {
  data: { pid: number };
  target?: object;
}

function mockedGecko(processType = 2): {
  context: Record<string, unknown>;
  files: Map<string, string>;
  observers: Map<string, () => void>;
  listeners: Map<string, (message: ProcessMessage) => void>;
  managers: object[];
  messages: string[];
  blockers: Array<() => Promise<void>>;
  processScript: () => string;
} {
  const files = new Map<string, string>(),
    observers = new Map<string, () => void>();
  const listeners = new Map<string, (message: ProcessMessage) => void>();
  const managers: object[] = [];
  const messages: string[] = [],
    blockers: Array<() => Promise<void>> = [];
  let processScript = '';
  const services = {
    appinfo: { processID: 42, processType },
    scriptSecurityManager: { getSystemPrincipal: () => ({}) },
    obs: { addObserver: (observer: () => void, topic: string) => observers.set(topic, observer) },
    ppmm: {
      get childCount() {
        return managers.length;
      },
      getChildAt: (index: number) => managers[index],
      addMessageListener: (topic: string, listener: (message: ProcessMessage) => void) =>
        listeners.set(topic, listener),
      loadProcessScript: (url: string) => {
        processScript = url;
      },
      broadcastAsyncMessage: (topic: string) => {
        messages.push(topic);
      },
    },
  };
  const cc = new Proxy(
    {},
    {
      get: (_target, contract: string) => ({
        createInstance: () => {
          if (contract.includes('/file/local'))
            return {
              path: '',
              initWithPath(path: string) {
                this.path = path;
              },
              append(name: string) {
                this.path = join(this.path, name);
              },
            };
          if (contract.includes('file-output-stream') || contract.includes('file-input-stream'))
            return {
              file: { path: '' },
              init(file: { path: string }) {
                this.file = file;
              },
            };
          if (contract.includes('converter-input-stream'))
            return {
              stream: { file: { path: '' } },
              read: false,
              init(stream: { file: { path: string } }) {
                this.stream = stream;
              },
              readString(_limit: number, chunk: { value?: string }): number {
                if (this.read) return 0;
                const text = files.get(this.stream.file.path);
                if (text === undefined) throw new Error('fixture file missing');
                this.read = true;
                chunk.value = text;
                return text.length;
              },
              close() {},
            };
          return {
            stream: { file: { path: '' } },
            init(stream: { file: { path: string } }) {
              this.stream = stream;
            },
            writeString(text: string) {
              files.set(this.stream.file.path, text);
            },
            close() {},
          };
        },
      }),
    }
  );
  const context = {
    Cc: cc,
    Ci: {},
    Components: {
      classes: cc,
      interfaces: {},
      utils: {
        Sandbox: () => ({ isGlobal: true }),
        getJSTestingFunctions: () => ({
          getLcovInfo: () => 'SF:resource://unit/module.sys.mjs\nDA:1,1\nend_of_record\n',
        }),
      },
    },
    ChromeUtils: {
      importESModule: (url: string) => {
        if (url.includes('/Services')) return { Services: services };
        if (url.includes('/jsdebugger'))
          return {
            addDebuggerToGlobal: (scope: Record<string, unknown>) => {
              if (scope['isGlobal'] !== true) throw new Error('Debugger requires a global');
              scope['Debugger'] = class {
                findAllGlobals(): Array<{ unsafeDereference: () => object }> {
                  return [{ unsafeDereference: () => ({}) }, { unsafeDereference: () => ({}) }];
                }
              };
            },
          };
        if (url.includes('/AsyncShutdown'))
          return {
            AsyncShutdown: {
              appShutdownConfirmed: {
                addBlocker: (_name: string, callback: () => Promise<void>) =>
                  blockers.push(callback),
              },
            },
          };
        return { setTimeout, clearTimeout };
      },
    },
    addMessageListener: services.ppmm.addMessageListener,
    sendAsyncMessage: (topic: string) => messages.push(topic),
    ExtensionAPI: class {
      testBoundary = true;
    },
  };
  return {
    context,
    files,
    observers,
    listeners,
    messages,
    blockers,
    managers,
    processScript: () => processScript,
  };
}

describe('JS coverage adapters', () => {
  it('flushes every discovered global synchronously on xpcshell shutdown', () => {
    const gecko = mockedGecko();
    runInNewContext(xpcshellCoverageHead(root, 'token'), gecko.context);
    gecko.observers.get('xpcom-will-shutdown')?.();
    expect(gecko.files.get(join(root, '42.lcov'))?.match(/^SF:/gm)).toHaveLength(2);
    expect(JSON.parse(gecko.files.get(join(root, '42.flushed.json')) ?? '{}')).toMatchObject({
      token: 'token',
      globals: 2,
      sourceRecords: 2,
      errors: [],
    });
  });

  it('acknowledges a requested child flush and also flushes on child shutdown', () => {
    const gecko = mockedGecko();
    runInNewContext(contentCoverageScript(root, 'token'), gecko.context);
    expect(gecko.messages).toContain('FireForge:CoverageReady:token');
    gecko.listeners.get('FireForge:CoverageFlush:token')?.({ data: { pid: 42 } });
    expect(gecko.messages).toContain('FireForge:CoverageAck:token');
    gecko.observers.get('content-child-will-shutdown')?.();
    expect(JSON.parse(gecko.files.get(join(root, '42.flushed.json')) ?? '{}')).toMatchObject({
      reason: 'content-child-will-shutdown',
    });
  });

  it('uses the actual supported parent shutdown phase and waits for known child acknowledgements', async () => {
    const gecko = mockedGecko(0);
    const api = runInNewContext(
      browserCoverageApi(root, 'token') + '\nnew fireforgeCoverage().getAPI({}).fireforgeCoverage;',
      gecko.context
    ) as { start(): void };
    api.start();
    expect(gecko.processScript()).toContain('data:application/javascript,');
    gecko.listeners.get('FireForge:CoverageReady:token')?.({ data: { pid: 73 } });
    const done = gecko.blockers[0]?.();
    expect(gecko.files.has(join(root, '42.barrier.json'))).toBe(false);
    gecko.listeners.get('FireForge:CoverageAck:token')?.({ data: { pid: 73 } });
    await done;
    expect(JSON.parse(gecko.files.get(join(root, '42.barrier.json')) ?? '{}')).toMatchObject({
      pending: [],
      acknowledged: [73],
    });
  });

  it('accepts a byte-recorded synchronous flush from a child which exited before the parent barrier', async () => {
    const gecko = mockedGecko(0);
    const api = runInNewContext(
      browserCoverageApi(root, 'token') + '\nnew fireforgeCoverage().getAPI({}).fireforgeCoverage;',
      gecko.context
    ) as { start(): void };
    api.start();
    gecko.listeners.get('FireForge:CoverageReady:token')?.({ data: { pid: 73 } });
    gecko.files.set(
      join(root, '73.flushed.json'),
      JSON.stringify({ token: 'token', pid: 73, errors: [] })
    );
    await gecko.blockers[0]?.();
    expect(JSON.parse(gecko.files.get(join(root, '42.barrier.json')) ?? '{}')).toMatchObject({
      pending: [],
    });
  });

  it('records a live process manager which never acknowledged adapter startup', async () => {
    vi.useFakeTimers();
    const gecko = mockedGecko(0);
    gecko.managers.push({});
    const api = runInNewContext(
      browserCoverageApi(root, 'token') + '\nnew fireforgeCoverage().getAPI({}).fireforgeCoverage;',
      gecko.context
    ) as { start(): void };
    api.start();
    const done = gecko.blockers[0]?.();
    await vi.advanceTimersByTimeAsync(10000);
    await done;
    expect(JSON.parse(gecko.files.get(join(root, '42.barrier.json')) ?? '{}')).toMatchObject({
      missingReady: 1,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'execs a native wrapper with the same PID and preserves argv without shell interpretation',
    async () => {
      const binary = join(root, 'fake-xpcshell'),
        head = join(root, 'coverage head.js'),
        wrapper = join(root, 'wrapper');
      await writeFile(
        binary,
        '#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ["ARGV_OUTPUT"],"w") as f: json.dump({"pid":os.getpid(),"argv":sys.argv[1:]},f)\n'
      );
      await writeFile(wrapper, xpcshellCoverageWrapper(binary, head, root, 'token'));
      await chmod(binary, 0o700);
      await chmod(wrapper, 0o700);
      const output = join(root, 'argv.json');
      const pid = await new Promise<number>((resolve, reject) => {
        const child = spawn(wrapper, ['spaces and $(literal)', '--test'], {
          env: { ...process.env, ARGV_OUTPUT: output },
          stdio: 'pipe',
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0 && child.pid !== undefined) resolve(child.pid);
          else reject(new Error(`wrapper exit ${code}`));
        });
      });
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
        pid,
        argv: ['-f', head, 'spaces and $(literal)', '--test'],
      });
      expect(JSON.parse(await readFile(join(root, `${pid}.started.json`), 'utf8'))).toMatchObject({
        pid,
        token: 'token',
      });
    }
  );
});

describe('coverage setup and completeness', () => {
  const session = (): CoverageSession => ({
    directory: root,
    token: 'token',
    suite: 'xpcshell',
    args: [],
    env: {},
  });
  const receipt = async (pid: number, flushed = true): Promise<void> => {
    await writeFile(
      join(root, `${pid}.started.json`),
      JSON.stringify({ schemaVersion: 1, token: 'token', pid })
    );
    if (flushed) {
      await writeFile(
        join(root, `${pid}.flushed.json`),
        JSON.stringify({
          schemaVersion: 1,
          token: 'token',
          pid,
          globals: 1,
          sourceRecords: 1,
          errors: [],
        })
      );
      await writeFile(join(root, `${pid}.lcov`), 'SF:resource://test.mjs\nDA:1,1\nend_of_record\n');
    }
  };
  it('keeps fresh per-attempt artifacts and injects the browser barrier adapter', async () => {
    const a = await prepareJsCoverage({
      output: root,
      engineDir: root,
      objDir: undefined,
      suite: 'mochitest',
      args: ['--headless'],
    });
    const b = await prepareJsCoverage({
      output: root,
      engineDir: root,
      objDir: undefined,
      suite: 'mochitest',
      args: [],
    });
    expect(a.directory).not.toBe(b.directory);
    expect(a.token).not.toBe(b.token);
    expect(a.args).toContain('--install-extension');
    expect(a.env['JS_CODE_COVERAGE_OUTPUT_DIR']).toBe(a.directory);
    expect(await readdir(join(a.directory, 'extension'))).toContain('api.js');
  });
  it.skipIf(process.platform === 'win32')(
    'prepares the explicit xpcshell binary override and refuses unsupported routes',
    async () => {
      await mkdir(join(root, 'obj/dist/bin'), { recursive: true });
      await writeFile(join(root, 'obj/dist/bin/xpcshell'), 'fixture');
      const prepared = await prepareJsCoverage({
        output: join(root, 'out'),
        engineDir: root,
        objDir: 'obj',
        suite: 'xpcshell',
        args: [],
      });
      expect(prepared.args[0]).toMatch(/^--xpcshell=/);
      expect(prepared.args).toContain(`--xre-path=${join(root, 'obj/dist/bin')}`);
      await expect(
        prepareJsCoverage({
          output: root,
          engineDir: root,
          objDir: undefined,
          suite: 'generic',
          args: [],
        })
      ).rejects.toMatchObject({ note: 'coverage-suite' });
    }
  );
  it('requires every started process, correct token, LCOV content and a browser barrier', async () => {
    await receipt(12);
    await receipt(13, false);
    expect(await finishJsCoverage(session())).toMatchObject({ complete: false, missing: [13] });
    await receipt(13);
    expect(await finishJsCoverage(session())).toMatchObject({
      complete: true,
      processes: [12, 13],
      sourceRecords: 2,
    });
    const browser = { ...session(), suite: 'mochitest' as const };
    expect((await finishJsCoverage(browser)).complete).toBe(false);
    await writeFile(
      join(root, '12.barrier.json'),
      JSON.stringify({ token: 'token', pending: [], missingReady: 0 })
    );
    expect((await finishJsCoverage(browser)).complete).toBe(true);
    await writeFile(join(root, '13.flushed.json'), JSON.stringify({ token: 'foreign', pid: 13 }));
    expect((await finishJsCoverage(browser)).complete).toBe(false);
  });
  it('refuses an empty run rather than treating environment setup as coverage', async () => {
    expect(await finishJsCoverage(session())).toMatchObject({ complete: false, sourceRecords: 0 });
    expect((await finishJsCoverage(session())).errors).toContain('No instrumented process started');
  });
});
