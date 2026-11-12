// SPDX-License-Identifier: EUPL-1.2
/**
 * The edits that change which components a project has: create, override,
 * rename and remove. Each edits `components/`, `furnace.json`, the typing
 * files and the component's tests in one transaction. None touches a
 * workspace: the next deployment adds what a component gained and takes
 * away what it lost, since the deployment record knows what was deployed.
 */
import { join, posix } from 'node:path';

import { resolveRevision } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, pathInfo, readBytes } from '../kernel/fs.js';
import { isRecord, type JsonObject } from '../kernel/json.js';
import type { TrackedFiles } from '../project/index.js';
import {
  componentDir,
  type ComponentKind,
  editFurnaceConfig,
  findComponent,
  ftlDir,
  ftlResourceDir,
  type FurnaceConfig,
  type FurnaceProject,
  loadFurnaceConfig,
  section,
  tagProblem,
  WIDGETS_DIR,
} from './config.js';
import {
  type FurnaceWorkspace,
  overrideDeploys,
  upstreamDirectory,
  upstreamFiles,
} from './deploy.js';
import { type EditOptions, editProject, type EditResult } from './edit.js';
import {
  componentSources,
  removeTestScaffold,
  renameTag,
  type ScaffoldProject,
  TEST_STYLES,
  testScaffold,
  type TestStyle,
  writeTestScaffold,
} from './scaffold.js';
import { writeTypingFiles } from './typing.js';

function refuse(message: string, hint?: string): FireForgeError {
  return new FireForgeError('furnace-invalid-name', message, {
    exitCode: ExitCode.INVALID_ARGUMENT,
    ...(hint === undefined ? {} : { hint }),
  });
}

function scaffoldProject(project: FurnaceProject): ScaffoldProject {
  return {
    moduleDir: `browser/modules/${project.config.binaryName}`,
    license: project.config.license,
  };
}

/** Refuses a name that is taken in `furnace.json` or in `components/`. */
async function assertFree(
  project: FurnaceProject,
  config: FurnaceConfig,
  name: string
): Promise<void> {
  if (name in config.custom || name in config.overrides) {
    throw refuse(`furnace.json already has a component "${name}".`);
  }
  for (const kind of ['custom', 'override'] as const) {
    if ((await pathInfo(componentDir(project, kind, name))) !== undefined) {
      throw refuse(
        `${componentDir(project, kind, name)} already exists.`,
        'Move it away or pick another name.'
      );
    }
  }
}

function assertCustomName(config: FurnaceConfig, name: string): void {
  const problem = tagProblem(name);
  if (problem !== undefined) throw refuse(problem);
  if (!name.startsWith(config.componentPrefix)) {
    throw refuse(
      `"${name}" does not start with the component prefix "${config.componentPrefix}".`,
      'Pick a name with the prefix, or change componentPrefix in furnace.json.'
    );
  }
}

/** How {@link createComponent} shapes the new component. */
export interface CreateOptions extends EditOptions {
  description?: string;
  /** Give it its own Fluent file. */
  localized?: boolean;
  /** Share an existing feature Fluent file instead (implies localized). */
  sharedFtl?: string;
  /** List it in customElements.js (default true). */
  register?: boolean;
  /** Components it renders inside its template. */
  composes?: string[];
  /** Scaffold a test in this harness. */
  tests?: TestStyle;
}

/**
 * Creates a custom component: its module and stylesheet (and `.ftl` when it
 * is localized on its own) in `components/custom/<name>/`, its `furnace.json`
 * entry, an optional test with its manifest entry, and the typing files.
 *
 * @param project - The project
 * @param tracked - The project's tracked engine files, for the test
 * @param name - The element's tag
 * @param options - See {@link CreateOptions}
 * @throws `furnace-invalid-name` (exit code 8) for a name that is not a tag, lacks the prefix, or is taken
 */
export async function createComponent(
  project: FurnaceProject,
  tracked: TrackedFiles,
  name: string,
  options: CreateOptions = {}
): Promise<EditResult> {
  return editProject(project, `creating component ${name}`, options, async (tx) => {
    const config = await loadFurnaceConfig(project);
    assertCustomName(config, name);
    await assertFree(project, config, name);
    const localized = options.localized === true || options.sharedFtl !== undefined;
    const resource = ftlResourceDir(config);
    const ftl = !localized
      ? undefined
      : (options.sharedFtl ?? (resource === undefined ? `${name}.ftl` : `${resource}/${name}.ftl`));
    const dir = componentDir(project, 'custom', name);
    const sources = componentSources({
      name,
      description: options.description ?? '',
      license: project.config.license,
      ftl,
      ownFtl: localized && options.sharedFtl === undefined,
    });
    for (const [file, content] of sources) await tx.write(join(dir, file), content);
    const next = await editFurnaceConfig(project, tx, (document) => {
      section(document, 'custom')[name] = {
        description: options.description ?? '',
        targetPath: `${WIDGETS_DIR}/${name}`,
        register: options.register ?? true,
        localized,
        ...(options.sharedFtl === undefined ? {} : { sharedFtl: options.sharedFtl }),
        ...(options.composes === undefined || options.composes.length === 0
          ? {}
          : { composes: options.composes }),
      };
    });
    const notes =
      options.tests === undefined
        ? []
        : await writeTestScaffold(
            tracked,
            tx,
            testScaffold(name, project.config.binaryName, options.tests, project.config.license),
            scaffoldProject(project)
          );
    await writeTypingFiles(project, next, tracked, tx);
    return notes;
  });
}

/** How {@link overrideComponent} copies the stock component. */
export interface OverrideOptions extends EditOptions {
  description?: string;
  /** Copy and deploy only the stylesheets. */
  cssOnly?: boolean;
  /** Engine directory of the stock component (default `toolkit/content/widgets/<name>`). */
  from?: string;
}

/**
 * Starts overriding a stock component: copies its upstream files (from the
 * engine's `HEAD`) into `components/overrides/<name>/` and records the
 * override, with the Firefox version and commit it was taken from.
 *
 * @param project - The project
 * @param tracked - The project's tracked engine files, for the typing files
 * @param workspace - The engine to read the stock component from
 * @param name - The stock component
 * @param options - See {@link OverrideOptions}
 * @throws `furnace-invalid-name` (exit code 8) when the name is taken or upstream has no such component
 */
export async function overrideComponent(
  project: FurnaceProject,
  tracked: TrackedFiles,
  workspace: FurnaceWorkspace,
  name: string,
  options: OverrideOptions = {}
): Promise<EditResult> {
  return editProject(project, `overriding component ${name}`, options, async (tx) => {
    const config = await loadFurnaceConfig(project);
    await assertFree(project, config, name);
    const type = options.cssOnly === true ? 'css-only' : 'full';
    const basePath = options.from ?? `${WIDGETS_DIR}/${name}`;
    const paths = (await upstreamDirectory(workspace, basePath))
      .filter(
        (file) => file !== 'override.json' && overrideDeploys(type, file) && !file.endsWith('.ftl')
      )
      .map((file) => `${basePath}/${file}`);
    if (paths.length === 0) {
      throw refuse(
        `The engine has no stock component files in ${basePath}.`,
        'Name its directory with --from.'
      );
    }
    if (type === 'full') paths.push(`${ftlDir(config)}/${name}.ftl`);
    const dir = componentDir(project, 'override', name);
    for (const [path, content] of await upstreamFiles(workspace, paths)) {
      await tx.write(join(dir, posix.basename(path)), content);
    }
    const commit = await resolveRevision(workspace.engineDir, 'HEAD');
    const next = await editFurnaceConfig(project, tx, (document) => {
      section(document, 'overrides')[name] = {
        type,
        description: options.description ?? '',
        basePath,
        baseVersion: project.config.firefox.version,
        ...(commit === undefined ? {} : { baseCommit: commit }),
      };
      const stock = document['stock'];
      if (Array.isArray(stock)) document['stock'] = stock.filter((entry) => entry !== name);
    });
    await writeTypingFiles(project, next, tracked, tx);
    return [];
  });
}

/** The component's files, refusing anything but plain files. */
async function plainFiles(dir: string, name: string): Promise<string[]> {
  const entries = await listDir(dir);
  const odd = entries.find((entry) => entry.kind !== 'file');
  if (odd !== undefined) {
    throw refuse(
      `components of "${name}" include ${odd.name}, which is not a plain file.`,
      'Move it out of the component directory first.'
    );
  }
  return entries.map((entry) => entry.name);
}

function renamedFile(file: string, from: string, to: string): string {
  return file.startsWith(`${from}.`) || file.startsWith(`${from}-`)
    ? to + file.slice(from.length)
    : file;
}

function renameConfigEntry(
  document: JsonObject,
  kind: ComponentKind,
  from: string,
  to: string
): void {
  const key = kind === 'custom' ? 'custom' : 'overrides';
  const entries = section(document, key);
  const entry = entries[from];
  if (!isRecord(entry)) return;
  const moved: JsonObject = { ...entry };
  if (typeof moved['description'] === 'string')
    moved['description'] = renameTag(moved['description'], from, to);
  if (kind === 'custom' && typeof moved['targetPath'] === 'string') {
    moved['targetPath'] = moved['targetPath'].replace(new RegExp(`(^|/)${from}$`), `$1${to}`);
  }
  entries[from] = undefined;
  entries[to] = moved;
  for (const other of Object.values(section(document, 'custom'))) {
    if (isRecord(other) && Array.isArray(other['composes'])) {
      other['composes'] = other['composes'].map((ref) => (ref === from ? to : ref));
    }
  }
  const exceptions = document['validationExceptions'];
  if (Array.isArray(exceptions)) {
    for (const exception of exceptions) {
      if (isRecord(exception) && exception['component'] === from) exception['component'] = to;
    }
  }
}

/**
 * Renames a component: moves its directory, renames its `<name>.*` and
 * `<name>-*` files, rewrites its tag and class name inside its sources,
 * re-keys its `furnace.json` entry and every reference to it, and moves its
 * tests. The next deployment takes the old name out of the engine.
 *
 * @param project - The project
 * @param tracked - The project's tracked engine files
 * @param from - The current name
 * @param to - The new name
 * @param options - See {@link EditOptions}
 */
export async function renameComponent(
  project: FurnaceProject,
  tracked: TrackedFiles,
  from: string,
  to: string,
  options: EditOptions = {}
): Promise<EditResult> {
  return editProject(project, `renaming component ${from} to ${to}`, options, async (tx) => {
    const config = await loadFurnaceConfig(project);
    const { kind } = findComponent(config, from);
    if (kind === 'custom') assertCustomName(config, to);
    await assertFree(project, config, to);
    const source = componentDir(project, kind, from);
    const target = componentDir(project, kind, to);
    const others = [...Object.keys(config.custom), ...Object.keys(config.overrides)];
    for (const file of await plainFiles(source, from)) {
      const bytes = await readBytes(join(source, file));
      const content = /\.(?:mjs|css|ftl)$/.test(file)
        ? renameTag(bytes.toString('utf8'), from, to, others)
        : bytes;
      await tx.write(join(target, renamedFile(file, from, to)), content);
    }
    await tx.remove(source);
    const next = await editFurnaceConfig(project, tx, (document) => {
      renameConfigEntry(document, kind, from, to);
    });
    const notes: string[] = [];
    for (const style of TEST_STYLES) {
      const old = testScaffold(from, project.config.binaryName, style, project.config.license);
      const test = await tracked.read(old.test.path);
      if (test === undefined) continue;
      await removeTestScaffold(tracked, tx, old);
      const moved = testScaffold(to, project.config.binaryName, style, project.config.license);
      notes.push(
        ...(await writeTestScaffold(
          tracked,
          tx,
          { ...moved, test: { path: moved.test.path, content: renameTag(test, from, to, others) } },
          scaffoldProject(project)
        ))
      );
    }
    await writeTypingFiles(project, next, tracked, tx);
    return notes;
  });
}

/**
 * Removes a component: its directory, its `furnace.json` entry and the
 * validation exceptions recorded for it, its tests, and its typing entries.
 * The next deployment takes it out of the engine.
 *
 * @param project - The project
 * @param tracked - The project's tracked engine files
 * @param name - The component
 * @param options - See {@link EditOptions}
 * @throws `furnace-invalid-name` (exit code 8) when another component composes it
 */
export async function removeComponent(
  project: FurnaceProject,
  tracked: TrackedFiles,
  name: string,
  options: EditOptions = {}
): Promise<EditResult> {
  return editProject(project, `removing component ${name}`, options, async (tx) => {
    const config = await loadFurnaceConfig(project);
    const { kind } = findComponent(config, name);
    const users = Object.entries(config.custom)
      .filter(([, entry]) => entry.composes?.includes(name) === true)
      .map(([user]) => user);
    if (users.length > 0) {
      throw refuse(
        `${users.join(', ')} compose${users.length === 1 ? 's' : ''} "${name}".`,
        'Remove it from their composes first.'
      );
    }
    await tx.remove(componentDir(project, kind, name));
    const next = await editFurnaceConfig(project, tx, (document) => {
      section(document, kind === 'custom' ? 'custom' : 'overrides')[name] = undefined;
      const exceptions = document['validationExceptions'];
      if (Array.isArray(exceptions)) {
        document['validationExceptions'] = exceptions.filter(
          (entry) => !isRecord(entry) || entry['component'] !== name
        );
      }
    });
    for (const style of TEST_STYLES) {
      await removeTestScaffold(
        tracked,
        tx,
        testScaffold(name, project.config.binaryName, style, project.config.license)
      );
    }
    await writeTypingFiles(project, next, tracked, tx);
    return [];
  });
}

/**
 * Brings the generated typing files up to date.
 *
 * @param project - The project
 * @param tracked - The project's tracked engine files
 * @param options - See {@link EditOptions}
 */
export async function updateTypingFiles(
  project: FurnaceProject,
  tracked: TrackedFiles,
  options: EditOptions = {}
): Promise<EditResult> {
  return editProject(project, 'updating the component typing files', options, async (tx) => {
    await writeTypingFiles(project, await loadFurnaceConfig(project), tracked, tx);
    return [];
  });
}
