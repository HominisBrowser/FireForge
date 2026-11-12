// SPDX-License-Identifier: EUPL-1.2
/**
 * Token coverage of the owned stylesheets: how many of their values come
 * from a project token and how many are raw colors or custom properties
 * that belong to nobody the project knows.
 */
import { cssVarReferences, customProperties, parseCss, rawColors } from '../syntax/index.js';
import { type OwnedFiles, type TokenSettings } from './settings.js';

/** Counts for one stylesheet. */
export interface CoverageFile {
  file: string;
  /** `var(--<prefix>...)` references. */
  tokenUsages: number;
  /** References to exempt or platform custom properties. */
  allowlisted: number;
  /** References to any other custom property. */
  unknownVars: number;
  /** Hex, `rgb()` and `hsl()` colors. */
  rawColors: number;
}

/** Coverage over a set of stylesheets. */
export interface CoverageReport {
  files: CoverageFile[];
  /** Tokens as a percentage of tokens, unknown variables and raw colors; 100 when there are none. */
  percent: number;
  tokenUsages: number;
  allowlisted: number;
  unknownVars: number;
  rawColors: number;
  /** Custom properties the token file declares without the project prefix. */
  foreignDeclarations: string[];
}

function measure(file: string, css: string, settings: TokenSettings): CoverageFile {
  const sheet = parseCss(css);
  const entry: CoverageFile = {
    file,
    tokenUsages: 0,
    allowlisted: 0,
    unknownVars: 0,
    rawColors: 0,
  };
  for (const { name } of cssVarReferences(sheet)) {
    if (name.startsWith(settings.prefix)) entry.tokenUsages++;
    else if (
      settings.exempt.has(name) ||
      settings.platformPrefixes.some((prefix) => name.startsWith(prefix))
    ) {
      entry.allowlisted++;
    } else entry.unknownVars++;
  }
  entry.rawColors = rawColors(sheet).length;
  return entry;
}

/**
 * Measures the owned stylesheets other than the token file, which is judged
 * only for declarations outside the project prefix.
 *
 * @param tokenFile - Engine path of the token file
 * @param owned - The project's owned files
 * @param settings - The project's token conventions
 */
export async function measureCoverage(
  tokenFile: string,
  owned: OwnedFiles,
  settings: TokenSettings
): Promise<CoverageReport> {
  const files: CoverageFile[] = [];
  for (const path of owned.paths.filter((p) => p.endsWith('.css') && p !== tokenFile).sort()) {
    const css = await owned.read(path);
    if (css !== undefined) files.push(measure(path, css, settings));
  }
  const sum = (pick: (file: CoverageFile) => number): number =>
    files.reduce((total, file) => total + pick(file), 0);
  const tokenUsages = sum((f) => f.tokenUsages);
  const unknownVars = sum((f) => f.unknownVars);
  const rawColors = sum((f) => f.rawColors);
  const total = tokenUsages + unknownVars + rawColors;
  const tokens = owned.paths.includes(tokenFile) ? await owned.read(tokenFile) : undefined;
  return {
    files,
    percent: total === 0 ? 100 : Math.round((tokenUsages / total) * 100),
    tokenUsages,
    allowlisted: sum((f) => f.allowlisted),
    unknownVars,
    rawColors,
    foreignDeclarations: [
      ...new Set(
        (tokens === undefined ? [] : customProperties(parseCss(tokens)))
          .map((declaration) => declaration.name)
          .filter((name) => !name.startsWith(settings.prefix))
      ),
    ].sort(),
  };
}
