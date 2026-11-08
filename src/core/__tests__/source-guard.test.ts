// SPDX-License-Identifier: EUPL-1.2
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_MANIFEST } from '../../commands/manifest.js';
import type { CommandContext } from '../../types/cli.js';
import { assertExecutorCommand } from '../jobs/guard.js';
import {
  enforceSourceGuard,
  runSourceGuardHook,
  SOURCE_COMMAND_POLICIES,
  SOURCE_OUTPUT_OPTIONS,
  SOURCE_SUBCOMMAND_ACCESS,
} from '../source-guard.js';

vi.mock('../jobs/guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/guard.js')>()),
  assertExecutorCommand: vi.fn(),
}));

/** Value options naming a path a command only reads; written ones are in SOURCE_OUTPUT_OPTIONS. */
const SOURCE_READ_ONLY_PATH_OPTIONS = new Set<string>([
  'host --python',
  'host --cache',
  'host --release-secrets',
  'host --namespace',
  'job --test',
  'job --path',
  'authored --adr',
  'authored --new-pin',
  'authored --new-pristine-repository',
  'authored --path',
  'authored --pin',
  'authored --pristine-repository',
  'authored --snapshot',
  'furnace --ftl-base-path',
  'furnace --shared-ftl',
  'furnace --test-dir',
  'job --operator',
  'job --snapshot',
  'patch --creates',
  'patch --file',
  'patch --files',
  'patch --from',
  'patch --scan-file',
  'prove --control-test',
  'prove --path',
  'prove --test',
  're-export --adjacent-ignore',
  're-export --adjacent-ignore-from',
  're-export --expect',
  're-export --expect-from',
  're-export --expect-new',
  're-export --expect-removed',
  're-export --expect-unmanaged',
  're-export --files',
  're-export --scan-file',
  'run --console-allow-file',
  'slot --cache',
  'slot --from-engine',
  'slot --manifest',
  'slot --objdir-donor',
  'slot --operator',
  'slot --snapshot',
  'typecheck --explain',
  'typecheck --project',
  'typecheck --source-files',
  'wire --dom',
  'wire --subscript-dir',
  'wire --target',
]);

let temporary: string, editor: string;
beforeEach(async () => {
  vi.clearAllMocks();
  temporary = await mkdtemp(join(tmpdir(), 'ff-source-guard-'));
  editor = join(temporary, 'editor');
  await mkdir(editor);
  await writeFile(join(editor, 'fireforge.json'), JSON.stringify({ sources: { root: 'src' } }));
  vi.mocked(assertExecutorCommand).mockRejectedValue(new Error('No authenticated live executor'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

function input(
  subcommands: string[] = [],
  options: Record<string, unknown> = {},
  args: unknown[] = []
): { subcommands: string[]; options: Record<string, unknown>; args: unknown[] } {
  return { subcommands, options, args };
}

async function slot(source = true): Promise<string> {
  const namespace = join(temporary, 'private-host'),
    directory = join(namespace, 'slots', 'a'),
    root = join(directory, 'root');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, 'slot.json'),
    JSON.stringify({ schemaVersion: 1, id: 'a', root }),
    { mode: 0o600 }
  );
  if (source)
    await writeFile(join(root, 'fireforge.json'), JSON.stringify({ sources: { root: 'src' } }));
  return root;
}

describe('source mode command policy', () => {
  it('classifies every manifest command and defaults new commands to refusal', async () => {
    expect(Object.keys(SOURCE_COMMAND_POLICIES).sort()).toEqual(
      COMMAND_MANIFEST.map((entry) => entry.name).sort()
    );
    await expect(enforceSourceGuard(editor, 'future-writer', input())).rejects.toThrow(
      'source-mode-command-refused'
    );
  });

  it('classifies every registered conditional subcommand, including nested writers', () => {
    const program = new Command('fireforge');
    const context: CommandContext = {
      getProjectRoot: () => editor,
      withErrorHandling: (handler) => handler,
    };
    for (const entry of COMMAND_MANIFEST) entry.register(program, context);
    const leaves = (command: Command, prefix: string[] = []): string[] =>
      command.commands.flatMap((child) => {
        const path = [...prefix, child.name()];
        return child.commands.length ? leaves(child, path) : [path.join(' ')];
      });
    for (const [name, policy] of Object.entries(SOURCE_COMMAND_POLICIES)) {
      if (policy !== 'conditional' || name === 'config' || name === 'doctor') continue;
      const group = program.commands.find((command) => command.name() === name);
      if (!group) throw new Error(`Missing command ${name}`);
      for (const leaf of leaves(group))
        expect(
          SOURCE_SUBCOMMAND_ACCESS[name],
          `${name} ${leaf} needs explicit classification`
        ).toHaveProperty(leaf);
    }
  });

  it.each([
    'setup',
    'source',
    'download',
    'bootstrap',
    'export',
    'export-all',
    're-export',
    'import',
    'reset',
    'discard',
    'park',
    'patch',
    'rebase',
    'resolve',
    'watch',
  ])('refuses legacy %s before any action even with dry-run', async (command) => {
    const before = await readFile(join(editor, 'fireforge.json'));
    await expect(enforceSourceGuard(editor, command, input([], { dryRun: true }))).rejects.toThrow(
      'authored capture'
    );
    expect(await readFile(join(editor, 'fireforge.json'))).toEqual(before);
  });

  it('lets export-queue run in an editing checkout, and keeps its output out of the project', async () => {
    await expect(
      enforceSourceGuard(
        editor,
        'authored',
        input(['export-queue'], { out: join(editor, '..', 'q') })
      )
    ).resolves.toBeUndefined();
    await expect(
      enforceSourceGuard(
        editor,
        'authored',
        input(['export-queue'], { out: join(editor, 'src', 'q') })
      )
    ).rejects.toThrow();
  });

  it('preserves every legacy command when sources is absent, irrespective of forged environment', async () => {
    await writeFile(join(editor, 'fireforge.json'), '{}');
    vi.stubEnv('FIREFORGE_JOB_TOKEN', 'forged');
    vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'build');
    for (const entry of COMMAND_MANIFEST)
      await expect(enforceSourceGuard(editor, entry.name, input())).resolves.toBeUndefined();
    expect(assertExecutorCommand).not.toHaveBeenCalled();
  });

  it('treats a present invalid sources key as source mode rather than falling back to legacy', async () => {
    await writeFile(join(editor, 'fireforge.json'), '{"sources":null}');
    await expect(enforceSourceGuard(editor, 'reset', input())).rejects.toThrow(
      'source-mode-command-refused'
    );
    await writeFile(join(editor, 'fireforge.json'), '{');
    await expect(enforceSourceGuard(editor, 'reset', input())).rejects.toThrow(
      'Cannot establish source mode'
    );
  });

  it('retains routed authoring and pure source inspection but rejects unclassified nested writers', async () => {
    for (const command of ['register', 'wire'])
      await expect(enforceSourceGuard(editor, command, input())).resolves.toBeUndefined();
    for (const child of [
      'capture',
      'delta',
      'status',
      'validate',
      'migrate',
      'override',
      'restore-upstream',
    ])
      await expect(enforceSourceGuard(editor, 'authored', input([child]))).resolves.toBeUndefined();
    await expect(enforceSourceGuard(editor, 'token', input(['add']))).resolves.toBeUndefined();
    await expect(
      enforceSourceGuard(editor, 'slot', input(['qualify-native']))
    ).resolves.toBeUndefined();
    await expect(enforceSourceGuard(editor, 'furnace', input(['create']))).resolves.toBeUndefined();
    await expect(
      enforceSourceGuard(editor, 'furnace', input(['create'], { withTests: true }))
    ).resolves.toBeUndefined();
    for (const child of ['rename', 'remove', 'chrome-doc create', 'types'])
      await expect(
        enforceSourceGuard(editor, 'furnace', input(child.split(' ')))
      ).resolves.toBeUndefined();
    for (const child of ['override', 'refresh', 'future-writer'])
      await expect(enforceSourceGuard(editor, 'furnace', input(child.split(' ')))).rejects.toThrow(
        'source-mode-command-refused'
      );
  });

  it('requires admitted slots for runtime work and distinguishes read/config/repair operations', async () => {
    for (const command of ['test', 'build', 'check'])
      await expect(enforceSourceGuard(editor, command, input())).rejects.toThrow(
        'authored-proof-needs-slot'
      );
    for (const command of ['status', 'typecheck', 'lint', 'verify'])
      await expect(enforceSourceGuard(editor, command, input())).resolves.toBeUndefined();
    await expect(enforceSourceGuard(editor, 'furnace', input(['deploy']))).rejects.toThrow(
      'authored-proof-needs-slot'
    );
    await expect(
      enforceSourceGuard(editor, 'config', input([], {}, ['binaryName']))
    ).resolves.toBeUndefined();
    await expect(
      enforceSourceGuard(editor, 'doctor', input([], { repairFilesAffected: true }))
    ).rejects.toThrow('source-mode-command-refused');
    expect(assertExecutorCommand).not.toHaveBeenCalled();
  });

  it('reaches off-slot static feedback in a source checkout, with no namespace or with one', async () => {
    const ambient = process.env['FIREFORGE_COORDINATOR'];
    for (const namespace of [join(temporary, 'absent'), join(temporary, 'present')]) {
      await mkdir(namespace, { recursive: true });
      await writeFile(join(namespace, 'config.json'), '{}');
      process.env['FIREFORGE_COORDINATOR'] = namespace;
      for (const leaf of ['lint', 'typecheck', 'verify', 'status'])
        await expect(
          enforceSourceGuard(editor, 'authored', input([leaf]))
        ).resolves.toBeUndefined();
    }
    if (ambient === undefined) delete process.env['FIREFORGE_COORDINATOR'];
    else process.env['FIREFORGE_COORDINATOR'] = ambient;
    const root = await slot();
    await expect(enforceSourceGuard(root, 'authored', input(['lint']))).rejects.toThrow(
      'immutable-execution-slot'
    );
    expect(assertExecutorCommand).not.toHaveBeenCalled();
  });

  it('judges the project from the working directory exactly as getProjectRoot does', async () => {
    const nested = join(editor, 'deep/nested');
    await mkdir(nested, { recursive: true });
    const alias = join(temporary, 'alias-to-nested');
    await symlink(nested, alias);
    const cwd = vi.spyOn(process, 'cwd');
    const leaf = {
      name: () => 'download',
      optsWithGlobals: () => ({}),
      args: [],
      parent: { name: () => 'fireforge', parent: null },
    };
    try {
      for (const directory of [nested, alias]) {
        cwd.mockReturnValue(directory);
        await expect(runSourceGuardHook('fireforge', leaf)).rejects.toThrow(
          'source-mode-command-refused'
        );
      }
    } finally {
      cwd.mockRestore();
    }
  });

  it('refuses every written-path option aimed into a slot, including repeatable and paired values', async () => {
    const root = await slot();
    const legacy = join(temporary, 'legacy');
    await mkdir(legacy);
    await writeFile(join(legacy, 'fireforge.json'), '{}');
    const cases: [string, Record<string, unknown>][] = [
      ['build', { keepLog: join(root, 'log') }],
      ['lint', { report: join(root, 'report.json') }],
      ['test', { perfSamples: join(root, 'perf.json') }],
      ['test', { profileFile: [`source.txt=${join(root, 'copied')}`] }],
      ['re-export', { declarationsOut: join(root, 'out.json') }],
      ['patch', { mapOut: join(root, 'map.json') }],
    ];
    for (const [command, options] of cases)
      await expect(enforceSourceGuard(legacy, command, input([], options))).rejects.toThrow(
        'immutable-execution-slot'
      );
  });

  it('fails on any value option naming a path that is not classified as read or written', () => {
    const program = new Command('fireforge');
    const context: CommandContext = {
      getProjectRoot: () => editor,
      withErrorHandling: (handler) => handler,
    };
    for (const entry of COMMAND_MANIFEST) entry.register(program, context);
    const unclassified: string[] = [];
    const walk = (command: Command, top: string): void => {
      for (const child of command.commands) walk(child, top || child.name());
      if (!top) return;
      for (const option of command.options) {
        const placeholder = /<([^>]+)>/.exec(option.flags)?.[1] ?? '';
        if (!/path|file|dir|out|destination/i.test(placeholder)) continue;
        const key = option.attributeName();
        if (
          (SOURCE_OUTPUT_OPTIONS[top] ?? []).includes(key) ||
          (top === 'authored' && ['out', 'engine', 'ledger'].includes(key)) ||
          (top === 'job' && key === 'namespace') ||
          SOURCE_READ_ONLY_PATH_OPTIONS.has(`${top} --${option.long?.replace(/^--/, '') ?? ''}`)
        )
          continue;
        unclassified.push(`${top} ${option.long ?? option.flags} <${placeholder}>`);
      }
    };
    walk(program, '');
    expect(unclassified).toEqual([]);
  });

  it('prevents config pin-authority bypass and keeps refresh proposals external', async () => {
    for (const key of ['firefox', 'firefox.version', 'sources', 'sources.pristineCommit'])
      await expect(
        enforceSourceGuard(editor, 'config', input([], {}, [key, 'replacement']))
      ).rejects.toThrow('authored refresh');
    await expect(
      enforceSourceGuard(editor, 'config', input([], {}, ['firefox.version']))
    ).resolves.toBeUndefined();
    await expect(
      enforceSourceGuard(
        editor,
        'authored',
        input(['refresh'], { out: join(temporary, 'proposal') })
      )
    ).resolves.toBeUndefined();
    const donor = ['pristine', 'fetch'];
    for (const child of [['refresh'], ['migrate'], donor])
      await expect(
        enforceSourceGuard(editor, 'authored', input(child, { out: join(editor, 'proposal') }))
      ).rejects.toThrow('external disposable directory');
    const root = await slot();
    for (const child of [['refresh'], ['migrate'], donor])
      await expect(
        enforceSourceGuard(editor, 'authored', input(child, { out: join(root, 'proposal') }))
      ).rejects.toThrow('immutable-execution-slot');
  });
});

describe('immutable owned slots', () => {
  it('blocks every editor/legacy writer without relying on sources config or environment', async () => {
    const root = await slot(false);
    for (const command of ['reset', 'setup', 'register', 'wire', 'future-writer'])
      await expect(enforceSourceGuard(root, command, input())).rejects.toThrow(
        'immutable-execution-slot'
      );
    for (const [command, child] of [
      ['authored', 'override'],
      ['token', 'add'],
      ['furnace', 'create'],
      ['slot', 'prepare'],
      ['slot', 'qualify-native'],
      ['job', 'submit'],
      ['prove', 'plan'],
    ]) {
      if (!command || !child) throw new Error('fixture missing');
      await expect(enforceSourceGuard(root, command, input([child]))).rejects.toThrow(
        'immutable-execution-slot'
      );
    }
    expect(assertExecutorCommand).not.toHaveBeenCalled();
  });

  it('authenticates exact commands with mandatory live RPC instead of trusting environment', async () => {
    const root = await slot();
    await expect(enforceSourceGuard(root, 'build', input())).rejects.toThrow(
      'exact executor command'
    );
    vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'build');
    vi.stubEnv('FIREFORGE_JOB_TOKEN', 'forged');
    await expect(enforceSourceGuard(root, 'build', input())).rejects.toThrow(
      'No authenticated live executor'
    );
    vi.mocked(assertExecutorCommand).mockResolvedValue(undefined);
    await expect(enforceSourceGuard(root, 'build', input())).resolves.toBeUndefined();
    expect(assertExecutorCommand).toHaveBeenLastCalledWith('build', await realpath(root));
    await expect(enforceSourceGuard(root, 'furnace', input(['apply']))).rejects.toThrow(
      'exact executor command'
    );
    await expect(enforceSourceGuard(root, 'register', input())).rejects.toThrow(
      'immutable-execution-slot'
    );
  });

  it('does not give a read-only check descendant permission to perform Furnace writes', async () => {
    const root = await slot();
    vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'check');
    await expect(enforceSourceGuard(root, 'furnace', input(['validate']))).rejects.toThrow(
      'No authenticated live executor'
    );
    vi.mocked(assertExecutorCommand).mockResolvedValue(undefined);
    await expect(enforceSourceGuard(root, 'furnace', input(['validate']))).resolves.toBeUndefined();
    expect(assertExecutorCommand).toHaveBeenLastCalledWith('furnace', await realpath(root));
    await expect(
      enforceSourceGuard(root, 'furnace', input(['validate'], { fix: true }))
    ).rejects.toThrow('exact executor command');
    for (const child of ['apply', 'deploy', 'sync', 'create', 'types'])
      await expect(enforceSourceGuard(root, 'furnace', input([child]))).rejects.toThrow(
        'immutable-execution-slot'
      );
    await expect(
      enforceSourceGuard(root, 'furnace', input(['types'], { check: true }))
    ).resolves.toBeUndefined();
  });

  it('permits only live-authorized bounded check descendants and keeps the invoked command in the RPC', async () => {
    const root = await slot();
    vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'check');
    vi.stubEnv('FIREFORGE_JOB_TOKEN', 'forged');
    for (const command of ['status', 'verify', 'lint', 'typecheck'])
      await expect(enforceSourceGuard(root, command, input())).rejects.toThrow(
        'No authenticated live executor'
      );
    vi.mocked(assertExecutorCommand).mockResolvedValue(undefined);
    for (const command of ['status', 'verify', 'lint', 'typecheck']) {
      await expect(enforceSourceGuard(root, command, input())).resolves.toBeUndefined();
      expect(assertExecutorCommand).toHaveBeenLastCalledWith(command, await realpath(root));
    }
    for (const command of ['build', 'test', 'run', 'package'])
      await expect(enforceSourceGuard(root, command, input())).rejects.toThrow(
        'exact executor command'
      );
    await expect(enforceSourceGuard(root, 'verify', input([], { fix: true }))).rejects.toThrow(
      'exact executor command'
    );
  });

  it('keeps pure reads usable but refuses config writes and repairs', async () => {
    const root = await slot();
    await expect(
      enforceSourceGuard(root, 'config', input([], {}, ['binaryName']))
    ).resolves.toBeUndefined();
    await expect(
      enforceSourceGuard(root, 'config', input([], {}, ['binaryName', 'changed']))
    ).rejects.toThrow('immutable-execution-slot');
    await expect(enforceSourceGuard(root, 'doctor', input())).resolves.toBeUndefined();
    await expect(
      enforceSourceGuard(root, 'doctor', input([], { repairFurnace: true }))
    ).rejects.toThrow('immutable-execution-slot');
  });

  it('detects canonical aliases, nested configs, and existing-file/nonexistent-output destinations', async () => {
    const root = await slot();
    const alias = join(temporary, 'alias');
    await symlink(root, alias);
    await expect(enforceSourceGuard(alias, 'wire', input())).rejects.toThrow(
      'immutable-execution-slot'
    );
    const nested = join(root, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'fireforge.json'), '{}');
    await expect(enforceSourceGuard(nested, 'register', input())).rejects.toThrow(
      'immutable-execution-slot'
    );
    for (const out of [join(root, 'fireforge.json'), join(root, 'new', 'snapshot.json')])
      await expect(
        enforceSourceGuard(editor, 'authored', input(['capture'], { out }))
      ).rejects.toThrow('immutable-execution-slot');
    await expect(
      enforceSourceGuard(editor, 'run', input([], { captureConsole: join(root, 'capture.log') }))
    ).rejects.toThrow('immutable-execution-slot');
    await expect(
      enforceSourceGuard(
        editor,
        'authored',
        input(['materialize'], { engine: join(root, 'engine') })
      )
    ).rejects.toThrow('immutable-execution-slot');
    await expect(
      enforceSourceGuard(
        editor,
        'authored',
        input(['materialize'], { engine: join(editor, 'engine') })
      )
    ).rejects.toThrow('explicitly isolated');
  });

  it('fails closed on corrupt, mismatched or unsafe slot metadata without creating host state', async () => {
    const root = await slot();
    const marker = join(root, '..', 'slot.json');
    vi.stubEnv('FIREFORGE_COORDINATOR', join(temporary, 'never-initialize'));
    vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'build');
    for (const bytes of ['{', JSON.stringify({ schemaVersion: 1, id: 'a', root: editor })]) {
      await writeFile(marker, bytes);
      await expect(enforceSourceGuard(root, 'build', input())).rejects.toThrow(
        'positive slot identity'
      );
    }
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, id: 'a', root }));
    await chmod(marker, 0o666);
    await expect(enforceSourceGuard(root, 'build', input())).rejects.toThrow(
      'positive slot identity'
    );
    expect(await readdir(temporary)).not.toContain('never-initialize');
    expect(assertExecutorCommand).not.toHaveBeenCalled();
  });

  it('does not mistake unrelated adjacent slot.json junk for a legacy project marker', async () => {
    await writeFile(join(editor, 'fireforge.json'), '{}');
    await writeFile(join(temporary, 'slot.json'), '{');
    await expect(enforceSourceGuard(editor, 'reset', input())).resolves.toBeUndefined();
  });

  it('resolves command ancestry in the root preAction hook', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(editor);
    const program = new Command('fireforge'),
      patch = program.command('patch'),
      action = patch.command('remove');
    await expect(runSourceGuardHook(program.name(), action)).rejects.toThrow('patch remove');
  });
});
