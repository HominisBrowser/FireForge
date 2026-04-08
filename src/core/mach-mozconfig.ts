// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { MozconfigError } from '../errors/build.js';
import type { FireForgeConfig } from '../types/config.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { getPlatform } from '../utils/platform.js';

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

  await writeText(outputPath, content);
}
