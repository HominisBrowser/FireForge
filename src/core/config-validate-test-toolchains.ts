// SPDX-License-Identifier: EUPL-1.2
import { ConfigError } from '../errors/config.js';
import type { FireForgeConfig } from '../types/config.js';
import { parseObject } from '../utils/parse.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { isObject } from '../utils/validation.js';

type ConfigRecord = ReturnType<typeof parseObject>;

function optionalConfigString(rec: ConfigRecord, key: string, label: string): string | undefined {
  const value = rec.raw(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(`Config field "${label}" must be a string`);
  }
  return value;
}

function optionalConfigObject(rec: ConfigRecord, key: string): ConfigRecord | undefined {
  const value = rec.raw(key);
  if (value === undefined) return undefined;
  try {
    return rec.object(key);
  } catch {
    throw new ConfigError(`Config field "${key}" must be an object`);
  }
}

/** Parses the optional `test` block. */
export function parseTestBlock(rec: ConfigRecord, config: FireForgeConfig): void {
  const testRec = optionalConfigObject(rec, 'test');
  if (!testRec) return;

  const out: NonNullable<FireForgeConfig['test']> = {};
  const canaryPath = optionalConfigString(testRec, 'canaryPath', 'test.canaryPath');
  if (canaryPath !== undefined) {
    if (canaryPath.trim() === '' || !isContainedRelativePath(canaryPath)) {
      throw new ConfigError('Config field "test.canaryPath" must be a project-relative path');
    }
    out.canaryPath = canaryPath;
  }

  const canaryTimeout = testRec.raw('canaryTimeoutSeconds');
  if (canaryTimeout !== undefined) {
    if (
      typeof canaryTimeout !== 'number' ||
      !Number.isInteger(canaryTimeout) ||
      canaryTimeout < 1 ||
      canaryTimeout > 600
    ) {
      throw new ConfigError(
        'Config field "test.canaryTimeoutSeconds" must be an integer in 1..600'
      );
    }
    out.canaryTimeoutSeconds = canaryTimeout;
  }

  config.test = out;
}

/** Parses optional project-specific external toolchain doctor probes. */
export function parseExternalToolchainsBlock(rec: ConfigRecord, config: FireForgeConfig): void {
  const raw = rec.raw('externalToolchains');
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw new ConfigError('Config field "externalToolchains" must be an array');
  }

  config.externalToolchains = raw.map((entry: unknown, index) => {
    if (!isObject(entry)) {
      throw new ConfigError(
        `Config field "externalToolchains[${String(index)}]" must be an object`
      );
    }
    const item = entry;
    const name = item['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ConfigError(
        `Config field "externalToolchains[${String(index)}].name" must be a non-empty string`
      );
    }
    const tools = item['tools'];
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new ConfigError(
        `Config field "externalToolchains[${String(index)}].tools" must be a non-empty array`
      );
    }

    return {
      name,
      tools: tools.map((tool: unknown, toolIndex) =>
        parseExternalToolRequirement(tool, index, toolIndex)
      ),
    };
  });
}

function parseExternalToolRequirement(
  tool: unknown,
  index: number,
  toolIndex: number
): NonNullable<FireForgeConfig['externalToolchains']>[number]['tools'][number] {
  const label = `externalToolchains[${String(index)}].tools[${String(toolIndex)}]`;
  if (!isObject(tool)) {
    throw new ConfigError(`Config field "${label}" must be an object`);
  }
  const toolRec = tool;
  const toolName = toolRec['name'];
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    throw new ConfigError(`Config field "${label}.name" must be a non-empty string`);
  }
  const toolPath = toolRec['path'];
  if (toolPath !== undefined && (typeof toolPath !== 'string' || toolPath.trim() === '')) {
    throw new ConfigError(`Config field "${label}.path" must be a non-empty string`);
  }
  const xcrun = toolRec['xcrun'];
  if (xcrun !== undefined && typeof xcrun !== 'boolean') {
    throw new ConfigError(`Config field "${label}.xcrun" must be a boolean`);
  }
  const required = toolRec['required'];
  if (required !== undefined && typeof required !== 'boolean') {
    throw new ConfigError(`Config field "${label}.required" must be a boolean`);
  }
  return {
    name: toolName,
    ...(toolPath !== undefined ? { path: toolPath } : {}),
    ...(xcrun !== undefined ? { xcrun } : {}),
    ...(required !== undefined ? { required } : {}),
  };
}
