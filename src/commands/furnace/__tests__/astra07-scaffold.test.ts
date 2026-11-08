// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authorFs from '../../../core/authored/fs.js';
import { runFurnaceMutation } from '../../../core/furnace-operation.js';
import {
  createTempProject,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../../test-utils/index.js';
import { info } from '../../../utils/logger.js';
import { furnaceChromeDocCreateCommand } from '../chrome-doc.js';
import { furnaceChromeDocRemoveCommand } from '../chrome-doc-remove.js';
import { generateBrowserWindowXhtml, generateChromeDocCss } from '../chrome-doc-templates.js';
import { generateChromeDocPackagingTest } from '../chrome-doc-tests.js';

vi.mock('../../../utils/logger.js', async () => {
  const { createLoggerMock } = await import('../../../test-utils/module-mocks.js');
  return createLoggerMock();
});
const outputs = [
  'browser/base/content/demo.xhtml',
  'browser/base/content/demo.js',
  'browser/themes/shared/demo-chrome.css',
  'browser/locales/en-US/browser/demo.ftl',
  'browser/base/content/test/mybrowser-xpcshell/demo/test_demo_packaging.js',
  'browser/base/content/test/mybrowser-xpcshell/demo/xpcshell.toml',
];
const jars = ['browser/base/jar.mn', 'browser/themes/shared/jar.inc.mn', 'browser/locales/jar.mn'];
const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => {
    throw new Error('uninitialized barrier');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('A07 scaffold ownership and removal', () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempProject('fireforge-a07-scaffold-');
    await writeFireForgeConfig(root);
    await writeFiles(
      root,
      Object.fromEntries(jars.map((path) => [`engine/${path}`, '# fixture\r\n']))
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempProject(root);
  });

  it.each(outputs)(
    'refuses an existing output %s without changing it or any registration',
    async (path) => {
      await writeFiles(root, { [`engine/${path}`]: 'existing peer bytes' });
      await expect(
        furnaceChromeDocCreateCommand(root, 'demo', { withTests: true })
      ).rejects.toThrow(/already exists/);
      expect(await readFile(join(root, 'engine', path), 'utf8')).toBe('existing peer bytes');
      for (const jar of jars)
        expect(await readFile(join(root, 'engine', jar), 'utf8')).toBe('# fixture\r\n');
    }
  );

  it('rechecks outputs after a completed peer write under the same mutation lock', async () => {
    const entered = defer(),
      release = defer(),
      checked = defer();
    const realExists = authorFs.pathExists;
    const destination = join(root, 'engine/browser/base/content/demo.js');
    vi.spyOn(authorFs, 'pathExists').mockImplementation(async (path) => {
      const exists = await realExists(path);
      if (path === destination && !exists) checked.resolve();
      return exists;
    });
    const peer = runFurnaceMutation(root, 'create-rollback', async () => {
      entered.resolve();
      await release.promise;
      await writeFiles(root, { 'engine/browser/base/content/demo.js': 'winner bytes' });
    });
    await entered.promise;
    const losing = furnaceChromeDocCreateCommand(root, 'demo');
    const refusal = expect(losing).rejects.toThrow(/already exists/);
    await checked.promise;
    release.resolve();
    await peer;
    await refusal;
    expect(await readFile(destination, 'utf8')).toBe('winner bytes');
    expect(await realExists(join(root, 'engine/browser/base/content/demo.xhtml'))).toBe(false);
  });

  it('removes CRLF registrations with trailing whitespace and preserves unrelated lines exactly', async () => {
    await furnaceChromeDocCreateCommand(root, 'demo');
    for (const jar of jars) {
      const path = join(root, 'engine', jar);
      const text = await readFile(path, 'utf8');
      await writeFiles(root, {
        [`engine/${jar}`]:
          text
            .split(/\r?\n/)
            .filter(Boolean)
            .flatMap((line) => (line.includes('demo') ? [line, line] : [line]))
            .map((line) => line + '  \r\n')
            .join('') + '# peer unchanged\r\n',
      });
    }
    await furnaceChromeDocRemoveCommand(root, 'demo', { yes: true });
    for (const jar of jars) {
      const text = await readFile(join(root, 'engine', jar), 'utf8');
      expect(text).not.toContain('demo.');
      expect(text).not.toContain('demo-chrome');
      expect(text).toBe('# fixture  \r\n# peer unchanged\r\n');
    }
    expect(
      vi.mocked(info).mock.calls.some(([message]) => message.includes('and 8 jar registrations'))
    ).toBe(true);
  });

  it('targets the actual browser-window root with its shared scaffold selector', () => {
    expect(generateBrowserWindowXhtml('demo', 'MPL-2.0')).toContain(
      'data-furnace-chrome-doc="demo"'
    );
    expect(generateChromeDocCss('demo', true, '/* fixture */')).toContain(
      '[data-furnace-chrome-doc="demo"] {'
    );
    expect(generateChromeDocCss('demo', true, '')).not.toContain('#demo-window {');
  });
});

describe('A07 generated packaging probe executes every artifact assertion', () => {
  const primary = 'chrome/browser/content/browser/';
  const localizations = [
    'localization/en-US/browser/demo.ftl',
    'browser/localization/en-US/browser/demo.ftl',
    'chrome/browser/locale/browser/demo.ftl',
    'browser/chrome/browser/locale/browser/demo.ftl',
  ];
  async function execute(files: ReadonlySet<string>): Promise<void> {
    let task: unknown;
    const makeFile = (segments: string[] = []): object => ({
      clone: () => makeFile([...segments]),
      append: (segment: string) => {
        segments.push(segment);
      },
      exists: () => files.has(segments.join('/')),
      fileSize: 1,
      get path() {
        return '/app/' + segments.join('/');
      },
    });
    runInNewContext(generateChromeDocPackagingTest('demo', '// fixture'), {
      add_task: (callback: unknown) => {
        task = callback;
      },
      Services: { dirsvc: { get: () => makeFile() } },
      Ci: { nsIFile: {} },
      Assert: {
        ok: (value: boolean, message: string) => {
          if (!value) throw new Error(message);
        },
        greater: (value: number, minimum: number, message: string) => {
          if (value <= minimum) throw new Error(message);
        },
      },
    });
    if (typeof task !== 'function') throw new Error('generated task was not registered');
    const run = task as () => unknown;
    const result = run();
    await Promise.resolve(result);
  }
  it.each(localizations)('accepts the supported localization layout %s', async (ftl) => {
    await execute(
      new Set([primary + 'demo.xhtml', primary + 'demo.js', primary + 'demo-chrome.css', ftl])
    );
  });
  it.each(['demo.xhtml', 'demo.js', 'demo-chrome.css', 'demo.ftl'])(
    'fails when required %s is omitted',
    async (missing) => {
      const paths = [
        primary + 'demo.xhtml',
        primary + 'demo.js',
        primary + 'demo-chrome.css',
        localizations[0] ?? '',
      ];
      await expect(
        execute(new Set(paths.filter((path) => !path.endsWith('/' + missing))))
      ).rejects.toThrow(missing);
    }
  );
});
