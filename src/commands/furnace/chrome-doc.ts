// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge furnace chrome-doc create <name>` — scaffolds a top-level
 * chrome document (xhtml + js + css + ftl + jar.mn registrations).
 *
 * Motivation: `furnace create` covers custom elements under
 * `toolkit/content/widgets/`, but top-level chrome documents (the
 * `mybrowser.xhtml`-class entry points a fork adds alongside or instead
 * of `browser.xhtml`) are today hand-authored with error-prone jar.mn +
 * jar.inc.mn + locales/jar.mn glue. The `*` preprocessor flag, the
 * macOS titlebar-button carve-out, the startup-topic observer, and the
 * Fluent linkage each have silent-break failure modes.
 *
 * This command writes the four source files and appends three jar.mn
 * entries under a rollback journal identical in shape to `furnace create`.
 * A SIGINT mid-scaffold restores every touched file; a successful run
 * leaves the tree ready for `fireforge build`.
 */

import { join } from 'node:path';

import { loadConfig } from '../../core/config.js';
import { type FurnaceOperationContext, runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  restoreRollbackJournalOrThrow,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { DEFAULT_LICENSE, getLicenseHeader } from '../../core/license-headers.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { ProjectLicense } from '../../types/config.js';
import { pathExists, readText, writeText } from '../../utils/fs.js';
import { intro, note, outro } from '../../utils/logger.js';
import {
  generateChromeDocCss,
  generateChromeDocFtl,
  generateChromeDocJs,
  generateChromeDocXhtml,
  jarIncMnEntryForChromeDoc,
  jarMnEntriesForChromeDoc,
  localeJarMnEntryForChromeDoc,
} from './chrome-doc-templates.js';

/** Options for `furnace chrome-doc create`. */
export interface FurnaceChromeDocCreateOptions {
  /**
   * Emit the titlebar-buttonbox markup and leave platform window controls
   * visible. Defaults to `true` because the common case is a full chrome
   * document (not a frameless overlay). Frameless callers pass
   * `--no-titlebar`.
   */
  titlebar?: boolean;
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
function validateChromeDocName(name: string): void {
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
  name: string;
  license: ProjectLicense;
  engineDir: string;
  withTitlebar: boolean;
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
        const { ensureDir } = await import('../../utils/fs.js');
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
    await writeText(xhtmlPath, generateChromeDocXhtml(args.name, args.withTitlebar, args.license));
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
    await appendJarEntryIfAbsent(localeJarMnPath, localeJarMnEntryForChromeDoc(args.name), journal);
    written.push('browser/locales/jar.mn');
  } catch (error: unknown) {
    await restoreRollbackJournalOrThrow(journal, `Failed to scaffold chrome-doc "${args.name}"`);
    throw error;
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

  if (!(await pathExists(engineDir))) {
    throw new FurnaceError(
      'Engine directory not found. Run "fireforge download" first to scaffold a chrome-doc.'
    );
  }

  const withTitlebar = options.titlebar ?? true;

  const written = await runFurnaceMutation(projectRoot, 'chrome-doc-rollback', (ctx) =>
    performChromeDocMutations({
      name,
      license,
      engineDir,
      withTitlebar,
      operationContext: ctx,
    })
  );

  note(
    [
      `Chrome document "${name}" scaffolded:`,
      ...written.map((f) => `  engine/${f}`),
      '',
      'Next steps:',
      `  1. Edit engine/browser/base/content/${name}.xhtml and fill in the body.`,
      `  2. Localize strings in engine/browser/locales/en-US/browser/${name}.ftl.`,
      `  3. Run "fireforge build" to validate packaging (post-build audit will flag`,
      '     any entry whose file does not land in the dist bundle).',
    ].join('\n'),
    name
  );

  outro('Chrome document created');
}
