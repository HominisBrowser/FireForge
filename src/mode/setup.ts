// SPDX-License-Identifier: EUPL-1.2
/**
 * Creating a project: `fireforge.json`, the mozconfig templates, the
 * license text and the ignore rules, in either mode. A source-mode project
 * pins the pristine commit of its Firefox, so creating one downloads and
 * imports that Firefox when the host does not have it yet.
 */
import { join } from 'node:path';

import { packageRoot } from '../cli/version.js';
import {
  CONFIG_FILE,
  configSchema,
  type FirefoxProduct,
  type PROJECT_LICENSES,
  type ProjectMode,
} from '../config/index.js';
import { ensurePristine } from '../engine/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists, listDir, readText, readTextIfExists, writeFile } from '../kernel/fs.js';
import { stringifyJson } from '../kernel/json.js';
import { type Environment, hostPaths } from '../project/index.js';
import { completedAttributes } from '../source/index.js';

/** What a new project is. */
export interface ProjectSpec {
  name: string;
  vendor: string;
  appId: string;
  binaryName: string;
  firefoxVersion: string;
  product: FirefoxProduct;
  license: (typeof PROJECT_LICENSES)[number];
  mode: ProjectMode;
}

const SOURCE_ROOT = 'src';
const METADATA_ROOT = '.fireforge-sources';

/** Adds the lines an ignore file lacks, keeping what it has. */
async function ignore(root: string, entries: readonly string[]): Promise<void> {
  const path = join(root, '.gitignore');
  const current = (await readTextIfExists(path)) ?? '';
  const present = new Set(current.split('\n').map((line) => line.trim().replace(/\/$/, '')));
  const missing = entries.filter((entry) => !present.has(entry.replace(/\/$/, '')));
  if (missing.length === 0) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${current}${separator}${missing.join('\n')}\n`);
}

/**
 * Refuses a directory that already holds a project: setup only ever creates one.
 *
 * @param root - The directory
 * @throws `project-exists` (exit code 2)
 */
export async function refuseExistingProject(root: string): Promise<void> {
  const configPath = join(root, CONFIG_FILE);
  if (!(await exists(configPath))) return;
  throw new FireForgeError('project-exists', `${configPath} already exists.`, {
    exitCode: ExitCode.CONFIG_ERROR,
    hint: 'Change its settings with "fireforge config set", or run setup in a new directory.',
  });
}

/**
 * Writes a new project into a directory. Files that exist are kept; a
 * directory that already holds a project is refused.
 *
 * @param root - The project directory
 * @param spec - See {@link ProjectSpec}
 * @param options - `env` locates the host state; `onProgress` receives download progress
 * @returns The project-relative files written
 * @throws `project-exists` (exit code 2), `config-invalid` naming the value
 *   at fault, and in source mode the download errors
 */
export async function createProject(
  root: string,
  spec: ProjectSpec,
  options: { env?: Environment; onProgress?: (message: string) => void } = {}
): Promise<string[]> {
  await refuseExistingProject(root);
  const firefox = { version: spec.firefoxVersion, product: spec.product };
  const identity = {
    name: spec.name,
    vendor: spec.vendor,
    appId: spec.appId,
    binaryName: spec.binaryName,
    license: spec.license,
  };
  const pin = configSchema.parse(
    { ...identity, firefox },
    { source: 'the new project', code: 'config-invalid', exitCode: ExitCode.INVALID_ARGUMENT }
  ).firefox;
  const source =
    spec.mode === 'source'
      ? {
          mode: 'source',
          source: {
            root: SOURCE_ROOT,
            metadataRoot: METADATA_ROOT,
            pristineCommit: (
              await ensurePristine(
                hostPaths(options.env),
                pin,
                options.onProgress === undefined ? {} : { onProgress: options.onProgress }
              )
            ).commit,
          },
        }
      : {};
  const written: string[] = [];
  const write = async (file: string, content: string): Promise<void> => {
    if (await exists(join(root, file))) return;
    await writeFile(join(root, file), content);
    written.push(file);
  };
  await write(CONFIG_FILE, stringifyJson({ ...identity, ...source, firefox }));
  const templates = join(await packageRoot(), 'templates');
  for (const entry of await listDir(join(templates, 'configs'))) {
    await write(`configs/${entry.name}`, await readText(join(templates, 'configs', entry.name)));
  }
  const license = await readTextIfExists(join(templates, 'licenses', `${spec.license}.md`));
  if (license !== undefined) {
    // Only the 0BSD text names its holder.
    await write(
      'LICENSE',
      spec.license === '0BSD'
        ? license
            .replaceAll('[year]', String(new Date().getFullYear()))
            .replaceAll('[fullname]', spec.vendor)
        : license
    );
  }
  if (spec.mode === 'source') {
    await write(`${SOURCE_ROOT}/.gitattributes`, completedAttributes(undefined) ?? '');
  }
  await ignore(root, spec.mode === 'source' ? ['.fireforge/'] : ['engine/', '.fireforge/']);
  return written;
}
