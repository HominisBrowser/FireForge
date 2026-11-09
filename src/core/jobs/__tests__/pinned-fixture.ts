// SPDX-License-Identifier: EUPL-1.2
/** A built FireForge package on disk, small enough to pin in a test. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const put = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/** The executor fingerprint a fixture package reports unless told another. */
export const EXECUTOR = 'e'.repeat(64);

/**
 * A built FireForge package: its CLI answers `prove measure-tools` with an
 * executor fingerprint, and its supervisor entry leaves a mark and stops.
 */
export async function fakePackage(
  root: string,
  options: { executor?: string; marker?: string; modules?: string; cliExit?: number } = {}
): Promise<string> {
  const modules = options.modules ?? join(root, 'node_modules');
  await put(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@fixture/fireforge',
      version: '9.9.9',
      bin: { fireforge: './dist/bin/fireforge.js' },
      dependencies: { dep: '1.0.0' },
      devDependencies: { devonly: '1.0.0' },
    })
  );
  await put(
    join(root, 'dist/bin/fireforge.js'),
    options.cliExit === undefined
      ? `console.log(JSON.stringify({ executor: '${options.executor ?? EXECUTOR}', environment: 'x', answers: [] }));\n`
      : `process.stderr.write('broken build\\n'); process.exit(${String(options.cliExit)});\n`
  );
  await put(
    join(root, 'dist/src/core/jobs/supervisor-main.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(options.marker ?? join(root, 'ran'))}, process.argv.slice(2).join(' '));\nprocess.stderr.write('pinned supervisor ran\\n');\nprocess.exit(1);\n`
  );
  await put(join(root, 'dist/src/core/jobs/__tests__/x.test.js'), 'test\n');
  await put(join(root, 'dist/src/core/jobs/client.js.map'), '{}\n');
  await put(join(root, 'dist/src/core/jobs/client.d.ts'), 'export {};\n');
  await put(
    join(root, 'dist/build-info.json'),
    JSON.stringify({ schemaVersion: 1, shortCommit: 'abc1234', dirty: false })
  );
  await put(join(root, 'runtime/qualified-node-bootstrap.cjs'), '// bootstrap\n');
  await put(
    join(modules, 'dep/package.json'),
    JSON.stringify({ name: 'dep', version: '1.0.0', dependencies: { nested: '1.0.0' } })
  );
  await put(join(modules, 'dep/index.js'), 'module.exports = 1;\n');
  await put(
    join(modules, 'nested/package.json'),
    JSON.stringify({ name: 'nested', version: '1.0.0' })
  );
  await put(join(modules, 'nested/index.js'), 'module.exports = 2;\n');
  await put(
    join(modules, 'devonly/package.json'),
    JSON.stringify({ name: 'devonly', version: '1.0.0' })
  );
  return root;
}
