// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';

const expectedNode = (await readFile(new URL('../.nvmrc', import.meta.url), 'utf8')).trim();
const { packageManager } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
if (!/^\d+\.\d+\.\d+$/.test(expectedNode) || !/^npm@\d+\.\d+\.\d+$/.test(packageManager)) {
  throw new Error('Release toolchain pins must name exact Node and npm versions');
}
const expectedNpm = packageManager.slice(4);
const actualNpm = /^npm\/([^ ]+)/.exec(process.env.npm_config_user_agent ?? '')?.[1];
const failures = [];
if (process.versions.node !== expectedNode) {
  failures.push(`Node ${expectedNode} required by .nvmrc; found ${process.versions.node}`);
}
if (actualNpm !== expectedNpm) {
  failures.push(
    `npm ${expectedNpm} required by packageManager; found ${actualNpm ?? 'no npm invocation'}`
  );
}
if (failures.length > 0) {
  console.error(
    `Release toolchain mismatch:\n${failures.join('\n')}\nUse the pinned tools and run npm run release:check.`
  );
  process.exitCode = 1;
} else {
  console.log(`Release toolchain: Node ${expectedNode}, npm ${expectedNpm}`);
}
