// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace rename --dry-run`: the plan a rename would carry out, rendered
 * from reads only. A rename edits three engine registration files besides
 * moving the component, and before this none of those edits was visible
 * until it had run.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isComponentSourceFile,
  JAR_MN,
  resolveFtlChromeSubPath,
  resolveFtlDir,
  resolveFtlLocaleJarMnPath,
} from '../../core/furnace-constants.js';
import { hasLocaleFtlJarMnEntry } from '../../core/furnace-registration.js';
import { isTagAlreadyRegistered } from '../../core/furnace-registration-ast.js';
import type { CustomComponentConfig, FurnaceConfig } from '../../types/furnace.js';
import { pathExists, readText } from '../../utils/fs.js';
import { renameComponentFileName, renameTagInDescription } from './rename-helpers.js';

/** Inputs for {@link renderRenamePlan}. */
export interface RenamePlanInput {
  config: FurnaceConfig;
  oldName: string;
  newName: string;
  /** Workspace directory of the component being renamed. */
  oldDir: string;
  /** On-disk directory label: `custom` or `overrides`. */
  componentDirLabel: 'custom' | 'overrides';
  engineDir: string;
  /** Project marker a freshly added registration line would carry. */
  markerComment: string | undefined;
}

/** Plan lines for the workspace move and the furnace.json re-key. */
async function workspaceLines(input: RenamePlanInput): Promise<string[]> {
  const { config, oldName, newName, oldDir, componentDirLabel } = input;
  const lines = [
    `Workspace: components/${componentDirLabel}/${oldName}/ → components/${componentDirLabel}/${newName}/`,
  ];
  const entries = (await readdir(oldDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  for (const fileName of entries) {
    const renamed = renameComponentFileName(fileName, oldName, newName);
    const rewrite = isComponentSourceFile(fileName) ? ' (tag and class references rewritten)' : '';
    lines.push(`  ${fileName}${renamed === fileName ? '' : ` → ${renamed}`}${rewrite}`);
  }
  const entry = config.custom[oldName] ?? config.overrides[oldName];
  lines.push(`furnace.json: "${oldName}" → "${newName}"`);
  if (entry) {
    const description = renameTagInDescription(entry.description, oldName, newName);
    if (description !== entry.description) {
      lines.push(`  description: "${entry.description}" → "${description}"`);
    }
  }
  return lines;
}

/** Plan line for the customElements.js registration. */
async function customElementsLine(input: RenamePlanInput): Promise<string | undefined> {
  const { engineDir, oldName, newName, markerComment } = input;
  const path = join(engineDir, 'toolkit/content/customElements.js');
  if (!(await pathExists(path))) return undefined;
  const content = await readText(path);
  const oldRegistered = isTagAlreadyRegistered(content, oldName);
  if (isTagAlreadyRegistered(content, newName)) {
    return `customElements.js: "${newName}" is already registered${oldRegistered ? `; remove the "${oldName}" entry` : ''}`;
  }
  if (oldRegistered) {
    return `customElements.js: rewrite the "${oldName}" entry in place as "${newName}" (position and marker comments kept)`;
  }
  const marker = markerComment !== undefined ? ` marked // ${markerComment}:` : '';
  return `customElements.js: add a "${newName}" entry${marker}`;
}

/** Plan line for the toolkit/content/jar.mn widget lines. */
async function jarLine(input: RenamePlanInput): Promise<string | undefined> {
  const { engineDir, oldName, newName, oldDir } = input;
  const path = join(engineDir, JAR_MN);
  if (!(await pathExists(path))) return undefined;
  const oldLines = (await readText(path))
    .split('\n')
    .filter((line) => line.includes(`(widgets/${oldName}/`)).length;
  const newFiles = (await readdir(oldDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:mjs|css)$/.test(entry.name))
    .map((entry) => renameComponentFileName(entry.name, oldName, newName))
    .sort();
  return (
    `${JAR_MN}: replace ${oldLines} "${oldName}" line(s) with ` +
    (newFiles.length > 0 ? newFiles.join(', ') : 'none (no .mjs/.css files)')
  );
}

/** Plan lines for the deployed .ftl and its locale jar.mn line. */
async function localeLines(
  input: RenamePlanInput,
  componentConfig: CustomComponentConfig
): Promise<string[]> {
  const { config, engineDir, oldName, newName } = input;
  if (!componentConfig.localized) return [];
  const ftlDir = resolveFtlDir(config.ftlBasePath);
  const lines: string[] = [];
  if (await pathExists(join(engineDir, ftlDir, `${oldName}.ftl`))) {
    lines.push(`${ftlDir}/${oldName}.ftl → ${newName}.ftl`);
  }
  const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
  const localeJarRel = resolveFtlLocaleJarMnPath(ftlDir);
  if (chromeSubPath === undefined || localeJarRel === undefined) return lines;
  const present = await hasLocaleFtlJarMnEntry(engineDir, localeJarRel, oldName, chromeSubPath);
  if (componentConfig.sharedFtl !== undefined) {
    lines.push(
      `${localeJarRel}: no per-component line (sharedFtl: ${componentConfig.sharedFtl})` +
        (present ? `; remove the stale "${oldName}.ftl" line` : '')
    );
  } else {
    lines.push(
      present
        ? `${localeJarRel}: re-point the "${oldName}.ftl" line to "${newName}.ftl"`
        : `${localeJarRel}: no "${oldName}.ftl" line to re-point (left unchanged)`
    );
  }
  return lines;
}

/**
 * Renders the rename plan: workspace file moves, the furnace.json re-key,
 * and, for a custom component, every engine edit the real run would make
 * (registrations only when the component is registered).
 *
 * @param input - See {@link RenamePlanInput}
 * @returns The plan as display lines joined by newlines
 */
export async function renderRenamePlan(input: RenamePlanInput): Promise<string> {
  const lines = await workspaceLines(input);
  const componentConfig = input.config.custom[input.oldName];
  if (!componentConfig || !(await pathExists(input.engineDir))) {
    return lines.join('\n');
  }
  lines.push('Engine:');
  const engineLines = componentConfig.register
    ? [
        await customElementsLine(input),
        await jarLine(input),
        ...(await localeLines(input, componentConfig)),
      ].filter((line): line is string => line !== undefined)
    : ['registrations untouched (register: false)'];
  if (await pathExists(join(input.engineDir, componentConfig.targetPath))) {
    engineLines.push(`remove the stale deployed directory ${componentConfig.targetPath}/`);
  }
  lines.push(...engineLines.map((line) => `  ${line}`));
  lines.push('Test scaffolds named after the old tag are renamed when present.');
  return lines.join('\n');
}
