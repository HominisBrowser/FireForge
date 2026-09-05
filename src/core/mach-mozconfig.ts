// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { MozconfigError } from '../errors/build.js';
import type { FireForgeConfig } from '../types/config.js';
import { pathExists, readText, writeTextIfChanged } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { getPlatform } from '../utils/platform.js';
import { BrandingMozconfigMismatchError, splitAppId } from './branding.js';

/**
 * Template variables for mozconfig generation.
 */
export interface MozconfigVariables {
  name: string;
  vendor: string;
  appId: string;
  binaryName: string;
}

/**
 * Replaces template variables in a string.
 * @param content - Content with ${variable} placeholders
 * @param variables - Variables to substitute
 * @returns Content with variables replaced
 */
function replaceVariables(content: string, variables: MozconfigVariables): string {
  return content
    .replace(/\$\{name\}/g, variables.name)
    .replace(/\$\{vendor\}/g, variables.vendor)
    .replace(/\$\{appId\}/g, variables.appId)
    .replace(/\$\{binaryName\}/g, variables.binaryName);
}

/**
 * Matches an `--with-branding=<path>` directive anywhere in a rendered
 * mozconfig. The directive form is the one mach reads, and an optional
 * `ac_add_options` prefix is the on-disk convention. `m` flag anchors the
 * search per-line so a multi-line mozconfig with older directives earlier
 * in the file doesn't confuse the extractor. We pick the last match
 * because mach itself takes the last-write-wins semantics of shell
 * configuration for overlapping `ac_add_options` calls.
 */
const WITH_BRANDING_PATTERN = /^\s*(?:ac_add_options\s+)?--with-branding\s*=\s*(\S+)/gm;

/**
 * Extracts the `--with-branding=<path>` value from a rendered mozconfig
 * body. Returns `undefined` when no directive is present, and callers treat
 * that as "mozconfig is missing branding", which is itself an actionable
 * configuration error.
 *
 * Exported for testing.
 */
export function extractWithBrandingPath(mozconfigContent: string): string | undefined {
  const matches = [...mozconfigContent.matchAll(WITH_BRANDING_PATTERN)];
  const last = matches.at(-1);
  return last?.[1];
}

/**
 * Matches a `MOZ_OBJDIR=<path>` declaration in a mozconfig. Both spellings
 * mach honours are accepted (`mk_add_options MOZ_OBJDIR=…`, the documented
 * one, and a bare `export MOZ_OBJDIR=…`), and the value may be quoted.
 * Last-write-wins for the same reason as {@link WITH_BRANDING_PATTERN}: a
 * mozconfig is shell.
 */
const MOZ_OBJDIR_PATTERN =
  /^\s*(?:mk_add_options\s+|export\s+)?MOZ_OBJDIR\s*=\s*["']?([^"'\s#]+)/gm;

/**
 * Extracts the objdir name a mozconfig declares: the single trailing path
 * segment, which is what the `obj-*` scan enumerates.
 *
 * `@TOPSRCDIR@` and a leading `./` are both spellings of "beside the
 * source", which is the only arrangement FireForge's scan can see anyway.
 * An absolute path outside the engine directory reduces to its basename and
 * simply will not match a candidate, which is the correct outcome. A
 * declaration that names something the scan cannot see must not select
 * anything.
 *
 * Returns undefined when nothing is declared. Exported for testing.
 */
export function extractMozObjdirName(mozconfigContent: string): string | undefined {
  const matches = [...mozconfigContent.matchAll(MOZ_OBJDIR_PATTERN)];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) return undefined;
  const trimmed = raw.replace(/\/+$/, '');
  const segment = trimmed.split('/').at(-1);
  return segment !== undefined && segment.length > 0 ? segment : undefined;
}

/**
 * Preflights the just-written mozconfig against the branding tree FireForge
 * set up. A drift between the two is silent-corruption territory: the
 * build runs, `mach configure` reads the stale directory name out of
 * mozconfig, and then the recursive make backend errors out with a "path
 * does not exist" message that names the branding dir the mozconfig
 * referenced. By parsing the mozconfig here and comparing to
 * `config.binaryName`, we turn that into a single-line actionable error
 * before `mach` runs.
 *
 * @param engineDir Path to the engine directory (the branding tree lives here)
 * @param mozconfigPath Path to the mozconfig just written
 * @param config FireForge configuration (reads `binaryName`)
 * @throws BrandingMozconfigMismatchError on drift or missing directive
 */
export async function assertBrandingMozconfigAgreement(
  engineDir: string,
  mozconfigPath: string,
  config: FireForgeConfig
): Promise<void> {
  const mozconfigContent = await readText(mozconfigPath);
  const found = extractWithBrandingPath(mozconfigContent);
  const expected = `browser/branding/${config.binaryName}`;

  if (!found) {
    throw new BrandingMozconfigMismatchError(
      expected,
      '(no --with-branding directive)',
      'mozconfig-missing-branding'
    );
  }

  // Normalise both sides to forward slashes before compare. Windows-edited
  // configs can carry backslash path separators that the build would treat
  // as literal characters in a repo-relative path.
  const normalizedFound = normalizePathSlashes(found);
  if (normalizedFound !== expected) {
    throw new BrandingMozconfigMismatchError(expected, found, 'name-mismatch');
  }

  // Last line of defence: even with matching names, a missing branding tree
  // means the scaffold step hasn't run. Preflight here so the operator
  // doesn't pay for a configure-through-build cycle to discover it.
  const brandingMozBuild = join(engineDir, expected, 'moz.build');
  if (!(await pathExists(brandingMozBuild))) {
    throw new BrandingMozconfigMismatchError(expected, found, 'branding-dir-missing');
  }
}

/**
 * Generates a mozconfig file from templates.
 * @param configsDir - Path to the configs directory
 * @param engineDir - Path to the engine directory
 * @param config - FireForge configuration
 */
export async function generateMozconfig(
  configsDir: string,
  engineDir: string,
  config: FireForgeConfig
): Promise<void> {
  const platform = getPlatform();
  const commonPath = join(configsDir, 'common.mozconfig');
  const platformPath = join(configsDir, `${platform}.mozconfig`);
  const outputPath = join(engineDir, 'mozconfig');

  const variables: MozconfigVariables = {
    name: config.name,
    vendor: config.vendor,
    appId: config.appId,
    binaryName: config.binaryName,
  };

  let content = '';

  // Bundle identity: branding configure.sh carries only the leaf of appId
  // (see splitAppId in branding.ts, and upstream composes the mac bundle id
  // as <distribution-id>.<MOZ_MACBUNDLE_ID>). The prefix travels here so the
  // two halves can never drift apart.
  const { distributionId } = splitAppId(config.appId);
  content +=
    `# FireForge identity (generated from fireforge.json appId)\n` +
    `ac_add_options --with-distribution-id=${distributionId}\n\n`;

  // Read common config if it exists
  if (await pathExists(commonPath)) {
    const commonContent = await readText(commonPath);
    content += `# Common configuration\n${replaceVariables(commonContent, variables)}\n\n`;
  }

  // Read platform-specific config
  if (!(await pathExists(platformPath))) {
    throw new MozconfigError(`Platform mozconfig not found: ${platformPath}`);
  }

  const platformContent = await readText(platformPath);
  content += `# Platform configuration (${platform})\n${replaceVariables(platformContent, variables)}`;

  // Write-if-changed: `mozconfig` is a mach configure input, so its mtime,
  // not its content, is what `config.status` compares against.
  // Rewriting a byte-identical file on every build-capable invocation made
  // mach re-run `configure` plus backend regeneration ("Backend config
  // changed; N files touched") on every run, each run re-arming the next.
  // Only touch the file when the rendered content actually differs.
  const wrote = await writeTextIfChanged(outputPath, content);
  if (!wrote) {
    verbose(`mozconfig already up to date (content unchanged): ${outputPath}`);
  }

  // Preflight: the mozconfig we just wrote must reference the branding
  // directory FireForge actually set up. Catching the drift here (after the
  // write, before anything consumes mozconfig) keeps `generateMozconfig`
  // the single source of truth for both the render and the sanity-check.
  await assertBrandingMozconfigAgreement(engineDir, outputPath, config);
}
