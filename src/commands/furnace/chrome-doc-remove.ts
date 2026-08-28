// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge furnace chrome-doc remove <name>` — removes the files and
 * registrations created by `furnace chrome-doc create`.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { confirm } from '@clack/prompts';

import { loadConfig } from '../../core/config.js';
import { stdioIsInteractive } from '../../core/destructive.js';
import {
  completeJournalRollback,
  type FurnaceOperationContext,
  runFurnaceMutation,
} from '../../core/furnace-operation.js';
import { assertFurnaceEngineReady } from '../../core/furnace-precondition.js';
import { createRollbackJournal, snapshotDir, snapshotFile } from '../../core/furnace-rollback.js';
import { FurnaceError } from '../../errors/furnace.js';
import { pathExists, readText, removeDir, removeFile, writeText } from '../../utils/fs.js';
import { cancel, info, intro, isCancel, note, outro } from '../../utils/logger.js';
import { buildChromeDocPlan, type ChromeDocPlan, validateChromeDocName } from './chrome-doc.js';

/** Options for `furnace chrome-doc remove`. */
export interface FurnaceChromeDocRemoveOptions {
  /** Skip confirmation. Required for real non-interactive removal. */
  yes?: boolean;
  /** Print the removal plan without writing files. */
  dryRun?: boolean;
}

function removeExactLine(content: string, line: string): string {
  const lines = content.split('\n');
  const filtered = lines.filter((candidate) => candidate !== line);
  return filtered.join('\n').replace(/\n*$/, '\n');
}

async function removeChromeDocJarEntryIfPresent(
  engineDir: string,
  file: string,
  entry: string,
  journal: ReturnType<typeof createRollbackJournal>
): Promise<boolean> {
  const jarPath = join(engineDir, file);
  if (!(await pathExists(jarPath))) {
    throw new FurnaceError(
      `Required jar file ${jarPath} does not exist; cannot remove chrome-doc entry. Check that the fork's engine layout matches the expected browser/ and locales/ tree.`
    );
  }
  const existing = await readText(jarPath);
  if (!existing.includes(entry)) {
    return false;
  }
  await snapshotFile(journal, jarPath);
  await writeText(jarPath, removeExactLine(existing, entry));
  return true;
}

async function removeEmptyDirIfPresent(
  dirPath: string,
  journal: ReturnType<typeof createRollbackJournal>
): Promise<boolean> {
  if (!(await pathExists(dirPath))) return false;
  const entries = await readdir(dirPath);
  if (entries.length > 0) return false;
  await snapshotDir(journal, dirPath);
  await removeDir(dirPath);
  return true;
}

function renderChromeDocRemoveDryRun(name: string, plan: ChromeDocPlan): string {
  const jarLines = plan.jarEntries.map(
    ({ file, entry, present }) =>
      `  engine/${file}: ${present ? 'would remove' : 'not present'} ${entry.trim()}`
  );
  const testLines =
    plan.testDir !== undefined
      ? ['', 'Would remove test directory if present:', `  engine/${plan.testDir}/`]
      : [];
  return [
    `[dry-run] Chrome document "${name}" removal plan`,
    '',
    'Would remove source files if present:',
    ...plan.files.map((f) => `  engine/${f}`),
    ...testLines,
    '',
    'Jar registrations:',
    ...jarLines,
  ].join('\n');
}

async function performChromeDocRemoveMutations(args: {
  projectRoot: string;
  name: string;
  engineDir: string;
  plan: ChromeDocPlan;
  binaryName: string;
  operationContext: FurnaceOperationContext;
}): Promise<{ removedFiles: number; removedJarEntries: number; removedTestDir: boolean }> {
  const journal = createRollbackJournal();
  args.operationContext.registerJournal(journal);
  let removedFiles = 0;
  let removedJarEntries = 0;
  let removedTestDir = false;

  try {
    for (const file of args.plan.files) {
      const filePath = join(args.engineDir, file);
      if (await pathExists(filePath)) {
        await snapshotFile(journal, filePath);
        await removeFile(filePath);
        removedFiles++;
      }
    }

    for (const { file, entry } of args.plan.jarEntries) {
      if (await removeChromeDocJarEntryIfPresent(args.engineDir, file, entry, journal)) {
        removedJarEntries++;
      }
    }

    const testDir = join(
      args.engineDir,
      'browser/base/content/test',
      `${args.binaryName}-xpcshell`,
      args.name
    );
    if (await pathExists(testDir)) {
      await snapshotDir(journal, testDir);
      await removeDir(testDir);
      removedTestDir = true;
    }
    await removeEmptyDirIfPresent(
      join(args.engineDir, 'browser/base/content/test', `${args.binaryName}-xpcshell`),
      journal
    );
  } catch (error: unknown) {
    return await completeJournalRollback(args.operationContext, journal, error, {
      projectRoot: args.projectRoot,
      operation: 'chrome-doc-rollback',
      failureMessage: `Failed to remove chrome-doc "${args.name}"`,
      subject: `chrome-doc "${args.name}"`,
    });
  }

  return { removedFiles, removedJarEntries, removedTestDir };
}

/** Runs `furnace chrome-doc remove <name>`. */
export async function furnaceChromeDocRemoveCommand(
  projectRoot: string,
  name: string,
  options: FurnaceChromeDocRemoveOptions = {}
): Promise<void> {
  intro('Furnace chrome-doc remove');

  validateChromeDocName(name);

  const forgeConfig = await loadConfig(projectRoot);
  const engineDir = join(projectRoot, 'engine');
  await assertFurnaceEngineReady(projectRoot, {
    engineMissingSuffix: ' before removing a chrome-doc.',
  });

  const plan = await buildChromeDocPlan({
    engineDir,
    name,
    withTests: true,
    binaryName: forgeConfig.binaryName,
    includeLocaleEntryWhenWildcard: true,
  });

  if (options.dryRun) {
    note(renderChromeDocRemoveDryRun(name, plan), name);
    outro('Dry run complete');
    return;
  }

  const isInteractive = stdioIsInteractive();
  if (!options.yes && !isInteractive) {
    throw new FurnaceError(
      `Cannot remove chrome-doc "${name}" in non-interactive mode without --yes flag.`,
      name
    );
  }
  if (!options.yes && isInteractive) {
    const confirmed = await confirm({
      message: `Remove chrome document "${name}" and its scaffolded registrations?`,
    });
    if (isCancel(confirmed) || !confirmed) {
      cancel('Remove cancelled');
      return;
    }
  }

  const result = await runFurnaceMutation(projectRoot, 'chrome-doc-rollback', (ctx) =>
    performChromeDocRemoveMutations({
      projectRoot,
      name,
      engineDir,
      plan,
      binaryName: forgeConfig.binaryName,
      operationContext: ctx,
    })
  );

  info(
    `Removed ${result.removedFiles} source file${result.removedFiles === 1 ? '' : 's'} and ` +
      `${result.removedJarEntries} jar registration${result.removedJarEntries === 1 ? '' : 's'} for "${name}".`
  );
  if (result.removedTestDir) {
    info('Removed xpcshell packaging test directory.');
  }
  outro('Chrome document removed');
}
