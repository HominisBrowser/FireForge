// SPDX-License-Identifier: EUPL-1.2
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
