// SPDX-License-Identifier: EUPL-1.2
/**
 * Build-manifest registration: which manifest an engine file belongs in, as
 * a function of its path, and the edit that puts it there. Parsing and
 * editing the manifests is `mozbuild`'s; this file is the policy, and the
 * one place that says where a test, a test manifest, a chrome file or a
 * custom element file is registered.
 */
import { posix } from 'node:path';

import { usageError } from '../cli/command.js';
import { FireForgeError } from '../kernel/errors.js';
import { escapeRegExp } from '../kernel/text.js';
import {
  addTest,
  addToMozBuildList,
  findJarEntries,
  findMozBuildLists,
  insertJarEntry,
  type MozBuildList,
  mozBuildTestManifests,
  type NewJarEntry,
  type NewTest,
  newTestManifest,
  parseMozBuild,
  type Placement,
  TEST_MANIFEST_VARIABLES,
  testManifestFlavor,
} from '../mozbuild/index.js';
import { type License, licenseHeader, type TrackedFiles } from '../project/index.js';
import { EditSession, type Plan, type PlanStep } from './files.js';

/** What to register and where the fork keeps its modules. */
export interface RegisterRequest {
  /** Engine-relative path of the file. */
  path: string;
  /** Engine-relative directory of the fork's JS modules, such as `browser/modules/<binaryName>`. */
  moduleDir: string;
  /** The header of a manifest the plan creates. */
  license: License;
  /** Place the entry after the one this names (jar.mn and test manifests only). */
  after?: string;
  /** Create a missing moz.build or test manifest and wire it into its parents. */
  createManifest?: boolean;
  /** Refuse a file that does not exist. */
  mustExist?: boolean;
  /** For a test: the manifest it goes in, by file name, when not the directory's default. */
  testManifest?: string;
  /** For a test whose manifest the plan creates: the keys of its `[DEFAULT]` section. */
  manifestDefaults?: NewTest['keys'];
}

/** A registration plan. */
export interface RegisterPlan extends Plan {
  /** The manifest that holds the entry. */
  manifest: string;
  /** The entry's text as it reads in the manifest. */
  entry: string;
  /** The entry the new one follows, when the manifest placed it after one. */
  previous?: string | undefined;
  /** `after` named no entry, so the entry went in sort order. */
  afterFallback?: boolean | undefined;
}

/** A jar.mn entry and the layout of the manifest it goes in. */
export interface JarTarget {
  kind: 'jar';
  manifest: string;
  entry: NewJarEntry;
  /** Other targets that already count as this registration. */
  aliases?: string[];
  indent: string;
  minGap: number;
}

interface ListTarget {
  kind: 'list';
  manifest: string;
  /** The variables the value may sit in; the first is created when none exists. */
  variables: string[];
  value: string;
}

interface TestTarget {
  kind: 'test';
  manifest: string;
  name: string;
}

/** A test manifest, registered in the moz.build above it that lists its flavour. */
interface ManifestTarget {
  kind: 'manifest';
  path: string;
  variable: string;
}

type Target = JarTarget | ListTarget | TestTarget | ManifestTarget;

/**
 * The jar.mn entry of a chrome file packaged by `browser/base/jar.mn`.
 *
 * @param target - The path in the jar, such as `content/browser/panel.js`
 * @param source - The source, relative to `browser/base`
 */
export function browserJarTarget(target: string, source: string): JarTarget {
  return {
    kind: 'jar',
    manifest: 'browser/base/jar.mn',
    entry: { target, source },
    indent: '        ',
    minGap: 4,
  };
}

/** A jar.mn entry: the path in the jar and its source. */
export interface JarFile {
  target: string;
  source: string;
}

/**
 * The jar.mn entry of a custom element file, packaged by
 * `toolkit/content/jar.mn` under `chrome://global/content/elements/`.
 *
 * @param sourceDir - The file's directory, relative to `toolkit/content`
 * @param file - The file name
 */
export function elementJarEntry(sourceDir: string, file: string): JarFile {
  return { target: `content/global/elements/${file}`, source: `${sourceDir}/${file}` };
}

/** The test manifest a test file goes in by default, by its name. */
function defaultTestManifest(name: string): string | undefined {
  if (/^browser_.+\.js$/.test(name)) return 'browser.toml';
  if (/^test_.+\.js$/.test(name)) return 'xpcshell.toml';
  if (/^test_.+\.(?:x?html)$/.test(name)) return 'mochitest.toml';
  return undefined;
}

/**
 * The manifest entry a path calls for, or undefined when the path is not
 * one FireForge knows how to register.
 */
function classify(path: string, moduleDir: string, testManifest?: string): Target | undefined {
  let match: RegExpExecArray | null;
  if ((match = /^browser\/themes\/shared\/(.+)\.css$/.exec(path))) {
    const name = match[1] ?? '';
    return {
      kind: 'jar',
      manifest: 'browser/themes/shared/jar.inc.mn',
      entry: { target: `skin/classic/browser/${name}.css`, source: `../shared/${name}.css` },
      aliases: [`content/browser/${name}.css`],
      indent: '  ',
      minGap: 4,
    };
  }
  if (
    (match =
      /^browser\/base\/content\/(?!.+\.inc\.xhtml$)(?!test\/)(.+\.(?:js|mjs|xhtml|css))$/.exec(
        path
      ))
  ) {
    const file = match[1] ?? '';
    return browserJarTarget(`content/browser/${file}`, `content/${file}`);
  }
  const flavor = testManifestFlavor(path);
  if (flavor !== undefined) {
    const variable = Object.keys(TEST_MANIFEST_VARIABLES).find(
      (name) => TEST_MANIFEST_VARIABLES[name] === flavor
    );
    if (variable !== undefined) return { kind: 'manifest', path, variable };
  }
  const module = new RegExp(`^${escapeRegExp(moduleDir)}/(.+\\.sys\\.mjs)$`).exec(path);
  if (module) {
    return {
      kind: 'list',
      manifest: `${moduleDir}/moz.build`,
      variables: [`EXTRA_JS_MODULES.${posix.basename(moduleDir)}`, 'EXTRA_JS_MODULES'],
      value: module[1] ?? '',
    };
  }
  if ((match = /^toolkit\/content\/widgets\/([^/]+)\/(.+\.(?:mjs|css))$/.exec(path))) {
    const [, tag = '', file = ''] = match;
    return {
      kind: 'jar',
      manifest: 'toolkit/content/jar.mn',
      entry: elementJarEntry(`widgets/${tag}`, file),
      indent: '   ',
      minGap: 2,
    };
  }
  const name = posix.basename(path);
  const manifest = testManifest ?? defaultTestManifest(name);
  if (manifest !== undefined && path.includes('/')) {
    return { kind: 'test', manifest: `${posix.dirname(path)}/${manifest}`, name };
  }
  return undefined;
}

/** Guidance for a path that has no entry of its own, or undefined when none applies. */
function adviceFor(path: string): string | undefined {
  if (path.endsWith('.ftl')) {
    return 'Locale files are found by jar.mn globs and need no registration.';
  }
  if (/^browser\/base\/content\/.+\.inc\.xhtml$/.test(path)) {
    return (
      'An .inc.xhtml fragment is pulled in by #include from a registered chrome document and has ' +
      'no jar.mn entry of its own. Run "fireforge wire <name> --dom <path>" to add the #include.'
    );
  }
  return undefined;
}

function unknownPath(path: string, moduleDir: string): FireForgeError {
  return usageError(
    adviceFor(path) ??
      `Unknown file pattern: "${path}". Supported patterns:\n` +
        '  browser/themes/shared/*.css\n' +
        '  browser/base/content/*.{js,mjs,xhtml,css}\n' +
        `  ${moduleDir}/*.sys.mjs\n` +
        '  toolkit/content/widgets/*/*.{mjs,css}\n' +
        '  **/{browser,xpcshell,mochitest,chrome,a11y}*.toml (into the moz.build above it)\n' +
        "  **/browser_*.js, **/test_*.js, **/test_*.html (into the directory's test manifest)"
  );
}

function missingManifest(manifest: string, hint: string): FireForgeError {
  return new FireForgeError('manifest-not-found', `Manifest not found: ${manifest}`, { hint });
}

function chainMissing(path: string, variable: string): FireForgeError {
  return new FireForgeError(
    'manifest-chain-missing',
    `No moz.build exists above ${path}, so ${variable} cannot be wired.`,
    { hint: 'Check the path.' }
  );
}

/** A registration's outcome, before the plan's edits are attached. */
interface Outcome {
  manifest: string;
  entry: string;
  previous?: string | undefined;
  afterFallback?: boolean | undefined;
  /** The registration itself first, then any manifests created or wired for it. */
  steps: PlanStep[];
}

function placed(placement: Placement): Pick<Outcome, 'entry' | 'previous' | 'afterFallback'> {
  return {
    entry: (placement.text.split('\n')[placement.line] ?? '').trim(),
    previous: placement.previous,
    afterFallback: placement.afterFallback,
  };
}

/**
 * Plans one jar.mn entry, or finds it (or an alias) already present.
 *
 * @param session - The plan's edits so far
 * @param target - The entry and its manifest
 * @param after - Place it after the entry this names
 */
export async function planJar(
  session: EditSession,
  target: JarTarget,
  after: string | undefined
): Promise<Outcome> {
  const text = await session.read(target.manifest);
  if (text === undefined) throw missingManifest(target.manifest, 'Check the path.');
  const { entry } = target;
  const known = findJarEntries(text, {
    target: [entry.target, ...(target.aliases ?? [])],
    ...(entry.source === undefined ? {} : { source: entry.source }),
  })[0];
  const placement: Placement =
    known === undefined
      ? insertJarEntry(text, entry, {
          indent: target.indent,
          minGap: target.minGap,
          ...(after === undefined ? {} : { after }),
        })
      : { text, changed: false, line: known.line };
  if (placement.changed) session.set(target.manifest, placement.text);
  return {
    manifest: target.manifest,
    ...placed(placement),
    steps: [
      {
        path: target.manifest,
        change: `${entry.target} (${entry.source ?? ''})`,
        present: !placement.changed,
      },
    ],
  };
}

/** Plans the edits of one request; `session` collects them. */
class Planner {
  readonly session: EditSession;

  constructor(
    files: TrackedFiles,
    private readonly request: RegisterRequest
  ) {
    this.session = new EditSession(files);
  }

  private header(): string {
    return licenseHeader(this.request.license, 'hash');
  }

  /** Adds `value` to a moz.build list, creating the list, and the file with the project header, when absent. */
  private async addToMozBuild(path: string, variable: string, value: string): Promise<PlanStep> {
    const text = await this.session.read(path);
    const edit = addToMozBuildList(text ?? '', variable, value, { create: true });
    if (edit.changed) {
      this.session.set(
        path,
        text === undefined ? `${this.header()}\n\n${edit.text.trimStart()}` : edit.text
      );
    }
    return { path, change: `${variable} += ["${value}"]`, present: !edit.changed };
  }

  /**
   * Wires a new directory into the DIRS of its parents: every parent without
   * a moz.build gets one, up to the nearest parent that has one.
   */
  private async wireParents(dir: string): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];
    let child = dir;
    for (let parent = posix.dirname(dir); parent !== '.'; parent = posix.dirname(parent)) {
      const manifest = `${parent}/moz.build`;
      const exists = await this.session.exists(manifest);
      steps.push(await this.addToMozBuild(manifest, 'DIRS', posix.basename(child)));
      if (exists) return steps;
      child = parent;
    }
    throw chainMissing(dir, 'DIRS');
  }

  async list(target: ListTarget): Promise<Outcome> {
    const { manifest, value } = target;
    const first = target.variables[0] ?? '';
    const text = await this.session.read(manifest);
    if (text === undefined) {
      if (this.request.createManifest !== true) {
        throw missingManifest(
          manifest,
          'Pass --create-manifest to create it and wire its parent DIRS.'
        );
      }
      const step = await this.addToMozBuild(manifest, first, value);
      return {
        manifest,
        entry: `"${value}",`,
        steps: [step, ...(await this.wireParents(posix.dirname(manifest)))],
      };
    }
    const present = target.variables
      .map((variable) => ({
        variable,
        line: findMozBuildLists(text, variable)
          .flatMap((list) => list.items)
          .find((candidate) => candidate.value === value)?.line,
      }))
      .find((found) => found.line !== undefined);
    const variable =
      present?.variable ??
      target.variables.find((candidate) => findMozBuildLists(text, candidate).length > 0) ??
      first;
    const placement: Placement =
      present?.line === undefined
        ? addToMozBuildList(text, variable, value, { create: true })
        : { text, changed: false, line: present.line };
    if (placement.changed) this.session.set(manifest, placement.text);
    return {
      manifest,
      ...placed(placement),
      steps: [
        { path: manifest, change: `${variable} += ["${value}"]`, present: !placement.changed },
      ],
    };
  }

  /**
   * Registers a test manifest: present when a moz.build above it lists it;
   * otherwise in the nearest moz.build above it with a list of its flavour,
   * else one with any test manifest list, else one with any list at all
   * (a moz.build holding only `with Files` metadata is not in the build),
   * else the nearest.
   */
  async manifest(target: ManifestTarget): Promise<Outcome> {
    const owners: { path: string; text: string }[] = [];
    for (let dir = posix.dirname(target.path); dir !== '.'; dir = posix.dirname(dir)) {
      const path = `${dir}/moz.build`;
      const text = await this.session.read(path);
      if (text === undefined) continue;
      const listed = mozBuildTestManifests(path, text).find((entry) => entry.path === target.path);
      if (listed !== undefined) {
        const line = findMozBuildLists(text, listed.variable, { conditional: true })
          .flatMap((list) => list.items)
          .find((item) => item.value === listed.value)?.line;
        const change = `${listed.variable} += ["${listed.value}"]`;
        return {
          manifest: path,
          entry: (text.split('\n')[line ?? 0] ?? '').trim(),
          steps: [{ path, change, present: true }],
        };
      }
      owners.push({ path, text });
    }
    const lists = (text: string): MozBuildList[] => parseMozBuild(text).lists;
    const owner =
      owners.find((candidate) => findMozBuildLists(candidate.text, target.variable).length > 0) ??
      owners.find((candidate) =>
        lists(candidate.text).some((list) => list.name in TEST_MANIFEST_VARIABLES)
      ) ??
      owners.find((candidate) => lists(candidate.text).length > 0) ??
      owners[0];
    if (owner === undefined) throw chainMissing(target.path, target.variable);
    const value = posix.relative(posix.dirname(owner.path), target.path);
    const placement = addToMozBuildList(owner.text, target.variable, value, { create: true });
    this.session.set(owner.path, placement.text);
    return {
      manifest: owner.path,
      ...placed(placement),
      steps: [{ path: owner.path, change: `${target.variable} += ["${value}"]`, present: false }],
    };
  }

  async test(target: TestTarget): Promise<Outcome> {
    const { manifest, name } = target;
    const { after } = this.request;
    const text = await this.session.read(manifest);
    if (text === undefined) {
      const flavor = testManifestFlavor(manifest);
      const variable = Object.keys(TEST_MANIFEST_VARIABLES).find(
        (key) => TEST_MANIFEST_VARIABLES[key] === flavor
      );
      if (this.request.createManifest !== true || variable === undefined) {
        throw missingManifest(
          manifest,
          `Pass --create-manifest to create it and wire ${variable ?? 'it'} into a moz.build.`
        );
      }
      this.session.set(
        manifest,
        newTestManifest(manifest, name, {
          header: this.header(),
          ...(this.request.manifestDefaults === undefined
            ? {}
            : { defaults: this.request.manifestDefaults }),
        })
      );
      const created: PlanStep = {
        path: manifest,
        change: `["${name}"] (new file)`,
        present: false,
      };
      const wired = await this.manifest({ kind: 'manifest', path: manifest, variable });
      return { manifest, entry: `["${name}"]`, steps: [created, ...wired.steps] };
    }
    const placement = addTest(manifest, text, name, after === undefined ? {} : { after });
    if (placement.changed) this.session.set(manifest, placement.text);
    return {
      manifest,
      ...placed(placement),
      steps: [{ path: manifest, change: `["${name}"]`, present: !placement.changed }],
    };
  }
}

/**
 * Plans the registration of one engine file in the build manifest its path
 * calls for. Registering a file that is already registered plans nothing.
 *
 * @param files - Where the manifests live
 * @param request - The file and the options
 * @throws `invalid-argument` for a path with no manifest or an unsupported `after`;
 *   `manifest-not-found` when the manifest is missing and not to be created
 */
export async function planRegister(
  files: TrackedFiles,
  request: RegisterRequest
): Promise<RegisterPlan> {
  const { path, moduleDir, after } = request;
  const target = classify(path, moduleDir, request.testManifest);
  if (target === undefined) throw unknownPath(path, moduleDir);
  if (after !== undefined && (target.kind === 'list' || target.kind === 'manifest')) {
    throw usageError(
      `--after does not apply to ${path}: moz.build entries are kept in sorted order.`,
      'Drop --after.'
    );
  }
  if (request.mustExist === true && !(await files.exists(path))) {
    throw usageError(`File not found: ${path}`, 'Create the file before registering it.');
  }
  const planner = new Planner(files, request);
  const outcome =
    target.kind === 'jar'
      ? await planJar(planner.session, target, after)
      : target.kind === 'list'
        ? await planner.list(target)
        : target.kind === 'manifest'
          ? await planner.manifest(target)
          : await planner.test(target);
  return { ...outcome, edits: planner.session.edits() };
}
