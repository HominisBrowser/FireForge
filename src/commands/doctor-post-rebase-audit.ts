// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { DoctorCheck } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import type { DoctorCheckContext, DoctorCheckDefinition } from './doctor-check-core.js';
import { ok, warning } from './doctor-check-core.js';

async function readEngineText(engineDir: string, relativePath: string): Promise<string | null> {
  const fullPath = join(engineDir, relativePath);
  if (!(await pathExists(fullPath))) return null;
  return readText(fullPath);
}

/**
 * Collects every `browser.toml` under the engine's browser-chrome test tree.
 *
 * Reports unreadable directories separately from "none found": the consumer
 * turns an empty result into the issue "no browser.toml files found", which is
 * the opposite diagnosis from "the tree could not be read". A swallowed
 * mid-walk EACCES also silently shrank the result set, so one unreadable
 * subdirectory produced a false clean for that subtree.
 */
async function collectBrowserTomlFiles(
  root: string
): Promise<{ files: string[]; unreadable: string[] }> {
  const testRoot = join(root, 'browser/base/content/test');
  if (!(await pathExists(testRoot))) return { files: [], unreadable: [] };
  const result: string[] = [];
  const unreadable: string[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error: unknown) {
      unreadable.push(`${relDir || '.'} (${toError(error).message})`);
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath, relPath);
      } else if (entry.isFile() && entry.name === 'browser.toml') {
        result.push(`browser/base/content/test/${relPath}`);
      }
    }
  }

  await walk(testRoot, '');
  return { files: result.sort(), unreadable };
}

async function runPostRebaseAudit(ctx: DoctorCheckContext): Promise<DoctorCheck> {
  const issues: string[] = [];
  const engineDir = ctx.paths.engine;

  // The four probes below are upstream-Firefox shape markers: each names a
  // file and a token that a healthy post-rebase tree must still contain. A
  // rebase that dropped a fork patch, or an upstream reorganisation, shows up
  // as one of these going missing. The tokens are coarse on purpose: this
  // is a smoke check that runs warn-only behind an opt-in flag, not a
  // structural validator.
  const mozConfigure = await readEngineText(engineDir, 'browser/moz.configure');
  if (mozConfigure === null) {
    issues.push('browser/moz.configure is missing');
  } else if (!mozConfigure.includes('BROWSER_CHROME_URL')) {
    issues.push('browser/moz.configure does not mention BROWSER_CHROME_URL');
  }

  const browserJar = await readEngineText(engineDir, 'browser/base/jar.mn');
  if (browserJar === null) {
    issues.push('browser/base/jar.mn is missing');
  } else if (!/\.xhtml\b/.test(browserJar)) {
    issues.push('browser/base/jar.mn has no chrome document .xhtml entries');
  }

  const customElements = await readEngineText(engineDir, 'toolkit/content/customElements.js');
  if (customElements === null) {
    issues.push('toolkit/content/customElements.js is missing');
  } else if (!customElements.includes('customElements')) {
    issues.push('toolkit/content/customElements.js does not contain customElements registrations');
  }

  const toolkitJar = await readEngineText(engineDir, 'toolkit/content/jar.mn');
  if (toolkitJar === null) {
    issues.push('toolkit/content/jar.mn is missing');
  } else if (
    !toolkitJar.includes('content/global/widgets/') &&
    !toolkitJar.includes('content/global/elements/')
  ) {
    issues.push('toolkit/content/jar.mn has no widget/element exposure entries');
  }

  const browserTomls = await collectBrowserTomlFiles(engineDir);
  if (browserTomls.unreadable.length > 0) {
    issues.push(
      `could not read ${browserTomls.unreadable.length} ` +
        `${browserTomls.unreadable.length === 1 ? 'directory' : 'directories'} under ` +
        `browser/base/content/test: ${browserTomls.unreadable.join(', ')}`
    );
  } else if (browserTomls.files.length === 0) {
    issues.push('no browser.toml files found under browser/base/content/test');
  }

  if (issues.length === 0) {
    return ok('Post-rebase registration audit');
  }

  return warning(
    'Post-rebase registration audit',
    `${issues.length} suspicious registration surface${issues.length === 1 ? '' : 's'}: ${issues.join('; ')}.`,
    'Inspect the named engine paths, refresh any drifted registration patches, then re-run "fireforge doctor --post-rebase-audit".'
  );
}

export const POST_REBASE_AUDIT_CHECK: DoctorCheckDefinition = {
  name: 'Post-rebase registration audit',
  skipIf: (ctx) => !ctx.options.postRebaseAudit || !ctx.engineExists,
  dependsOn: ['fireforge.json is valid'],
  run: runPostRebaseAudit,
};
