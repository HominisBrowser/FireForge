// SPDX-License-Identifier: EUPL-1.2
import { lstat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { loadState } from '../core/config.js';
import { furnaceConfigExists, getFurnacePaths, loadFurnaceConfig } from '../core/furnace-config.js';
import { resolveFtlDir } from '../core/furnace-constants.js';
import { isOverrideCopyCandidate } from '../core/furnace-source-files.js';
import { isGitRepository } from '../core/git.js';
import { chunkPathspecs, git } from '../core/git-base.js';
import { parseDiffSections } from '../core/patch-parse.js';
import { getNodeErrorCode } from '../utils/errors.js';
import { isPathInsideRoot } from '../utils/paths.js';

/** Queue postimages and committed baseline supply registrations, never a stray engine file. */
export async function registrationSupplies(
  root: string,
  engine: string,
  bodies: string[],
  targets: string[]
): Promise<Set<string>> {
  const sections = bodies.flatMap(parseDiffSections);
  const selected = [
    ...new Set([
      ...targets,
      ...sections.flatMap((section) => [section.sourcePath, section.targetPath]),
    ]),
  ];
  const supplied = new Set<string>();
  if (await isGitRepository(engine)) {
    const ref = (await loadState(root)).baseCommit ?? 'HEAD';
    for (const chunk of chunkPathspecs(selected)) {
      const output = await git(['ls-tree', '-r', ref, '--name-only', '-z', '--', ...chunk], engine);
      for (const path of output.split('\0')) if (path.length > 0) supplied.add(path);
    }
  }
  await addFurnaceSupplies(root, targets, supplied);
  for (const section of sections) {
    if (section.isDeletedFile) supplied.delete(section.sourcePath);
    else if (section.isNewFile) supplied.add(section.targetPath);
    else if (section.sourcePath !== section.targetPath && supplied.has(section.sourcePath)) {
      supplied.delete(section.sourcePath);
      supplied.add(section.targetPath);
    }
    // A modification does not conjure a missing baseline file into existence.
  }
  return supplied;
}

async function addFurnaceSupplies(
  root: string,
  targets: string[],
  supplied: Set<string>
): Promise<void> {
  // Furnace owns source files explicitly declared by its config. Projection
  // existence is insufficient; a real component source must supply the target.
  if (await furnaceConfigExists(root)) {
    const config = await loadFurnaceConfig(root),
      paths = getFurnacePaths(root);
    for (const target of targets) {
      for (const [name, component] of Object.entries(config.custom)) {
        const suffix = relative(component.targetPath, target);
        const source = join(paths.customDir, name, suffix);
        if (
          suffix &&
          basename(suffix) === suffix &&
          /\.(mjs|css)$/.test(suffix) &&
          isPathInsideRoot(join(paths.customDir, name), source) &&
          (await regularFile(source))
        )
          supplied.add(target);
        if (
          component.localized &&
          !component.sharedFtl &&
          target === `${resolveFtlDir(config.ftlBasePath)}/${name}.ftl` &&
          (await regularFile(join(paths.customDir, name, `${name}.ftl`)))
        )
          supplied.add(target);
      }
      for (const [name, component] of Object.entries(config.overrides)) {
        const suffix = relative(component.basePath, target),
          source = join(paths.overridesDir, name, suffix);
        if (
          suffix &&
          basename(suffix) === suffix &&
          isOverrideCopyCandidate(suffix, component.type) &&
          isPathInsideRoot(join(paths.overridesDir, name), source) &&
          (await regularFile(source))
        )
          supplied.add(target);
        const locale = relative(resolveFtlDir(config.ftlBasePath), target);
        if (
          component.type === 'full' &&
          basename(locale) === locale &&
          locale.endsWith('.ftl') &&
          (await regularFile(join(paths.overridesDir, name, locale)))
        )
          supplied.add(target);
      }
    }
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
