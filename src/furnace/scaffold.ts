// SPDX-License-Identifier: EUPL-1.2
/**
 * What `furnace create` writes: a component's sources, and optionally a test
 * in one of three harnesses. A test scaffold is described once, as data, and
 * the same description is written by create, moved by rename and taken away
 * by remove. Where the test is registered (its manifest, and the moz.build
 * that lists a new manifest) is `register`'s policy.
 */
import { posix } from 'node:path';

import type { Transaction } from '../kernel/journal.js';
import { escapeRegExp } from '../kernel/text.js';
import {
  findMozBuildLists,
  listTests,
  mozBuildTestManifests,
  type NewTest,
  removeFromMozBuildList,
  removeTest,
} from '../mozbuild/index.js';
import { type License, licenseHeader, type TrackedFiles } from '../project/index.js';
import { applyEdits, planRegister, type PlanStep } from '../register/index.js';
import { className, ELEMENTS_URL } from './config.js';

/** What a new component's sources say about it. */
export interface ComponentTemplate {
  name: string;
  description: string;
  license: License;
  /** The Fluent resource the module loads, when it is localized. */
  ftl: string | undefined;
  /** Whether the component carries its own `.ftl` (not a shared feature file). */
  ownFtl: boolean;
}

/**
 * The sources of a new custom component, by file name. The module loads its
 * Fluent resource through `MozXULElement.insertFTLIfNeeded` at module level,
 * since `MozLitElement` has no such method and already connects its shadow
 * root to `document.l10n`.
 *
 * @param template - The component
 */
export function componentSources(template: ComponentTemplate): Map<string, string> {
  const { name, license, ftl } = template;
  const cls = className(name);
  const doc = (template.description || name).replace(/\*\//g, '*\\/');
  const fluent =
    ftl === undefined ? '' : `\nwindow.MozXULElement?.insertFTLIfNeeded(${JSON.stringify(ftl)});\n`;
  const sources = new Map<string, string>([
    [
      `${name}.mjs`,
      `${licenseHeader(license, 'js')}

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
${fluent}
/**
 * ${doc}
 *
 * @tagname ${name}
 */
export default class ${cls} extends MozLitElement {
  /** @type {Record<string, unknown>} */
  static properties = {};

  render() {
    return html\`
      <link rel="stylesheet" href="${ELEMENTS_URL}${name}.css" />
      <slot></slot>
    \`;
  }
}
customElements.define("${name}", /** @type {CustomElementConstructor} */ (${cls}));
`,
    ],
    [`${name}.css`, `${licenseHeader(license, 'css')}\n\n:host {\n  display: block;\n}\n`],
  ]);
  if (template.ownFtl) {
    sources.set(
      `${name}.ftl`,
      `${licenseHeader(license, 'hash')}\n\n## Strings of the ${name} component\n`
    );
  }
  return sources;
}

/** The test harnesses a component can be created with. */
export const TEST_STYLES = ['browser-chrome', 'mochikit', 'xpcshell'] as const;
/** One test harness. */
export type TestStyle = (typeof TEST_STYLES)[number];

/** A component's test in one harness, as engine files. */
export interface TestScaffold {
  style: TestStyle;
  /** The test file. */
  test: { path: string; content: string };
  /** A helper file shared by every test of the directory, written only when absent. */
  support?: { path: string; content: string };
  /** The test manifest's file name, beside the test, when not the directory's default. */
  manifest?: string;
  /** The `[DEFAULT]` keys of the manifest, when the scaffold creates it. */
  defaults?: NewTest['keys'];
}

/** `moz-mybrowser-sidebar` in a project named `mybrowser` is `sidebar`. */
function testStem(name: string, binaryName: string): string {
  const bare = name.startsWith('moz-') ? name.slice(4) : name;
  const own = bare.startsWith(`${binaryName}-`) ? bare.slice(binaryName.length + 1) : bare;
  return own.replace(/-/g, '_');
}

/**
 * A component's test scaffold in one harness.
 *
 * - browser-chrome: `browser/base/content/test/<binary>/browser_<binary>_<stem>.js`,
 *   needs a tabbrowser in the top-level chrome document.
 * - mochikit: `toolkit/content/tests/widgets/test_<name>.html`, for forks whose
 *   chrome document has no tabbrowser.
 * - xpcshell: checks the files reached the packaged tree; xpcshell has no
 *   `window`, so a Lit module cannot be imported there.
 *
 * @param name - The component
 * @param binaryName - The project's binary name
 * @param style - The harness
 * @param license - The header the files carry
 */
export function testScaffold(
  name: string,
  binaryName: string,
  style: TestStyle,
  license: License
): TestScaffold {
  const js = licenseHeader(license, 'js');
  const fn = name.replace(/-/g, '_');
  if (style === 'browser-chrome') {
    const dir = `browser/base/content/test/${binaryName}`;
    const file = `browser_${binaryName}_${testStem(name, binaryName)}.js`;
    return {
      style,
      test: {
        path: `${dir}/${file}`,
        content: `${js}

"use strict";

add_task(async function test_${fn}_defined() {
  const ctor = await waitForElement("${name}");
  Assert.ok(ctor, "${name} custom element should be defined");
  Assert.equal(typeof ctor, "function", "Constructor should be a function");
});
`,
      },
      support: {
        path: `${dir}/head.js`,
        content: `${js}

"use strict";

/**
 * Waits for a custom element to be defined.
 * @param {string} tag - Custom element tag name
 * @returns {Promise<CustomElementConstructor>}
 */
async function waitForElement(tag) {
  document.createElement(tag);
  return customElements.whenDefined(tag);
}
`,
      },
      defaults: { 'support-files': ['head.js'] },
    };
  }
  if (style === 'mochikit') {
    const dir = 'toolkit/content/tests/widgets';
    const file = `test_${name}.html`;
    return {
      style,
      test: {
        path: `${dir}/${file}`,
        content: `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Test the ${name} custom element</title>
    <script src="chrome://mochikit/content/tests/SimpleTest/SimpleTest.js"></script>
    <link rel="stylesheet" href="chrome://mochikit/content/tests/SimpleTest/test.css" />
  </head>
  <body>
    <script type="module">
      import "${ELEMENTS_URL}${name}.mjs";

      add_task(async function test_${fn}_defined() {
        const ctor = await customElements.whenDefined("${name}");
        ok(ctor, "${name} custom element should be defined");
        is(typeof ctor, "function", "Constructor should be a function");
      });
    </script>
  </body>
</html>
`,
      },
      manifest: 'chrome.toml',
    };
  }
  return xpcshellScaffold(name, binaryName, js);
}

function xpcshellScaffold(name: string, binaryName: string, js: string): TestScaffold {
  const fn = name.replace(/-/g, '_');
  const dir = `browser/base/content/test/${binaryName}-xpcshell/${name}`;
  const file = `test_${fn}_packaged.js`;
  const probe = (ext: string): string =>
    `  probe(["chrome", "global", "elements", "${name}.${ext}"], ["browser", "chrome", "global", "elements", "${name}.${ext}"]);`;
  return {
    style: 'xpcshell',
    test: {
      path: `${dir}/${file}`,
      content: `${js}

"use strict";

// The module imports Lit, which needs a window that xpcshell lacks, so this
// test checks that the files reached the unpacked build; behaviour belongs
// in a browser-chrome test.

add_task(async function test_${fn}_files_packaged() {
  const appDir = Services.dirsvc.get("XCurProcD", Ci.nsIFile);
  function probe(primary, fallback) {
    const candidates = [primary, fallback].map(segments => {
      const file = appDir.clone();
      for (const segment of segments) {
        file.append(segment);
      }
      return file;
    });
    const found = candidates.find(file => file.exists());
    Assert.ok(found, \`\${primary.at(-1)} is packaged (looked in \${candidates.map(file => file.path).join(" and ")})\`);
    Assert.greater(found.fileSize, 0, \`\${primary.at(-1)} is not empty\`);
  }
${probe('mjs')}
${probe('css')}
});
`,
    },
    defaults: { head: '' },
  };
}

/** Where the project keeps its modules and the header of the files it creates. */
export interface ScaffoldProject {
  moduleDir: string;
  license: License;
}

/** The test manifest a scaffold's test is listed in. */
function manifestOf(scaffold: TestScaffold): string {
  const dir = posix.dirname(scaffold.test.path);
  const name =
    scaffold.manifest ?? (scaffold.style === 'xpcshell' ? 'xpcshell.toml' : 'browser.toml');
  return `${dir}/${name}`;
}

/**
 * Writes a test scaffold and registers its test: in its manifest, created
 * and wired into a moz.build when missing. An existing test or support file
 * is kept.
 *
 * @param tracked - The project's tracked engine files
 * @param tx - The transaction the writes join
 * @param scaffold - What to write
 * @param project - The module directory and license
 * @returns Notes for the operator: files kept, and the registrations made
 */
export async function writeTestScaffold(
  tracked: TrackedFiles,
  tx: Transaction,
  scaffold: TestScaffold,
  project: ScaffoldProject
): Promise<string[]> {
  const notes: string[] = [];
  for (const file of [scaffold.test, scaffold.support]) {
    if (file === undefined) continue;
    if ((await tracked.read(file.path)) === undefined)
      await tracked.write(tx, file.path, file.content);
    else if (file === scaffold.test) notes.push(`${file.path} already exists and was kept.`);
  }
  const plan = await planRegister(tracked, {
    path: scaffold.test.path,
    moduleDir: project.moduleDir,
    license: project.license,
    createManifest: true,
    ...(scaffold.manifest === undefined ? {} : { testManifest: scaffold.manifest }),
    ...(scaffold.defaults === undefined ? {} : { manifestDefaults: scaffold.defaults }),
  });
  await applyEdits(tx, tracked, plan.edits);
  notes.push(
    ...plan.steps
      .filter((step: PlanStep) => !step.present)
      .map((step: PlanStep) => `Registered in ${step.path}: ${step.change}`)
  );
  return notes;
}

/**
 * Takes a test scaffold away: the test file, its manifest entry, and the
 * manifest and its moz.build entry once no test is left in it. A shared
 * support file stays.
 *
 * @param tracked - The project's tracked engine files
 * @param tx - The transaction the edits join
 * @param scaffold - The scaffold
 * @returns Whether the scaffold's test existed
 */
export async function removeTestScaffold(
  tracked: TrackedFiles,
  tx: Transaction,
  scaffold: TestScaffold
): Promise<boolean> {
  const existed = (await tracked.read(scaffold.test.path)) !== undefined;
  if (existed) await tracked.remove(tx, scaffold.test.path);
  const manifest = manifestOf(scaffold);
  const text = await tracked.read(manifest);
  if (text === undefined) return existed;
  const edited = removeTest(manifest, text, posix.basename(scaffold.test.path));
  // Only the xpcshell manifest belongs to one component; the others are shared by a directory.
  if (scaffold.style !== 'xpcshell' || listTests(manifest, edited.text).length > 0) {
    if (edited.changed) await tracked.write(tx, manifest, edited.text);
    return existed;
  }
  await tracked.remove(tx, manifest);
  for (let dir = posix.dirname(manifest); dir !== '.'; dir = posix.dirname(dir)) {
    const owner = `${dir}/moz.build`;
    const build = await tracked.read(owner);
    const listed =
      build === undefined
        ? undefined
        : mozBuildTestManifests(owner, build).find((entry) => entry.path === manifest);
    if (build === undefined || listed === undefined) continue;
    const list = findMozBuildLists(build, listed.variable, { conditional: true }).find(
      (candidate) => candidate.items.some((item) => item.value === listed.value)
    );
    const dropped = removeFromMozBuildList(build, listed.variable, listed.value, {
      line: list?.startLine ?? -1,
    });
    if (dropped.changed) await tracked.write(tx, owner, dropped.text);
    break;
  }
  return existed;
}

/**
 * Text with the mentions of a tag replaced, for moving a component or its
 * test to a new name. Three spellings are mentions:
 *
 *  - the tag (`moz-panel`) and its class name (`MozPanel`), as whole words:
 *    `moz-panel-group` and `MozPanelGroup` name another component;
 *  - the tag with underscores (`moz_panel`), which identifiers are built
 *    from by appending `_<what>` (`test_moz_panel_defined`). A word boundary
 *    cannot tell that from another component's identifier
 *    (`test_moz_panel_group_defined`), so the longer tags the project knows
 *    are named in `others` and their identifiers are left alone.
 *
 * @param text - Source text
 * @param from - The old tag
 * @param to - The new tag
 * @param others - The other component tags of the project
 */
export function renameTag(
  text: string,
  from: string,
  to: string,
  others: readonly string[] = []
): string {
  const snake = (tag: string): string => tag.replace(/-/g, '_');
  const longer = others
    .filter((tag) => tag.startsWith(`${from}-`))
    .map((tag) => escapeRegExp(snake(tag).slice(snake(from).length)));
  const notLonger = longer.length === 0 ? '' : `(?!(?:${longer.join('|')})(?![a-z0-9]))`;
  return text
    .replace(new RegExp(`(?<![\\w-])${escapeRegExp(from)}(?![\\w-])`, 'g'), to)
    .replace(new RegExp(`\\b${escapeRegExp(className(from))}\\b`, 'g'), className(to))
    .replace(
      new RegExp(`(?<![a-z0-9])${escapeRegExp(snake(from))}(?![a-z0-9])${notLonger}`, 'g'),
      snake(to)
    );
}
