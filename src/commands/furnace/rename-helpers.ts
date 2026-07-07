// SPDX-License-Identifier: EUPL-1.2
import { updateFurnaceState } from '../../core/furnace-config.js';
import type { FurnaceConfig } from '../../types/furnace.js';

/**
 * Applies a component rename to scaffold-owned filenames only.
 */
export function renameComponentFileName(
  fileName: string,
  oldName: string,
  newName: string
): string {
  if (fileName === oldName) return newName;
  if (fileName.startsWith(oldName + '.')) {
    return newName + fileName.slice(oldName.length);
  }
  return fileName;
}

/**
 * Re-keys a custom component config entry and same-config compose references.
 */
export function updateConfigForCustomRename(
  config: FurnaceConfig,
  oldName: string,
  newName: string
): void {
  const oldConfig = config.custom[oldName];
  if (!oldConfig) return;

  config.custom[newName] = {
    ...oldConfig,
    targetPath: oldConfig.targetPath.replace(new RegExp(`(^|/)${oldName}$`), `$1${newName}`),
  };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- idiomatic key removal from config record
  delete config.custom[oldName];

  for (const customConfig of Object.values(config.custom)) {
    if (customConfig.composes) {
      customConfig.composes = customConfig.composes.map((ref) => (ref === oldName ? newName : ref));
    }
  }
}

/**
 * Re-keys an override component config entry.
 */
export function updateConfigForOverrideRename(
  config: FurnaceConfig,
  oldName: string,
  newName: string
): void {
  const oldConfig = config.overrides[oldName];
  if (!oldConfig) return;

  config.overrides[newName] = { ...oldConfig };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- idiomatic key removal from config record
  delete config.overrides[oldName];
}

/**
 * Re-keys checksum entries in furnace-state.json from the old component name
 * to the new name so that `doctor` doesn't flag stale entries and the next
 * `apply` can correctly detect whether the renamed component has changed.
 */
export async function rekeyStateChecksums(
  projectRoot: string,
  componentType: string,
  oldName: string,
  newName: string
): Promise<void> {
  const oldPrefix = `${componentType}/${oldName}/`;
  const newPrefix = `${componentType}/${newName}/`;

  await updateFurnaceState(projectRoot, (state) => {
    const result = { ...state };
    for (const field of ['appliedChecksums', 'engineChecksums'] as const) {
      const checksums = state[field];
      if (!checksums) continue;
      const updated: Record<string, string> = {};
      for (const [key, value] of Object.entries(checksums)) {
        if (key.startsWith(oldPrefix)) {
          updated[newPrefix + key.slice(oldPrefix.length)] = value;
        } else {
          updated[key] = value;
        }
      }
      result[field] = updated;
    }
    return result;
  });
}
