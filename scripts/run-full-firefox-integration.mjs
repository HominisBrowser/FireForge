// SPDX-License-Identifier: EUPL-1.2
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = process.env.FIREFORGE_FULL_PROJECT_ROOT;
const buildMode = process.env.FIREFORGE_FULL_BUILD_MODE === 'full' ? 'full' : 'ui';
const targetFileOverride = process.env.FIREFORGE_FULL_TARGET_FILE;
const keepPatch = process.env.FIREFORGE_FULL_KEEP_PATCH === '1';
const skipSetup = process.env.FIREFORGE_FULL_SKIP_SETUP === '1';

if (!projectRoot) {
  throw new Error(
    'FIREFORGE_FULL_PROJECT_ROOT is required. Point it at a prepared FireForge project backed by a full Firefox source tree.'
  );
}

const fireforgeBin = fileURLToPath(new URL('../dist/bin/fireforge.js', import.meta.url));
const artifactStamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = join(projectRoot, '.fireforge', 'full-integration-artifacts', artifactStamp);
const engineDir = join(projectRoot, 'engine');
const backups = new Map();
const initialDirtyContent = new Map();
const createdPatchInfo = { filename: null };
let initialEngineStatusEntries = [];

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

const report = {
  startedAt: new Date().toISOString(),
  projectRoot,
  buildMode,
  targetFile: null,
  patchFilename: null,
  keptPatch: keepPatch,
  skippedSetup: skipSetup,
  commands: [],
  observations: {},
  cleanup: {
    actions: [],
    errors: [],
  },
  artifacts: {
    dir: artifactDir,
  },
};

const requiredPaths = [
  ['fireforge.json', join(projectRoot, 'fireforge.json')],
  ['engine', join(projectRoot, 'engine')],
  ['patches', join(projectRoot, 'patches')],
  ['dist bin', fireforgeBin],
];

const setupManagedFiles = [
  'fireforge.json',
  '.gitignore',
  'package.json',
  'LICENSE',
  'configs/common.mozconfig',
  'configs/linux.mozconfig',
  'configs/darwin.mozconfig',
  'configs/win32.mozconfig',
  '.fireforge/state.json',
  'patches/patches.json',
];

function sanitizeLabel(value) {
  return (
    value
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'step'
  );
}

function createPreviewCollector(limit = 200_000) {
  let text = '';
  let truncated = false;

  return {
    push(chunk) {
      if (truncated) {
        return;
      }

      const remaining = limit - text.length;
      if (chunk.length > remaining) {
        text += chunk.slice(0, remaining);
        text += '\n[truncated]';
        truncated = true;
      } else {
        text += chunk;
      }
    },
    getText() {
      return text;
    },
  };
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function requirePath(label, targetPath) {
  if (!(await pathExists(targetPath))) {
    throw new Error(`Missing required full-integration path: ${targetPath} (${label})`);
  }
}

async function ensureArtifactDirectory() {
  await mkdir(artifactDir, { recursive: true });
}

async function writeArtifact(relativePath, content) {
  const fullPath = join(artifactDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  return fullPath;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.status ?? 1;

  if (!options.allowFailure && exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${command} ${args.join(' ')}\n${stdout}${stderr}`
    );
  }

  return { stdout, stderr, exitCode };
}

async function runLoggedCommand(label, command, args, options = {}) {
  const logFile = join(
    artifactDir,
    `${String(report.commands.length + 1).padStart(2, '0')}-${sanitizeLabel(label)}.log`
  );
  await mkdir(dirname(logFile), { recursive: true });

  const collector = createPreviewCollector();
  const startedAt = Date.now();
  const logStream = createWriteStream(logFile, { encoding: 'utf8' });
  logStream.write(`$ ${command} ${args.join(' ')}\n\n`);

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        ...(options.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      logStream.write(text);
      collector.push(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      logStream.write(text);
      collector.push(text);
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });

  logStream.write(`\n[exit ${exitCode}]\n`);
  logStream.end();

  const durationMs = Date.now() - startedAt;
  const preview = collector.getText();

  report.commands.push({
    label,
    command,
    args,
    cwd: options.cwd ?? projectRoot,
    exitCode,
    durationMs,
    logFile,
  });

  if (options.expectFailure) {
    if (exitCode === 0) {
      throw new Error(`Expected command to fail: ${label}`);
    }
  } else if (exitCode !== 0) {
    throw new Error(`Command failed: ${label}. See ${logFile}`);
  }

  if (options.requiredText && !preview.includes(options.requiredText)) {
    throw new Error(
      `Command output for ${label} did not contain expected text: ${options.requiredText}`
    );
  }

  return { exitCode, preview, logFile };
}

function getFireforgeArgs(commandArgs) {
  return [fireforgeBin, ...commandArgs];
}

async function runFireforge(label, commandArgs, options = {}) {
  return runLoggedCommand(label, process.execPath, getFireforgeArgs(commandArgs), options);
}

function commentMarkerFor(targetFile, markerId, variant = 'patch') {
  const extension = extname(targetFile).toLowerCase();
  const coreText =
    variant === 'patch' ? `fireforge-full-suite:${markerId}` : `fireforge-local-only:${markerId}`;

  if (
    [
      '.js',
      '.mjs',
      '.cjs',
      '.ts',
      '.tsx',
      '.jsx',
      '.cpp',
      '.cc',
      '.c',
      '.h',
      '.hh',
      '.hpp',
      '.rs',
    ].includes(extension)
  ) {
    return `// ${coreText}`;
  }

  if (['.py', '.sh', '.mk', '.mozbuild', '.configure', '.toml', '.cfg'].includes(extension)) {
    return `# ${coreText}`;
  }

  return coreText;
}

function appendMarker(content, marker) {
  return content.endsWith('\n') ? `${content}${marker}\n` : `${content}\n${marker}\n`;
}

async function backupRelative(relativePath) {
  const absolutePath = join(projectRoot, relativePath);
  if (await pathExists(absolutePath)) {
    backups.set(relativePath, await readFile(absolutePath));
  } else {
    backups.set(relativePath, null);
  }
}

async function restoreRelative(relativePath) {
  if (!backups.has(relativePath)) {
    return;
  }

  const absolutePath = join(projectRoot, relativePath);
  const original = backups.get(relativePath);

  if (original === null) {
    await rm(absolutePath, { recursive: true, force: true });
  } else {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, original);
  }
}

async function loadJson(relativePath) {
  const absolutePath = join(projectRoot, relativePath);
  return JSON.parse(await readFile(absolutePath, 'utf8'));
}

function getManifestPatchedFiles(manifest) {
  const files = new Set();

  if (!manifest?.patches) {
    return files;
  }

  for (const patch of manifest.patches) {
    for (const file of patch.filesAffected) {
      files.add(file);
    }
  }

  return files;
}

function parseStatusEntries(output) {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const payload = line.slice(3);
      const [originalPath, currentPath] = payload.includes(' -> ')
        ? payload.split(' -> ')
        : [undefined, payload];

      return {
        code: line.slice(0, 2),
        currentPath,
        originalPath,
      };
    });
}

function collectIntroducedPaths(currentEntries, initialEntries) {
  const initialPaths = new Set(
    initialEntries.flatMap((entry) =>
      entry.originalPath ? [entry.currentPath, entry.originalPath] : [entry.currentPath]
    )
  );

  return currentEntries.map((entry) => entry.currentPath).filter((path) => !initialPaths.has(path));
}

function selectCandidateFromList(candidateFiles, manifestFiles, engineDir) {
  for (const file of candidateFiles) {
    if (manifestFiles.has(file)) {
      continue;
    }

    const exists = runCapture('git', ['-C', engineDir, 'ls-files', '--error-unmatch', '--', file], {
      allowFailure: true,
    });
    if (exists.exitCode !== 0) {
      continue;
    }

    const status = runCapture('git', ['-C', engineDir, 'status', '--short', '--', file], {
      allowFailure: true,
    });
    if (status.stdout.trim().length > 0) {
      continue;
    }

    return file;
  }

  return null;
}

function discoverTargetFile(engineDir, manifestFiles) {
  const preferredCandidates = [
    'browser/base/content/browser.js',
    'browser/base/content/browser-init.js',
    'browser/components/preferences/main.js',
    'toolkit/modules/AppConstants.sys.mjs',
    'toolkit/components/printing/content/print.js',
  ];

  const preferred = selectCandidateFromList(preferredCandidates, manifestFiles, engineDir);
  if (preferred) {
    return preferred;
  }

  const trackedFiles = runCapture('git', ['-C', engineDir, 'ls-files']);
  const fallback = trackedFiles.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /^(browser|toolkit)\//.test(file))
    .filter((file) => /\.(js|mjs|txt)$/i.test(file))
    .find((file) => !manifestFiles.has(file));

  if (!fallback) {
    throw new Error(
      'Unable to find a clean tracked Firefox source file outside the current patch manifest. Set FIREFORGE_FULL_TARGET_FILE explicitly.'
    );
  }

  const status = runCapture('git', ['-C', engineDir, 'status', '--short', '--', fallback], {
    allowFailure: true,
  });
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `Auto-selected fallback target ${fallback} already has local changes. Set FIREFORGE_FULL_TARGET_FILE explicitly.`
    );
  }

  return fallback;
}

async function copyPatchToArtifacts(filename) {
  const source = join(projectRoot, 'patches', filename);
  const destination = join(artifactDir, 'patches', filename);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return destination;
}

async function writeNotesTemplate() {
  const commandSummary = report.commands
    .map((entry) => `- ${entry.label}: ${entry.exitCode} (${entry.durationMs} ms)`)
    .join('\n');

  await writeArtifact(
    'notes-template.md',
    `# Full Firefox Integration Notes\n\n` +
      `- Project root: ${projectRoot}\n` +
      `- Build mode: ${buildMode}\n` +
      `- Target file: ${report.targetFile ?? 'not selected'}\n` +
      `- Created patch: ${report.patchFilename ?? 'none'}\n` +
      `- Artifacts: ${artifactDir}\n\n` +
      `## Command Timings\n\n${commandSummary || '- No commands recorded'}\n\n` +
      `## Observations To Record\n\n` +
      `- Unexpected bootstrap or build warnings:\n` +
      `- Any file paths that needed a custom target override:\n` +
      `- Any import or recovery behavior that differed from the synthetic workflow tests:\n` +
      `- Any Firefox-specific constraints that should become new fixture rules:\n\n` +
      `## Candidate Follow-Ups\n\n` +
      `- Add or expand a medium-tier fixture for:\n` +
      `- Update the synthetic Firefox harness to mirror:\n` +
      `- Extend this full-tree runner with:\n`
  );
}

async function main() {
  await ensureArtifactDirectory();

  for (const [label, targetPath] of requiredPaths) {
    await requirePath(label, targetPath);
  }

  const config = await loadJson('fireforge.json');
  const manifest = await loadJson('patches/patches.json').catch(() => null);
  const manifestFiles = getManifestPatchedFiles(manifest);

  const targetFile = targetFileOverride ?? discoverTargetFile(engineDir, manifestFiles);
  report.targetFile = targetFile;

  if (manifestFiles.has(targetFile)) {
    throw new Error(
      `Target file ${targetFile} is already managed by the current patch manifest. Choose another file with FIREFORGE_FULL_TARGET_FILE.`
    );
  }

  const targetStatus = runCapture('git', ['-C', engineDir, 'status', '--short', '--', targetFile], {
    allowFailure: true,
  });
  if (targetStatus.stdout.trim().length > 0) {
    throw new Error(
      `Target file ${targetFile} already has local changes. Choose a clean file with FIREFORGE_FULL_TARGET_FILE.`
    );
  }

  for (const relativePath of [...setupManagedFiles, targetFile]) {
    await backupRelative(relativePath);
  }

  report.observations.initialTargetStatus = targetStatus.stdout.trim();
  report.observations.initialGitStatus = runCapture('git', [
    '-C',
    engineDir,
    'status',
    '--short',
  ]).stdout;
  initialEngineStatusEntries = parseStatusEntries(
    runCapture('git', ['-C', engineDir, 'status', '--porcelain=v1', '--untracked-files=all']).stdout
  );

  for (const entry of initialEngineStatusEntries) {
    const absPath = join(engineDir, entry.currentPath);
    try {
      initialDirtyContent.set(entry.currentPath, await readFile(absPath));
    } catch {
      initialDirtyContent.set(entry.currentPath, null);
    }
  }

  const setupArgs = [
    'setup',
    '--force',
    '--name',
    config.name,
    '--vendor',
    config.vendor,
    '--app-id',
    config.appId,
    '--binary-name',
    config.binaryName,
    '--firefox-version',
    config.firefox.version,
    '--product',
    config.firefox.product,
  ];
  if (config.license) {
    setupArgs.push('--license', config.license);
  }

  const targetAbsolutePath = join(engineDir, targetFile);
  const originalTargetContent = await readFile(targetAbsolutePath, 'utf8');
  const markerId = artifactStamp;
  const patchMarker = commentMarkerFor(targetFile, markerId, 'patch');
  const dirtyMarker = commentMarkerFor(targetFile, markerId, 'dirty');

  if (skipSetup) {
    report.observations.setup = 'Skipped because FIREFORGE_FULL_SKIP_SETUP=1';
  } else {
    await runFireforge('setup', setupArgs);
  }
  await runFireforge('doctor', ['doctor']);
  await runFireforge('status-before', ['status']);
  await runFireforge('bootstrap', ['bootstrap']);
  await runFireforge('build', buildMode === 'full' ? ['build'] : ['build', '--ui']);

  await writeFile(targetAbsolutePath, appendMarker(originalTargetContent, patchMarker), 'utf8');
  await writeArtifact(
    'snapshots/target-after-edit.txt',
    await readFile(targetAbsolutePath, 'utf8')
  );

  const manifestBefore = await loadJson('patches/patches.json').catch(() => ({ patches: [] }));
  const patchFilesBefore = new Set((manifestBefore.patches ?? []).map((patch) => patch.filename));

  await runFireforge('export', [
    'export',
    targetFile,
    '--name',
    `full-suite-${markerId}`,
    '--category',
    'infra',
    '--description',
    'Opt-in full Firefox integration workflow patch',
  ]);

  const manifestAfterExport = await loadJson('patches/patches.json');
  const createdPatch = (manifestAfterExport.patches ?? []).find(
    (patch) => !patchFilesBefore.has(patch.filename)
  );
  if (!createdPatch) {
    throw new Error('The full-tree suite could not determine which patch file was created.');
  }

  createdPatchInfo.filename = createdPatch.filename;
  report.patchFilename = createdPatch.filename;
  await copyPatchToArtifacts(createdPatch.filename);

  runCapture('git', ['-C', engineDir, 'checkout', '--', targetFile]);
  await runFireforge('import-roundtrip', ['import']);

  const importedContent = await readFile(targetAbsolutePath, 'utf8');
  if (!importedContent.includes(patchMarker)) {
    throw new Error(`Expected imported content for ${targetFile} to include ${patchMarker}`);
  }
  await writeArtifact('snapshots/target-after-import.txt', importedContent);

  await writeFile(targetAbsolutePath, appendMarker(originalTargetContent, dirtyMarker), 'utf8');
  const dirtyImport = await runFireforge('import-dirty-guard', ['import'], {
    expectFailure: true,
    requiredText: 'Uncommitted changes in patch-touched files',
  });
  report.observations.dirtyGuardPreview = dirtyImport.preview;

  await runFireforge('discard-target', ['discard', targetFile, '--force']);
  await runFireforge('import-after-discard', ['import']);

  const recoveredContent = await readFile(targetAbsolutePath, 'utf8');
  if (!recoveredContent.includes(patchMarker)) {
    throw new Error(`Expected recovered content for ${targetFile} to include ${patchMarker}`);
  }
  await writeArtifact('snapshots/target-after-recovery-import.txt', recoveredContent);
  await runFireforge('status-after', ['status']);

  report.observations.finalGitStatus = runCapture('git', [
    '-C',
    engineDir,
    'status',
    '--short',
  ]).stdout;
  report.observations.patchMarker = patchMarker;
  report.observations.dirtyMarker = dirtyMarker;
}

let mainError = null;

try {
  await main();
} catch (error) {
  mainError = toError(error);
  report.failure = {
    message: mainError.message,
    stack: mainError.stack,
  };
} finally {
  try {
    if (report.targetFile) {
      const currentEngineStatusEntries = parseStatusEntries(
        runCapture('git', ['-C', engineDir, 'status', '--porcelain=v1', '--untracked-files=all'], {
          allowFailure: true,
        }).stdout
      );
      const introducedPaths = collectIntroducedPaths(
        currentEngineStatusEntries,
        initialEngineStatusEntries
      );

      for (const file of introducedPaths) {
        const result = runCapture(
          process.execPath,
          getFireforgeArgs(['discard', file, '--force']),
          {
            allowFailure: true,
          }
        );
        if (result.exitCode === 0) {
          report.cleanup.actions.push(`Discarded introduced engine path ${file}`);
        } else {
          report.cleanup.errors.push(
            `Failed to discard introduced engine path ${file} (exit ${result.exitCode})`
          );
        }
      }

      const initialDirtyPaths = new Set(initialEngineStatusEntries.map((e) => e.currentPath));
      const introducedSet = new Set(introducedPaths);
      for (const entry of currentEngineStatusEntries) {
        if (introducedSet.has(entry.currentPath)) {
          continue;
        }
        if (!initialDirtyPaths.has(entry.currentPath)) {
          continue;
        }
        const savedContent = initialDirtyContent.get(entry.currentPath);
        if (savedContent === undefined) {
          continue;
        }
        const absPath = join(engineDir, entry.currentPath);
        try {
          if (savedContent === null) {
            await rm(absPath, { recursive: true, force: true });
          } else {
            await writeFile(absPath, savedContent);
          }
          report.cleanup.actions.push(`Restored initially-dirty engine path ${entry.currentPath}`);
        } catch (error) {
          const msg = toError(error).message;
          report.cleanup.errors.push(
            `Failed to restore initially-dirty engine path ${entry.currentPath}: ${msg}`
          );
        }
      }
    }

    if (!keepPatch && createdPatchInfo.filename) {
      await rm(join(projectRoot, 'patches', createdPatchInfo.filename), { force: true });
      report.cleanup.actions.push(`Removed temporary patch ${createdPatchInfo.filename}`);
    }

    const restoreTargets = keepPatch
      ? [
          ...setupManagedFiles.filter((relativePath) => relativePath !== 'patches/patches.json'),
          report.targetFile,
        ]
      : [...setupManagedFiles, report.targetFile];

    for (const relativePath of restoreTargets) {
      if (!relativePath) {
        continue;
      }
      await restoreRelative(relativePath);
      report.cleanup.actions.push(`Restored ${relativePath}`);
    }
  } catch (error) {
    const message = toError(error).message;
    report.cleanup.errors.push(message);
    if (!mainError) {
      mainError = toError(error);
      report.failure = {
        message,
        stack: mainError.stack,
      };
    }
  }

  report.completedAt = new Date().toISOString();
  report.success = mainError === null;

  await writeArtifact('report.json', `${JSON.stringify(report, null, 2)}\n`);
  await writeNotesTemplate();

  process.stdout.write(`\nFull Firefox integration artifacts: ${artifactDir}\n`);
}

if (mainError) {
  throw mainError;
}
