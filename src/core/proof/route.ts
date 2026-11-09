// SPDX-License-Identifier: EUPL-1.2
import { matchesAnyGlob } from '../../utils/path-glob.js';
import { assertSourcePath } from '../authored/paths.js';

export type RuntimeRoute =
  'source-link' | 'packaged' | 'component' | 'compiled' | 'test' | 'none' | 'unknown';

/** Named as a test: a harness can be asked to run it. */
export const isTestPath = (path: string): boolean =>
  /(?:^|\/)(?:browser_|test_)[^/]+\.[A-Za-z0-9]+$/.test(path);

/** A test the planner can run by itself without any declaration. */
export const isJsTestPath = (path: string): boolean =>
  /(?:^|\/)(?:browser_|test_)[^/]+\.(?:js|mjs)$/.test(path);

/** How an engine path reaches the runtime. Unknown means a full build rather than a guess. */
export function runtimeRoute(path: string): RuntimeRoute {
  assertSourcePath(path);
  if (
    /\.(?:c|cc|cpp|h|hpp|rs|webidl|idl|ipdl|in)$/.test(path) ||
    /(?:^|\/)(?:moz\.build|Cargo\.toml|configure[^/]*)$/.test(path)
  )
    return 'compiled';
  if (/^docs\//.test(path) || /\.(?:md|rst)$/i.test(path)) return 'none';
  if (/(?:^|\/)(?:test|tests)\//.test(path) || isTestPath(path)) return 'test';
  if (path.startsWith('components/')) return 'component';
  if (
    /\.(?:mjs|js|css|xhtml|html|ftl|svg|png|jpg|jpeg|webp)$/.test(path) &&
    /^(?:browser|toolkit)\//.test(path)
  )
    return 'source-link';
  if (/(?:^|\/)(?:jar\.mn|components\.conf|chrome\.manifest)$/.test(path)) return 'packaged';
  return 'unknown';
}

/** Root files no build or browser reads. Their tools are bound by the evidence's tool identity. */
const ROOT_METADATA =
  /^(?:docs\/|patches\/|\.github\/)|\.(?:md|rst)$|^(?:LICENSE|NOTICE|COPYING|AUTHORS|CHANGELOG)[^/]*$|^(?:\.gitignore|\.gitattributes|\.editorconfig|package\.json|package-lock\.json)$/i;

/**
 * How a project-root path reaches the runtime. A project can name further paths
 * with no runtime effect, but never the inputs a build reads.
 */
export function rootRoute(path: string, noneRoutes: readonly string[] = []): RuntimeRoute {
  assertSourcePath(path);
  if (path === 'furnace.json' || path.startsWith('components/')) return 'component';
  if (path.startsWith('configs/')) return 'compiled';
  if (path === 'fireforge.json') return 'unknown';
  return ROOT_METADATA.test(path) || matchesAnyGlob(path, noneRoutes) ? 'none' : 'unknown';
}
