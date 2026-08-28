// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge furnace chrome-doc create <name>` — scaffolds a top-level
 * chrome document (xhtml + js + css + ftl + jar.mn registrations).
 *
 * `furnace create` covers custom elements under `toolkit/content/widgets/`,
 * but top-level chrome documents — the `mybrowser.xhtml`-class entry points
 * a fork adds alongside or instead of `browser.xhtml` — are otherwise
 * hand-authored with error-prone jar.mn + jar.inc.mn + locales/jar.mn glue.
 * The `*` preprocessor flag, the macOS titlebar-button carve-out, the
 * startup-topic observer, and the Fluent linkage each have silent-break
 * failure modes.
 *
 * This command writes the four source files and appends three jar.mn entries
 * under a rollback journal identical in shape to `furnace create`. A SIGINT
 * mid-scaffold restores every touched file; a successful run leaves the tree
 * ready for `fireforge build`.
 */

import { join } from 'node:path';

import { loadConfig } from '../../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import {
  completeJournalRollback,
  type FurnaceOperationContext,
  runFurnaceMutation,
} from '../../core/furnace-operation.js';
import { assertFurnaceEngineReady } from '../../core/furnace-precondition.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { DEFAULT_LICENSE, getLicenseHeader } from '../../core/license-headers.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { ProjectLicense } from '../../types/config.js';
import { ensureDir, pathExists, readText, writeText } from '../../utils/fs.js';
import { intro, note, outro, warn } from '../../utils/logger.js';
import {
  generateBrowserWindowXhtml,
  generateChromeDocCss,
  generateChromeDocFtl,
  generateChromeDocJs,
  generateChromeDocXhtml,
  jarIncMnEntryForChromeDoc,
  jarMnEntriesForChromeDoc,
  localeJarMnEntryForChromeDoc,
  localesFtlWildcardCapturesScaffoldedName,
} from './chrome-doc-templates.js';
import {
  chromeDocPackagingTestFileName,
  generateChromeDocPackagingManifest,
  generateChromeDocPackagingTest,
} from './chrome-doc-tests.js';

/** Options for `furnace chrome-doc create`. */
export interface FurnaceChromeDocCreateOptions {
  /**
   * Emit the titlebar-buttonbox markup and leave platform window controls
   * visible. Defaults to `true` because the common case is a full chrome
   * document (not a frameless overlay). Frameless callers pass
   * `--no-titlebar`.
   */
  titlebar?: boolean;
  /**
   * Scaffold an xpcshell packaging-verification test alongside the chrome
   * document. The generated test probes `XCurProcD/chrome/browser/...` on
   * disk rather than going through `chrome://` URI resolution, which
   * bypasses xpcshell's limited browser-chrome manifest set — where
   * `NetUtil.asyncFetch` returns `NS_ERROR_FILE_NOT_FOUND` against a file
   * that IS packaged. Registration in `XPCSHELL_TESTS_MANIFESTS` is left to
   * the operator because the owning moz.build depends on the fork's layout.
   */
  withTests?: boolean;
  /** Print the scaffold plan without writing files. */
  dryRun?: boolean;
  /**
   * Emit the browser.xhtml-like MAIN-WINDOW skeleton (`<html
   * id="main-window">` with the `windowtype`/`chromehidden`/`persist`
   * root attributes platform C++ reads before scripts run) instead of
   * the generic dialog-shaped `<window>` document. Use for the document
   * configured as the fork's main browser window
   * (`tokenHostDocuments[0]` / the BROWSER_CHROME_URL target). Implies
   * the titlebar markup.
   */
  browserWindow?: boolean;
}

/** Chrome-doc name shape: lowercase ASCII, optional hyphens, no leading digit. */
const CHROME_DOC_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Validates a chrome-doc name. Lowercase ASCII, optional hyphens, no
 * leading digit — the name is used verbatim in CSS selectors, jar.mn
 * entries, FTL keys, and file basenames, so anything outside that
 * character set would break at least one downstream consumer.
 * @param name Chrome-doc name (file basename without extension).
 * @throws InvalidArgumentError when the name is unusable.
 */
export function validateChromeDocName(name: string): void {
  if (!name.trim()) {
    throw new InvalidArgumentError('Chrome-doc name is required', 'name');
  }
  if (!CHROME_DOC_NAME_PATTERN.test(name)) {
    throw new InvalidArgumentError(
      'Chrome-doc name must be lowercase ASCII, may contain hyphens, and must not start with a digit (e.g. mybrowser, about-onboarding).',
      'name'
    );
  }
}

export interface ChromeDocPlan {
  files: string[];
  dirs: string[];
  jarEntries: Array<{ file: string; entry: string; present: boolean }>;
  localeWildcardCapturesFtl: boolean;
  testDir?: string;
  testFiles: string[];
}

/** Builds the shared create/remove plan for a top-level chrome document. */
export async function buildChromeDocPlan(args: {
  engineDir: string;
  name: string;
  withTests: boolean;
  binaryName: string;
  validateCreateConflicts?: boolean;
  includeLocaleEntryWhenWildcard?: boolean;
}): Promise<ChromeDocPlan> {
  const contentDir = join(args.engineDir, 'browser/base/content');
  const sharedThemeDir = join(args.engineDir, 'browser/themes/shared');
  const localeDir = join(args.engineDir, 'browser/locales/en-US/browser');
  const dirs = [contentDir, sharedThemeDir, localeDir];

  const xhtmlPath = join(contentDir, `${args.name}.xhtml`);
  if (args.validateCreateConflicts && (await pathExists(xhtmlPath))) {
    throw new FurnaceError(
      `${args.name}.xhtml already exists at ${xhtmlPath}. Remove it or choose a different name.`
    );
  }

  const jarMnPath = join(args.engineDir, 'browser/base/jar.mn');
  const jarIncMnPath = join(args.engineDir, 'browser/themes/shared/jar.inc.mn');
  const localeJarMnPath = join(args.engineDir, 'browser/locales/jar.mn');
  for (const requiredJarPath of [jarMnPath, jarIncMnPath, localeJarMnPath]) {
    if (!(await pathExists(requiredJarPath))) {
      throw new FurnaceError(
        `Required jar file ${requiredJarPath} does not exist; cannot register chrome-doc entry. Check that the fork's engine layout matches the expected browser/ and locales/ tree.`
      );
    }
  }

  const [jarMn, jarIncMn, localeJarMn] = await Promise.all([
    readText(jarMnPath),
    readText(jarIncMnPath),
    readText(localeJarMnPath),
  ]);
  const localeWildcardCapturesFtl = localesFtlWildcardCapturesScaffoldedName(localeJarMn);

  const jarEntries: ChromeDocPlan['jarEntries'] = [];
  for (const entry of jarMnEntriesForChromeDoc(args.name)) {
    jarEntries.push({
      file: 'browser/base/jar.mn',
      entry,
      present: jarMn.includes(entry),
    });
  }
  const cssEntry = jarIncMnEntryForChromeDoc(args.name);
  jarEntries.push({
    file: 'browser/themes/shared/jar.inc.mn',
    entry: cssEntry,
    present: jarIncMn.includes(cssEntry),
  });
  if (!localeWildcardCapturesFtl || args.includeLocaleEntryWhenWildcard) {
    const ftlEntry = localeJarMnEntryForChromeDoc(args.name);
    jarEntries.push({
      file: 'browser/locales/jar.mn',
      entry: ftlEntry,
      present: localeJarMn.includes(ftlEntry),
    });
  }

  const files = [
    `browser/base/content/${args.name}.xhtml`,
    `browser/base/content/${args.name}.js`,
    `browser/themes/shared/${args.name}-chrome.css`,
    `browser/locales/en-US/browser/${args.name}.ftl`,
  ];
  const testFiles: string[] = [];
  let testDir: string | undefined;
  if (args.withTests) {
    const testParentDir = `${args.binaryName}-xpcshell`;
    testDir = `browser/base/content/test/${testParentDir}/${args.name}`;
    testFiles.push(
      `${testDir}/${chromeDocPackagingTestFileName(args.name)}`,
      `${testDir}/xpcshell.toml`
    );
  }

  return {
    files,
    dirs,
    jarEntries,
    localeWildcardCapturesFtl,
    ...(testDir ? { testDir } : {}),
    testFiles,
  };
}

function renderChromeDocCreateDryRun(name: string, plan: ChromeDocPlan): string {
  const dirLines = plan.dirs.map((dir) => `  ${dir}`);
  const jarLines = plan.jarEntries.map(
    ({ file, entry, present }) =>
      `  engine/${file}: ${present ? 'already present' : 'would add'} ${entry.trim()}`
  );
  const localeLine = plan.localeWildcardCapturesFtl
    ? [
        '',
        'Locale jar.mn already has a [localization] wildcard that captures the FTL;',
        'no per-file locale entry would be added.',
      ]
    : [];
  const testLines =
    plan.testFiles.length > 0
      ? [
          '',
          'Would create xpcshell packaging test files:',
          ...plan.testFiles.map((f) => `  engine/${f}`),
        ]
      : [];
  return [
    `[dry-run] Chrome document "${name}" scaffold plan`,
    '',
    'Directories checked/created as needed:',
    ...dirLines,
    '',
    'Would create source files:',
    ...plan.files.map((f) => `  engine/${f}`),
    ...testLines,
    '',
    'Jar registrations:',
    ...jarLines,
    ...localeLine,
  ].join('\n');
}

/**
 * Appends a line to a jar.mn-style file when that exact line is not
 * already present. Captures the pre-write contents in the journal so a
 * mid-run interruption restores the file to its original state.
 */
async function appendJarEntryIfAbsent(
  filePath: string,
  entry: string,
  journal: Parameters<typeof snapshotFile>[0]
): Promise<void> {
  if (!(await pathExists(filePath))) {
    // Target jar.mn doesn't exist in this tree layout. We do NOT create it
    // — a fork that moved the jar file needs the operator to choose a
    // placement. The command surfaces this as a FurnaceError so the user
    // can investigate rather than silently writing to a non-canonical path.
    throw new FurnaceError(
      `Required jar file ${filePath} does not exist; cannot register chrome-doc entry. Check that the fork's engine layout matches the expected browser/ and locales/ tree.`
    );
  }
  const existing = await readText(filePath);
  if (existing.includes(entry)) {
    return;
  }
  await snapshotFile(journal, filePath);
  const withEntry = existing.trimEnd() + '\n' + entry + '\n';
  await writeText(filePath, withEntry);
}

/**
 * Writes the xhtml/js/css/ftl source files plus the three jar.mn
 * registrations under a rollback journal. Any interruption leaves the
 * tree in its pre-command state.
 */
async function performChromeDocMutations(args: {
  projectRoot: string;
  name: string;
  license: ProjectLicense;
  engineDir: string;
  withTitlebar: boolean;
  withTests: boolean;
  browserWindow: boolean;
  binaryName: string;
  operationContext: FurnaceOperationContext;
}): Promise<string[]> {
  const journal = createRollbackJournal();
  args.operationContext.registerJournal(journal);

  // XHTML uses an inline XML comment since getLicenseHeader has no XML
  // style — the SPDX convention is a single-line comment at the top.
  const jsHeader = getLicenseHeader(args.license, 'js');
  const cssHeader = getLicenseHeader(args.license, 'css');
  const ftlHeader = getLicenseHeader(args.license, 'hash');

  const written: string[] = [];

  try {
    const contentDir = join(args.engineDir, 'browser/base/content');
    const sharedThemeDir = join(args.engineDir, 'browser/themes/shared');
    const localeDir = join(args.engineDir, 'browser/locales/en-US/browser');

    for (const dir of [contentDir, sharedThemeDir, localeDir]) {
      if (!(await pathExists(dir))) {
        recordCreatedDir(journal, dir);
        await ensureDir(dir);
      }
    }

    const xhtmlPath = join(contentDir, `${args.name}.xhtml`);
    if (await pathExists(xhtmlPath)) {
      throw new FurnaceError(
        `${args.name}.xhtml already exists at ${xhtmlPath}. Remove it or choose a different name.`
      );
    }
    await snapshotFile(journal, xhtmlPath);
    await writeText(
      xhtmlPath,
      args.browserWindow
        ? generateBrowserWindowXhtml(args.name, args.license)
        : generateChromeDocXhtml(args.name, args.withTitlebar, args.license)
    );
    written.push(`browser/base/content/${args.name}.xhtml`);

    const jsPath = join(contentDir, `${args.name}.js`);
    await snapshotFile(journal, jsPath);
    await writeText(jsPath, generateChromeDocJs(args.name, jsHeader));
    written.push(`browser/base/content/${args.name}.js`);

    const cssPath = join(sharedThemeDir, `${args.name}-chrome.css`);
    await snapshotFile(journal, cssPath);
    await writeText(cssPath, generateChromeDocCss(args.name, args.withTitlebar, cssHeader));
    written.push(`browser/themes/shared/${args.name}-chrome.css`);

    const ftlPath = join(localeDir, `${args.name}.ftl`);
    await snapshotFile(journal, ftlPath);
    await writeText(ftlPath, generateChromeDocFtl(args.name, ftlHeader));
    written.push(`browser/locales/en-US/browser/${args.name}.ftl`);

    // jar.mn registrations — XHTML + JS go through the `*` preprocessor
    // for brand substitution, CSS goes through jar.inc.mn, FTL through
    // the locale jar.
    const jarMnPath = join(args.engineDir, 'browser/base/jar.mn');
    for (const entry of jarMnEntriesForChromeDoc(args.name)) {
      await appendJarEntryIfAbsent(jarMnPath, entry, journal);
    }
    written.push('browser/base/jar.mn');

    const jarIncMnPath = join(args.engineDir, 'browser/themes/shared/jar.inc.mn');
    await appendJarEntryIfAbsent(jarIncMnPath, jarIncMnEntryForChromeDoc(args.name), journal);
    written.push('browser/themes/shared/jar.inc.mn');

    const localeJarMnPath = join(args.engineDir, 'browser/locales/jar.mn');
    // Forks that have migrated to a `[localization] (%browser/**/*.ftl)`
    // wildcard already pick up the scaffolded FTL automatically — appending
    // a per-file `locale/...` entry on top is at best dead weight and at
    // worst a build error when the fork has dropped the `% locale browser`
    // registration the per-file entry depends on. The wildcard predicate is
    // intentionally narrow: only `%browser/`-rooted globs ending in `*.ftl`
    // count as a capture.
    if (await pathExists(localeJarMnPath)) {
      const existingLocaleJar = await readText(localeJarMnPath);
      if (localesFtlWildcardCapturesScaffoldedName(existingLocaleJar)) {
        note(
          `Locale jar.mn already carries a [localization] wildcard that captures browser/${args.name}.ftl — skipping the per-file entry.`,
          args.name
        );
      } else {
        await appendJarEntryIfAbsent(
          localeJarMnPath,
          localeJarMnEntryForChromeDoc(args.name),
          journal
        );
      }
    } else {
      // Preserve the existing "missing locale jar.mn" failure mode: pretend
      // we still want to append so appendJarEntryIfAbsent surfaces the same
      // FurnaceError it does for the other two jars. Forks that move the
      // file deserve the same explicit complaint everywhere.
      await appendJarEntryIfAbsent(
        localeJarMnPath,
        localeJarMnEntryForChromeDoc(args.name),
        journal
      );
    }
    written.push('browser/locales/jar.mn');

    // --with-tests scaffolds an xpcshell packaging verification. All writes
    // go through the same rollback journal so a SIGINT here restores the
    // source files and jar.mn edits above alongside the test scaffold.
    if (args.withTests) {
      const testParentDir = `${args.binaryName}-xpcshell`;
      const testDir = join(args.engineDir, 'browser/base/content/test', testParentDir, args.name);
      if (!(await pathExists(testDir))) {
        recordCreatedDir(journal, testDir);
      }
      await ensureDir(testDir);

      const hashHeader = getLicenseHeader(args.license, 'hash');
      const testFileName = chromeDocPackagingTestFileName(args.name);
      const testFilePath = join(testDir, testFileName);
      await snapshotFile(journal, testFilePath);
      await writeText(testFilePath, generateChromeDocPackagingTest(args.name, jsHeader));
      written.push(`browser/base/content/test/${testParentDir}/${args.name}/${testFileName}`);

      const manifestPath = join(testDir, 'xpcshell.toml');
      await snapshotFile(journal, manifestPath);
      await writeText(manifestPath, generateChromeDocPackagingManifest(args.name, hashHeader));
      written.push(`browser/base/content/test/${testParentDir}/${args.name}/xpcshell.toml`);
    }
  } catch (error: unknown) {
    return await completeJournalRollback(args.operationContext, journal, error, {
      projectRoot: args.projectRoot,
      operation: 'chrome-doc-rollback',
      failureMessage: `Failed to scaffold chrome-doc "${args.name}"`,
      subject: `chrome-doc "${args.name}"`,
    });
  }

  return written;
}

/**
 * Runs `furnace chrome-doc create <name>`.
 * @param projectRoot Root directory of the project.
 * @param name Chrome-doc name (e.g. `mybrowser`, `aboutonboarding`).
 * @param options CLI-provided options.
 */
export async function furnaceChromeDocCreateCommand(
  projectRoot: string,
  name: string,
  options: FurnaceChromeDocCreateOptions = {}
): Promise<void> {
  intro('Furnace chrome-doc create');

  validateChromeDocName(name);

  const forgeConfig = await loadConfig(projectRoot);
  const license = forgeConfig.license ?? DEFAULT_LICENSE;
  const engineDir = join(projectRoot, 'engine');

  await assertFurnaceEngineReady(projectRoot, {
    engineMissingSuffix: ' to scaffold a chrome-doc.',
  });

  const browserWindow = options.browserWindow ?? false;
  // The browser-window skeleton always carries its own titlebar markup and
  // chrome attributes; --no-titlebar only applies to the generic scaffold.
  const withTitlebar = browserWindow ? true : (options.titlebar ?? true);
  const withTests = options.withTests ?? false;

  // Hint: when the scaffolded document is the configured token-host document
  // (the fork's main browser window), the generic dialog-shaped scaffold is
  // almost certainly wrong — correct jar.mn registrations, wrong document
  // body.
  if (!browserWindow && (await furnaceConfigExists(projectRoot))) {
    try {
      const furnaceConfig = await loadFurnaceConfig(projectRoot);
      const targetDocPath = `browser/base/content/${name}.xhtml`;
      if (furnaceConfig.tokenHostDocuments?.includes(targetDocPath)) {
        warn(
          `${targetDocPath} is a configured token-host document (the fork's main browser window). ` +
            'The default scaffold emits a generic dialog-shaped <window> document; you probably ' +
            'want "fireforge furnace chrome-doc create --browser-window" for the ' +
            '<html id="main-window"> skeleton platform C++ expects.'
        );
      }
    } catch {
      // A broken furnace.json must not block chrome-doc scaffolding; the
      // hint is best-effort.
    }
  }

  const plan = await buildChromeDocPlan({
    engineDir,
    name,
    withTests,
    binaryName: forgeConfig.binaryName,
    validateCreateConflicts: true,
  });

  if (options.dryRun) {
    note(renderChromeDocCreateDryRun(name, plan), name);
    outro('Dry run complete');
    return;
  }

  const written = await runFurnaceMutation(projectRoot, 'chrome-doc-rollback', (ctx) =>
    performChromeDocMutations({
      projectRoot,
      name,
      license,
      engineDir,
      withTitlebar,
      withTests,
      browserWindow,
      binaryName: forgeConfig.binaryName,
      operationContext: ctx,
    })
  );

  const nextSteps: string[] = [
    `  1. Edit engine/browser/base/content/${name}.xhtml and fill in the body.`,
    `  2. Localize strings in engine/browser/locales/en-US/browser/${name}.ftl.`,
    `  3. Run "fireforge build" to validate packaging (post-build audit will flag`,
    '     any entry whose file does not land in the dist bundle).',
  ];
  if (withTests) {
    nextSteps.push(
      `  4. Register the xpcshell test directory in the nearest moz.build under`,
      `     XPCSHELL_TESTS_MANIFESTS, then run "fireforge test browser/base/content/test/${forgeConfig.binaryName}-xpcshell/${name}/xpcshell.toml".`
    );
  }
  nextSteps.push(
    '',
    'Platform-module compatibility: this chrome document carries the',
    `  data-furnace-chrome-doc="${name}" sentinel on its root element. Upstream`,
    '  platform modules (DevToolsStartup, PageActions, SessionStore, …) observe',
    '  "browser-delayed-startup-finished" and walk INTO the window assuming the',
    '  browser.xhtml DOM; use the sentinel attribute as a guard in fork-side',
    '  patches to those modules. See README "Platform module compatibility".'
  );

  note(
    [
      `Chrome document "${name}" scaffolded:`,
      ...written.map((f) => `  engine/${f}`),
      '',
      'Next steps:',
      ...nextSteps,
    ].join('\n'),
    name
  );

  outro('Chrome document created');
}
