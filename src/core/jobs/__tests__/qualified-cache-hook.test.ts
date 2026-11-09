// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPackageRoot } from '../../../utils/package-root.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import { readCliCacheHook } from '../environment.js';
import { needsNativeTools, nonStaticCheckSteps } from '../native-tools.js';

vi.mock('../../authored/git.js', async (original) => ({
  ...(await original<typeof import('../../authored/git.js')>()),
  readSourceBlobs: vi.fn(),
}));

let directory: string;
/** The child's temporary directory: apart from the fixture, whatever the host's is. */
let scratch: string;
let hook: string;
let server: Server;
let requests: Array<{ epoch: number; request: Record<string, unknown> }>;
let admitted: Record<string, unknown>;
let deny: boolean;
const firstDigest = 'a'.repeat(64),
  source = 'b'.repeat(64);

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function tool(name: string, isBin = true): Promise<string> {
  const root = join(directory, name);
  await put(
    join(root, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', bin: { [name]: 'cli.cjs' } })
  );
  const file = join(root, isBin ? 'cli.cjs' : 'programmatic.cjs');
  await put(join(root, 'cli.cjs'), '');
  await put(
    file,
    'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),jiti:process.env.JITI_FS_CACHE})+"\\n");'
  );
  return file;
}
async function run(
  entry: string,
  args: string[],
  token = 'fixture-secret',
  cwd = directory
): Promise<{ code: number | string; stdout: string; stderr: string; pid: number | undefined }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--require', hook, entry, ...args],
      {
        cwd,
        timeout: 10000,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          TMPDIR: scratch,
          FIREFORGE_COORDINATOR: directory,
          FIREFORGE_JOB_ID: 'owned-job',
          FIREFORGE_JOB_PHASE: 'phase-one',
          FIREFORGE_ADAPTER_COMMAND: 'check',
          FIREFORGE_JOB_TOKEN: token,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr, pid: child.pid });
      }
    );
  });
}
function payload(result: { stdout: string }): { argv: string[]; jiti?: string } {
  return JSON.parse(result.stdout) as { argv: string[]; jiti?: string };
}
function flags(name: string): string[] {
  return name === 'prettier'
    ? ['--no-config', '--no-editorconfig', '--ignore-path', devNull]
    : ['--no-config-lookup', '--no-ignore'];
}

beforeEach(async () => {
  directory = await mkdtemp('/tmp/ff-qualified-hook-');
  scratch = await mkdtemp(join(tmpdir(), 'ff-hook-scratch-'));
  hook = join(directory, 'cache-hook.cjs');
  await put(hook, await readCliCacheHook());
  requests = [];
  deny = false;
  admitted = {
    root: join(directory, 'slot-root'),
    sourceId: source,
    qualityToolsDigest: firstDigest,
    nodeExecutable: process.execPath,
  };
  server = createServer((socket) => {
    let text = '';
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (!text.endsWith('\n')) return;
      requests.push(JSON.parse(text) as { epoch: number; request: Record<string, unknown> });
      socket.end(
        JSON.stringify(
          deny ? { ok: false, error: 'live ownership refused' } : { ok: true, value: admitted }
        )
      );
    });
  });
  const socket = join(directory, 'rpc.sock');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await put(join(directory, 'endpoint.json'), JSON.stringify({ socket, epoch: 7 }));
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    })
  );
  await rm(directory, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('real Node startup finite CLI cache hook', () => {
  it.each(['eslint', 'prettier'])(
    'refuses %s implicit ancestor configuration before running the CLI',
    async (name) => {
      const result = await run(await tool(name), ['--cache']);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        name === 'prettier'
          ? 'requires explicit captured --config or --no-config'
          : 'requires explicit no-ancestor config lookup'
      );
    }
  );

  it('accepts exact captured config and rejects an otherwise valid external config', async () => {
    const config = join(directory, 'slot-root', 'eslint.config.cjs');
    await put(config, 'module.exports=[];');
    const entry = await tool('eslint');
    const accepted = await run(entry, ['--no-config-lookup', '--config', config, '--no-ignore']);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(payload(accepted).argv).toContain(config);
    const outside = join(directory, 'outside.config.cjs');
    await put(outside, 'module.exports=[];');
    const refused = await run(entry, ['--no-config-lookup', '--config', outside]);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('outside the captured configuration boundary');
  });

  it('accepts a captured root=true editorconfig and refuses ancestor-leaking editor rules', async () => {
    const root = join(directory, 'slot-root');
    await put(join(root, '.editorconfig'), 'root = true\n[*]\nindent_size=2\n');
    const entry = await tool('prettier');
    const args = ['--no-config', '--ignore-path', devNull];
    const accepted = await run(entry, args, 'fixture-secret', root);
    expect(accepted.code, accepted.stderr).toBe(0);
    await writeFile(join(root, '.editorconfig'), '[*]\nindent_size=2\n');
    const refused = await run(entry, args, 'fixture-secret', root);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('Captured editorconfig must stop ancestor lookup');
  });

  it('admits a Prettier config a project script generated in the temporary directory, and no other outside the capture', async () => {
    const root = join(directory, 'slot-root');
    await mkdir(root, { recursive: true });
    const entry = await tool('prettier');
    const generated = await mkdtemp(join(scratch, 'ff-prettier-config-'));
    try {
      const config = join(generated, 'prettier.json');
      await writeFile(config, '{}\n');
      const accepted = await run(
        entry,
        ['--config', config, '--no-editorconfig', '--ignore-path', devNull],
        'fixture-secret',
        root
      );
      expect(accepted.code, accepted.stderr).toBe(0);
    } finally {
      await rm(generated, { recursive: true, force: true });
    }
    await put(join(root, '.fireforge', 'prettier.json'), '{}\n');
    const refused = await run(
      entry,
      [
        '--config',
        join(root, '.fireforge', 'prettier.json'),
        '--no-editorconfig',
        '--ignore-path',
        devNull,
      ],
      'fixture-secret',
      root
    );
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('outside the captured configuration boundary');
  });

  it.each(['eslint', 'prettier'])(
    'binds %s cache location to live tool and source digests',
    async (name) => {
      const entry = await tool(name);
      const args = [
        ...flags(name),
        '--cache',
        '--cache-location',
        '/unqualified/shared-cache',
        '--',
        'a.js',
      ];
      const first = await run(entry, args);
      expect(first.code, first.stderr).toBe(0);
      const expected = join(
        directory,
        'slot-root/.fireforge/quality-caches',
        firstDigest,
        source,
        name,
        'cache'
      );
      expect(payload(first)).toEqual({
        argv: [...flags(name), '--cache', '--cache-location', expected, '--', 'a.js'],
        jiti: 'false',
      });
      expect((await stat(dirname(expected))).mode & 0o777).toBe(0o700);
      expect(requests[0]).toEqual({
        epoch: 7,
        request: {
          operation: 'authorize',
          jobId: 'owned-job',
          token: 'fixture-secret',
          phase: 'phase-one',
          pid: first.pid,
          command: 'check',
        },
      });
      expect(first.stdout).not.toContain('fixture-secret');
      admitted['qualityToolsDigest'] = 'c'.repeat(64);
      const second = await run(entry, args);
      expect(second.code, second.stderr).toBe(0);
      expect(payload(second).argv).toContain(
        join(
          directory,
          'slot-root/.fireforge/quality-caches',
          'c'.repeat(64),
          source,
          name,
          'cache'
        )
      );
      expect(payload(second).argv).not.toContain(expected);
    }
  );

  it('replaces equals-form cache locations while preserving literal flags after --', async () => {
    const result = await run(await tool('prettier'), [
      ...flags('prettier'),
      '--cache-location=/old',
      '--',
      '--cache-location=literal-file',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const args = payload(result).argv;
    expect(args).not.toContain('--cache-location=/old');
    expect(args.at(-1)).toBe('--cache-location=literal-file');
    expect(args.filter((arg) => arg === '--cache-location')).toHaveLength(1);
  });

  it('fails before the tool runs when live admission refuses the child', async () => {
    deny = true;
    const result = await run(await tool('eslint'), flags('eslint'));
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Qualified CLI cache authorization failed');
  });

  it.each(['sourceId', 'qualityToolsDigest'])(
    'refuses an unqualified %s before cache reuse',
    async (field) => {
      admitted[field] = 'not-qualified';
      const result = await run(await tool('prettier'), flags('prettier'));
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('no qualified tool/source identity');
    }
  );

  it('refuses a different Node runtime identity and a missing cache-location argument', async () => {
    admitted['nodeExecutable'] = hook;
    const different = await run(await tool('eslint'), flags('eslint'));
    expect(different.code).not.toBe(0);
    expect(different.stderr).toContain('Alternate Node runtime');
    admitted['nodeExecutable'] = process.execPath;
    const missing = await run(await tool('eslint'), [...flags('eslint'), '--cache-location']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('Missing cache location');
  });

  it('does not rewrite unrecognized packages, non-bin imports or standalone invocations', async () => {
    for (const [name, isBin, token] of [
      ['other-tool', true, 'fixture-secret'],
      ['prettier', false, 'fixture-secret'],
      ['eslint', true, ''],
    ] as const) {
      const result = await run(await tool(name, isBin), ['--cache-location', '/unchanged'], token);
      expect(result.code, result.stderr).toBe(0);
      expect(payload(result).argv).toEqual(['--cache-location', '/unchanged']);
    }
    expect(requests).toEqual([]);
  });
});

describe('a real node process under the hook', () => {
  const run = (
    cwd: string,
    args: string[],
    token = 'live'
  ): Promise<{ code: number; err: string }> =>
    new Promise((settle) => {
      execFile(
        process.execPath,
        ['--require', hook, ...args],
        { cwd, env: { PATH: process.env['PATH'], FIREFORGE_JOB_TOKEN: token } },
        (error, _stdout, stderr) => {
          settle({ code: error === null ? 0 : Number(error.code ?? 1), err: stderr });
        }
      );
    });
  const hook = join(getPackageRoot(), 'runtime', 'qualified-node-bootstrap.cjs');

  it('leaves an entry it cannot resolve alone, as node itself does', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ff-hook-entry-'));
    try {
      await writeFile(join(directory, 'foo.js'), 'process.exit(0);\n');
      expect(await run(directory, ['foo'])).toMatchObject({ code: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('check step footprints', () => {
  const snapshot = (extraSteps: unknown[]): AuthoredSnapshot =>
    ({ config: { check: { extraSteps } } }) as unknown as AuthoredSnapshot;
  it('names only the steps that did not declare themselves static', () => {
    expect(
      nonStaticCheckSteps(
        snapshot([
          { name: 'a', command: 'x', footprint: { static: true, cpu: 2 } },
          { name: 'b', command: 'x', footprint: { static: false } },
          { name: 'c', command: 'x' },
        ])
      )
    ).toEqual(['b', 'c']);
  });
  it('a check with only static steps needs no native tools; any other does', () => {
    const check = { command: 'check' as const, args: [] };
    expect(
      needsNativeTools(check, snapshot([{ name: 'a', command: 'x', footprint: { static: true } }]))
    ).toBe(false);
    expect(needsNativeTools(check, snapshot([{ name: 'a', command: 'x' }]))).toBe(true);
    expect(needsNativeTools({ command: 'build', args: [] }, snapshot([]))).toBe(true);
    expect(needsNativeTools({ command: 'lint', args: [] }, snapshot([]))).toBe(false);
  });
});
