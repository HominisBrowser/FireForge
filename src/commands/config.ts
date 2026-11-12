// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand } from '../cli/command.js';
import { getConfigValue, setConfigValue } from '../config/index.js';
import type { JsonValue } from '../kernel/json.js';
import { findProjectRoot } from '../project/index.js';

function shown(value: JsonValue | undefined): string {
  if (value === undefined) return '(not set)';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const get = defineCommand({
  name: 'get',
  summary: 'Print a key of fireforge.json',
  args: { key: arg.string('Key path, such as firefox.version or gate.lanes[0].files') },
  json: true,
  run: async (ctx, { key }) => {
    const entry = await getConfigValue(await findProjectRoot(ctx.cwd), key);
    const fallback =
      entry.value === undefined && entry.defaultValue !== undefined
        ? ` (default ${shown(entry.defaultValue)})`
        : '';
    ctx.out.line(`${shown(entry.value)}${fallback}`);
    ctx.out.json({
      key,
      value: entry.value ?? null,
      default: entry.defaultValue ?? null,
      type: entry.type,
      doc: entry.doc ?? null,
    });
  },
});

const set = defineCommand({
  name: 'set',
  summary: 'Set a key of fireforge.json, validating the whole file first',
  description:
    'The value is read as JSON when the key accepts that (4, true, ["a"]) and as text otherwise. ' +
    'Only the changed value is rewritten; the rest of the file keeps its layout. "mode" is not ' +
    'changed this way: "fireforge migrate --to-source" moves a project to source mode, and the way back is ' +
    '"fireforge export", then setting "mode" to "patches" and removing "source" by hand.',
  args: {
    key: arg.string('Key path, such as build.jobs'),
    value: arg.string('The new value'),
  },
  json: true,
  run: async (ctx, { key, value }) => {
    const edit = await setConfigValue(await findProjectRoot(ctx.cwd), key, value);
    ctx.out.line(`${key} = ${shown(edit.value)}${edit.changed ? '' : ' (unchanged)'}`);
    ctx.out.json({ key, value: edit.value, changed: edit.changed });
  },
});

export const config = defineCommand({
  name: 'config',
  summary: 'Read or edit fireforge.json through its schema',
  group: 'Project',
  subcommands: [get, set],
});
