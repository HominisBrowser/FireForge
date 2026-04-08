// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type {
  CustomComponentConfig,
  DryRunAction,
  OverrideComponentConfig,
  StepError,
} from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { copyFile, ensureDir, pathExists, readText } from '../utils/fs.js';
import { CUSTOM_ELEMENTS_JS, JAR_MN } from './furnace-constants.js';
import { addCustomElementRegistration, addJarMnEntries } from './furnace-registration.js';
import { recordCreatedDir, type RollbackJournal, snapshotFile } from './furnace-rollback.js';

interface DirectoryEntry {
  isFile(): boolean;
  name: string;
}

/** Path to the Fluent localization directory for toolkit global components */
const FTL_DIR = 'toolkit/locales/en-US/toolkit/global';

function isChecksummedComponentFile(name: string): boolean {
  return name.endsWith('.mjs') || name.endsWith('.css') || name.endsWith('.ftl');
}

function isOverrideCopyCandidate(
  entryName: string,
  type: OverrideComponentConfig['type']
): boolean {
  if (entryName === 'override.json') {
    return false;
  }

  if (type === 'css-only') {
    return entryName.endsWith('.css');
  }

  return entryName.endsWith('.mjs') || entryName.endsWith('.css');
}

/** Computes stable checksums for the source files that define a component. */
export async function computeComponentChecksums(
  componentDir: string
): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === 'override.json') continue;
    if (!isChecksummedComponentFile(entry.name)) continue;

    const content = await readText(join(componentDir, entry.name));
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(normalized).digest('hex');
    checksums[entry.name] = hash;
  }

  return checksums;
}

/** Compares current component file checksums against the previously recorded state. */
export async function hasComponentChanged(
  componentDir: string,
  previousChecksums: Record<string, string>
): Promise<boolean> {
  const current = await computeComponentChecksums(componentDir);
  const currentKeys = Object.keys(current);
  const previousKeys = Object.keys(previousChecksums);

  if (currentKeys.length !== previousKeys.length) {
    return true;
  }

  for (const key of currentKeys) {
    if (current[key] !== previousChecksums[key]) {
      return true;
    }
  }

  return false;
}

async function buildCustomDryRunActions(
  name: string,
  componentDir: string,
  engineDir: string,
  config: CustomComponentConfig,
  targetDir: string,
  entries: DirectoryEntry[]
): Promise<DryRunAction[]> {
  const actions: DryRunAction[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.css')) continue;
    actions.push({
      component: name,
      action: 'copy',
      source: join(componentDir, entry.name),
      target: join(targetDir, entry.name),
      description: `Copy ${entry.name} to ${config.targetPath}`,
    });
  }

  if (config.localized) {
    const ftlFile = `${name}.ftl`;
    const ftlSrc = join(componentDir, ftlFile);
    if (await pathExists(ftlSrc)) {
      actions.push({
        component: name,
        action: 'copy-ftl',
        source: ftlSrc,
        target: join(engineDir, FTL_DIR, ftlFile),
        description: `Copy ${ftlFile} to ${FTL_DIR}`,
      });
    }
  }

  if (config.register) {
    actions.push({
      component: name,
      action: 'register-ce',
      description: `Register ${name} in customElements.js (DOMContentLoaded block)`,
    });
  }

  const copiedFileNames = entries
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.css'))
    )
    .map((entry) => entry.name);

  if (copiedFileNames.length > 0) {
    actions.push({
      component: name,
      action: 'register-jar',
      description: `Add ${copiedFileNames.join(', ')} to jar.mn`,
    });
  }

  return actions;
}

/** Applies a custom component into the engine tree and captures registration step errors. */
export async function applyCustomComponent(
  engineDir: string,
  name: string,
  componentDir: string,
  config: CustomComponentConfig,
  dryRun = false,
  rollbackJournal?: RollbackJournal
): Promise<{ affectedPaths: string[]; stepErrors: StepError[]; actions?: DryRunAction[] }> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new FurnaceError(`Invalid component name "${name}": must match /^[a-z][a-z0-9-]*$/`);
  }

  const targetDir = join(engineDir, config.targetPath);
  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });

  if (dryRun) {
    const actions = await buildCustomDryRunActions(
      name,
      componentDir,
      engineDir,
      config,
      targetDir,
      entries
    );
    return { affectedPaths: [], stepErrors: [], actions };
  }

  if (rollbackJournal && !(await pathExists(targetDir))) {
    recordCreatedDir(rollbackJournal, targetDir);
  }
  await ensureDir(targetDir);

  const affectedPaths: string[] = [];
  const stepErrors: StepError[] = [];
  const copiedFileNames: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.css')) continue;

    const src = join(componentDir, entry.name);
    const dest = join(targetDir, entry.name);
    if (rollbackJournal) {
      await snapshotFile(rollbackJournal, dest);
    }
    await copyFile(src, dest);
    affectedPaths.push(relative(engineDir, dest));
    copiedFileNames.push(entry.name);
  }

  if (config.localized) {
    const ftlFile = `${name}.ftl`;
    const ftlSrc = join(componentDir, ftlFile);
    if (await pathExists(ftlSrc)) {
      const ftlDest = join(engineDir, FTL_DIR, ftlFile);
      if (rollbackJournal) {
        await snapshotFile(rollbackJournal, ftlDest);
      }
      await copyFile(ftlSrc, ftlDest);
      affectedPaths.push(relative(engineDir, ftlDest));
    }
  }

  if (config.register) {
    try {
      const modulePath = `chrome://global/content/elements/${name}.mjs`;
      if (rollbackJournal) {
        await snapshotFile(rollbackJournal, join(engineDir, CUSTOM_ELEMENTS_JS));
      }
      await addCustomElementRegistration(engineDir, name, modulePath);
      affectedPaths.push(CUSTOM_ELEMENTS_JS);
    } catch (error: unknown) {
      stepErrors.push({
        step: 'customElements.js registration',
        error: toError(error).message,
      });
    }
  }

  if (copiedFileNames.length > 0) {
    try {
      if (rollbackJournal) {
        await snapshotFile(rollbackJournal, join(engineDir, JAR_MN));
      }
      await addJarMnEntries(engineDir, name, copiedFileNames);
      affectedPaths.push(JAR_MN);
    } catch (error: unknown) {
      stepErrors.push({
        step: 'jar.mn registration',
        error: toError(error).message,
      });
    }
  }

  return { affectedPaths, stepErrors };
}

/** Applies an override component by copying its matching files onto the engine tree. */
export async function applyOverrideComponent(
  engineDir: string,
  name: string,
  componentDir: string,
  config: OverrideComponentConfig,
  dryRun = false,
  rollbackJournal?: RollbackJournal
): Promise<{ affectedPaths: string[]; actions?: DryRunAction[] }> {
  const targetDir = join(engineDir, config.basePath);

  if (!(await pathExists(targetDir))) {
    throw new FurnaceError(`Override target path not found in engine: ${config.basePath}`, name);
  }

  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });

  if (dryRun) {
    const actions = entries
      .filter((entry) => entry.isFile() && isOverrideCopyCandidate(entry.name, config.type))
      .map<DryRunAction>((entry) => ({
        component: name,
        action: 'copy',
        source: join(componentDir, entry.name),
        target: join(targetDir, entry.name),
        description: `Override ${entry.name} in ${config.basePath}`,
      }));

    if (actions.length === 0) {
      throw new FurnaceError(`No matching files found in override directory for "${name}"`, name);
    }

    return { affectedPaths: [], actions };
  }

  const affectedPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isOverrideCopyCandidate(entry.name, config.type)) {
      continue;
    }

    const src = join(componentDir, entry.name);
    const dest = join(targetDir, entry.name);
    if (rollbackJournal) {
      await snapshotFile(rollbackJournal, dest);
    }
    await copyFile(src, dest);
    affectedPaths.push(relative(engineDir, dest));
  }

  if (affectedPaths.length === 0) {
    throw new FurnaceError(`No matching files found in override directory for "${name}"`, name);
  }

  return { affectedPaths };
}

/** Extracts per-component checksums from the flattened state-file checksum map. */
export function extractComponentChecksums(
  allChecksums: Record<string, string> | undefined,
  type: string,
  name: string
): Record<string, string> {
  if (!allChecksums) return {};

  const prefix = `${type}/${name}/`;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(allChecksums)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }

  return result;
}

/** Prefixes component checksums so they can be stored in the flattened state format. */
export function prefixChecksums(
  checksums: Record<string, string>,
  type: string,
  name: string
): Record<string, string> {
  const prefix = `${type}/${name}/`;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(checksums)) {
    result[`${prefix}${key}`] = value;
  }

  return result;
}
