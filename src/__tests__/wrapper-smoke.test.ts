// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { PUBLIC_API_EXPORTS } from '../test-utils/public-api.js';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const npmCmd = 'npm';
const npmOpts = { shell: true } as const;

const cleanupPaths: string[] = [];

afterAll(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('installed package smoke test', () => {
  it('npm pack --dry-run exposes the intended package surface', async () => {
    const { stdout } = await execFileAsync(npmCmd, ['pack', '--dry-run', '--json', '--silent'], {
      cwd: repoRoot,
      ...npmOpts,
    });
    const [firstPackResult] = parsePackResult(stdout);
    if (!firstPackResult) {
      throw new Error('Unexpected empty npm pack --dry-run --json output');
    }

    const packedFiles = (firstPackResult.files ?? []).map((file) => file.path).sort();
    expect(packedFiles).toEqual(
      expect.arrayContaining([
        'CHANGELOG.md',
        'LICENSE.md',
        'README.md',
        'dist/bin/fireforge.js',
        'dist/src/index.js',
        'templates/configs/common.mozconfig',
        'package.json',
      ])
    );
    expect(packedFiles.some((path) => path.startsWith('templates/configs/'))).toBe(true);
    expect(packedFiles.some((path) => path.startsWith('configs/'))).toBe(false);
    expect(packedFiles.some((path) => path.startsWith('src/'))).toBe(false);
    expect(packedFiles.some((path) => path.includes('__tests__'))).toBe(false);
    expect(packedFiles.some((path) => path.includes('test-utils'))).toBe(false);
  }, 30_000);

  it('npm pack produces a working installable tarball and installed CLI entrypoint', async () => {
    // Pack the repo — prepack will run tsc
    const { stdout: packOut } = await execFileAsync(npmCmd, ['pack', '--json', '--silent'], {
      cwd: repoRoot,
      ...npmOpts,
    });
    const [firstPackResult] = parsePackResult(packOut);
    if (!firstPackResult) {
      throw new Error('Unexpected empty npm pack --json output');
    }
    const filename = firstPackResult.filename;
    if (!filename) {
      throw new Error('npm pack did not return a tarball filename');
    }
    const tgzPath = join(repoRoot, filename);
    cleanupPaths.push(tgzPath);

    // Create a temp project
    const tempDir = await mkdtemp(join(tmpdir(), 'fireforge-smoke-'));
    cleanupPaths.push(tempDir);
    await execFileAsync(npmCmd, ['init', '-y'], { cwd: tempDir, ...npmOpts });
    await execFileAsync(npmCmd, ['install', tgzPath], { cwd: tempDir, ...npmOpts });

    const installedPkgRoot = join(tempDir, 'node_modules', 'fireforge');
    const shippedFiles = await listRelativeFiles(installedPkgRoot);

    // ---- Assert the installed package layout ----
    const pkgJson = JSON.parse(await readFile(join(installedPkgRoot, 'package.json'), 'utf-8')) as {
      bin: Record<string, string>;
      exports: Record<string, unknown>;
      main: string;
      types: string;
    };

    const binEntry = pkgJson.bin['fireforge'];
    if (!binEntry) throw new Error('bin.fireforge not found in installed package.json');
    expect(binEntry).toMatch(/dist\/bin\/fireforge\.js$/);
    expect(Object.keys(pkgJson.exports).sort()).toEqual(['.', './*', './package.json']);
    expect(pkgJson.main).toBe('./dist/src/index.js');
    expect(pkgJson.types).toBe('./dist/src/index.d.ts');

    // dist/ is present
    const binPath = join(installedPkgRoot, binEntry);
    const binContents = await readFile(binPath, 'utf-8');
    expect(binContents).toContain('#!/usr/bin/env node');
    await expect(readFile(join(installedPkgRoot, pkgJson.main), 'utf-8')).resolves.toContain(
      'export'
    );
    await expect(readFile(join(installedPkgRoot, pkgJson.types), 'utf-8')).resolves.toContain(
      'export'
    );

    // templates/ is present
    const commonMozconfig = await readFile(
      join(installedPkgRoot, 'templates', 'configs', 'common.mozconfig'),
      'utf-8'
    );
    expect(commonMozconfig.length).toBeGreaterThan(0);
    expect(shippedFiles).toEqual(
      expect.arrayContaining(['CHANGELOG.md', 'LICENSE.md', 'README.md'])
    );
    expect(shippedFiles.some((path) => path.startsWith('templates/configs/'))).toBe(true);
    expect(shippedFiles.some((path) => path.startsWith('configs/'))).toBe(false);

    expect(shippedFiles.some((path) => path.startsWith('src/'))).toBe(false);
    expect(shippedFiles.some((path) => path.includes('/__tests__/'))).toBe(false);
    expect(shippedFiles.some((path) => path.includes('/test-utils/'))).toBe(false);
    expect(shippedFiles.some((path) => path.endsWith('.test.ts'))).toBe(false);

    // ---- Assert the CLI works ----
    const { stdout } = await execFileAsync(process.execPath, [binPath, '--help']);
    expect(stdout).toContain('Usage: fireforge');

    const { stdout: versionOutput } = await execFileAsync(process.execPath, [binPath, '--version']);
    expect(versionOutput.trim()).toMatch(/^0\.9\.0$/);

    const installedCliPath = join(
      tempDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'fireforge.cmd' : 'fireforge'
    );
    const { stdout: installedCliVersion } = await execFileAsync(installedCliPath, ['--version'], {
      cwd: tempDir,
      ...npmOpts,
    });
    expect(installedCliVersion.trim()).toMatch(/^0\.9\.0$/);

    const { stdout: exportedKeysOutput } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import('fireforge').then((mod) => { console.log(JSON.stringify(Object.keys(mod).sort())); });",
      ],
      { cwd: tempDir }
    );
    expect(JSON.parse(exportedKeysOutput.trim()) as string[]).toEqual(PUBLIC_API_EXPORTS);

    const { stdout: blockedSubpathOutput } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "try { await import('fireforge/dist/src/cli.js'); console.log('unexpected-success'); process.exit(1); } catch (error) { console.log(typeof error === 'object' && error && 'code' in error ? error.code : String(error)); }",
      ],
      { cwd: tempDir }
    );
    expect(blockedSubpathOutput.trim()).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');

    const consumerEntry = join(tempDir, 'consumer-smoke.ts');
    const consumerTsconfig = join(tempDir, 'tsconfig.json');
    await writeFile(
      consumerEntry,
      [
        "import { loadConfig, ExitCode, FireForgeError, type FireForgeConfig } from 'fireforge';",
        'const config = null as FireForgeConfig | null;',
        'void config;',
        'const load = loadConfig;',
        'void load;',
        'const ok: number = ExitCode.SUCCESS;',
        'void ok;',
        'class DemoError extends FireForgeError { readonly code = ExitCode.GENERAL_ERROR; }',
        'void DemoError;',
      ].join('\n')
    );
    await writeFile(
      consumerTsconfig,
      JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2022',
            strict: true,
            noEmit: true,
          },
          include: ['consumer-smoke.ts'],
        },
        null,
        2
      )
    );

    await execFileAsync(
      process.execPath,
      [join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', consumerTsconfig],
      { cwd: tempDir }
    );

    // ---- Assert setup can find templates ----
    const { stdout: setupHelp } = await execFileAsync(process.execPath, [
      binPath,
      'setup',
      '--help',
    ]);
    expect(setupHelp).toContain('--firefox-version');
  }, 120_000);

  it('can pack from a publication staging directory without a git checkout', async () => {
    await execFileAsync(npmCmd, ['run', 'build'], { cwd: repoRoot, ...npmOpts });

    const stageDir = await mkdtemp(join(tmpdir(), 'fireforge-pack-stage-'));
    cleanupPaths.push(stageDir);

    await cp(join(repoRoot, 'dist'), join(stageDir, 'dist'), { recursive: true });
    await cp(join(repoRoot, 'templates'), join(stageDir, 'templates'), { recursive: true });
    await cp(join(repoRoot, 'package.json'), join(stageDir, 'package.json'));
    await cp(join(repoRoot, 'README.md'), join(stageDir, 'README.md'));
    await cp(join(repoRoot, 'CHANGELOG.md'), join(stageDir, 'CHANGELOG.md'));
    await cp(join(repoRoot, 'LICENSE.md'), join(stageDir, 'LICENSE.md'));

    const { stdout } = await execFileAsync(
      npmCmd,
      ['pack', '--json', '--ignore-scripts', '--silent'],
      { cwd: stageDir, ...npmOpts }
    );
    const [firstPackResult] = parsePackResult(stdout);
    if (!firstPackResult) {
      throw new Error('Unexpected empty npm pack --json output');
    }
    const filename = firstPackResult.filename;
    if (!filename) {
      throw new Error('npm pack did not return a tarball filename');
    }
    cleanupPaths.push(join(stageDir, filename));

    expect(filename).toMatch(/^fireforge-0\.9\.0\.tgz$/);
  }, 120_000);
});

function parsePackResult(stdout: string): Array<{
  filename?: string;
  files?: Array<{ path: string }>;
}> {
  const trimmed = stdout.trim();

  for (
    let index = trimmed.lastIndexOf('[');
    index >= 0;
    index = trimmed.lastIndexOf('[', index - 1)
  ) {
    try {
      return JSON.parse(trimmed.slice(index)) as Array<{ filename: string }>;
    } catch {
      continue;
    }
  }

  throw new Error(`Unexpected npm pack --json output: ${trimmed}`);
}

async function listRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, relativePath)));
    } else {
      files.push(relativePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
