// SPDX-License-Identifier: EUPL-1.2
import { updateFurnaceState } from './furnace-config.js';

/** A filtered build replaces its own checksum namespace without erasing deployed peers. */
export async function persistAppliedComponentChecksums(
  root: string,
  checksums: ReadonlyMap<string, string>,
  componentName: string | undefined
): Promise<void> {
  const appliedChecksums = Object.fromEntries(checksums);
  if (componentName === undefined) {
    await updateFurnaceState(root, {
      lastApply: new Date().toISOString(),
      appliedChecksums,
      engineChecksums: appliedChecksums,
    });
    return;
  }
  const keepOtherComponents = (
    current: Record<string, string> | undefined
  ): Record<string, string> =>
    Object.fromEntries(
      Object.entries(current ?? {}).filter(([key]) => {
        const [type, name] = key.split('/');
        return (type !== 'custom' && type !== 'override') || name !== componentName;
      })
    );
  await updateFurnaceState(root, (current) => ({
    ...current,
    lastApply: new Date().toISOString(),
    appliedChecksums: { ...keepOtherComponents(current.appliedChecksums), ...appliedChecksums },
    engineChecksums: { ...keepOtherComponents(current.engineChecksums), ...appliedChecksums },
  }));
}
