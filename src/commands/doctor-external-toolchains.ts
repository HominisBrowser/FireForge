// SPDX-License-Identifier: EUPL-1.2
import { isAbsolute, resolve } from 'node:path';

import type { DoctorCheck } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { exec, findExecutable } from '../utils/process.js';
import type { DoctorCheckContext, DoctorCheckDefinition } from './doctor-check-core.js';
import { failure, ok, warning } from './doctor-check-core.js';

async function resolveDeclaredTool(
  projectRoot: string,
  tool: { name: string; path?: string; xcrun?: boolean }
): Promise<string | undefined> {
  if (tool.path !== undefined) {
    const candidate = isAbsolute(tool.path) ? tool.path : resolve(projectRoot, tool.path);
    return (await pathExists(candidate)) ? candidate : undefined;
  }
  if (tool.xcrun === true) {
    try {
      const found = await exec('xcrun', ['-find', tool.name], { timeout: 5000 });
      const line = found.stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0);
      return found.exitCode === 0 ? line?.trim() : undefined;
    } catch {
      // `xcrun -find` is absent or the tool is unknown. Either way the tool
      // has no resolvable path, which is what `undefined` means to the caller.
      return undefined;
    }
  }
  return findExecutable(tool.name);
}

async function runExternalToolchainChecks(ctx: DoctorCheckContext): Promise<DoctorCheck[]> {
  const toolchains = ctx.config?.externalToolchains;
  if (!toolchains || toolchains.length === 0) return [];

  const rows: DoctorCheck[] = [];
  for (const toolchain of toolchains) {
    for (const tool of toolchain.tools) {
      const label = `External toolchain: ${toolchain.name}/${tool.name}`;
      const found = await resolveDeclaredTool(ctx.projectRoot, tool);
      if (found !== undefined) {
        rows.push(ok(label, `OK (${found})`));
        continue;
      }
      const required = tool.required !== false;
      const location = tool.path
        ? `at ${tool.path}`
        : tool.xcrun
          ? `via xcrun -find ${tool.name}`
          : 'on PATH';
      const message = `${tool.name} was not found ${location}.`;
      const fix = `Install ${tool.name} or update fireforge.json externalToolchains for ${toolchain.name}.`;
      rows.push(required ? failure(label, message, fix) : warning(label, message, fix));
    }
  }
  return rows;
}

/** Doctor check for opt-in project-declared external asset/toolchain requirements. */
export const EXTERNAL_TOOLCHAIN_DOCTOR_CHECK: DoctorCheckDefinition = {
  name: 'External toolchains',
  dependsOn: ['fireforge.json is valid'],
  run: runExternalToolchainChecks,
};
