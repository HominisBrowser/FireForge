// SPDX-License-Identifier: EUPL-1.2
/**
 * The post-build audit reads `dist/` once, however many sources ask about it,
 * and reports nothing for what the previous build already packaged. Real git and
 * a real tree; `readdir` is wrapped only to count.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const walks = vi.hoisted(() => ({ dirs: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: ((path: string, options: never) => {
      walks.dirs.push(path);
      return actual.readdir(path, options);
    }) as typeof actual.readdir,
  };
});
vi.mock('../../utils/logger.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createLoggerMock()
);

import { warn } from '../../utils/logger.js';
import { auditBuildArtifacts } from '../build-audit.js';

const SOURCES = 40;

describe('auditBuildArtifacts over a large dist', () => {
  let root: string;
  let engine: string;
  let dist: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    walks.dirs = [];
    root = await mkdtemp(join(tmpdir(), 'fireforge-audit-walks-'));
    engine = join(root, 'engine');
    dist = join(engine, 'obj-x', 'dist');
    await mkdir(join(dist, 'bin', 'chrome'), { recursive: true });
    for (let index = 0; index < 50; index += 1) {
      await writeFile(join(dist, 'bin', 'chrome', `packaged-${index}.js`), '');
    }
    await mkdir(join(engine, 'browser', 'modules'), { recursive: true });
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: engine, stdio: 'ignore' });
    };
    run('init', '-q');
    await writeFile(join(engine, '.gitignore'), 'obj-*/\n');
    run('add', '.');
    run('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'pristine');
    for (let index = 0; index < SOURCES; index += 1) {
      await writeFile(join(engine, 'browser', 'modules', `source-${index}.mjs`), `// ${index}\n`);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('walks each dist directory once for every unresolved source', async () => {
    const summary = await auditBuildArtifacts(root, engine, undefined);
    expect(summary.missing).toBe(SOURCES);
    const distWalks = walks.dirs.filter((dir) => dir.startsWith(dist));
    expect(distWalks.filter((dir) => dir === dist)).toHaveLength(1);
    expect(new Set(distWalks).size).toBe(distWalks.length);
  });

  it('still names the same-basename artifact each source resolves to', async () => {
    await mkdir(join(dist, 'bin', 'modules'), { recursive: true });
    await writeFile(join(dist, 'bin', 'modules', 'source-1.mjs'), '');
    await writeFile(join(dist, 'bin', 'chrome', 'source-1.mjs'), '');
    const summary = await auditBuildArtifacts(root, engine, undefined);
    const entry = summary.entries.find((item) => item.source === 'browser/modules/source-1.mjs');
    expect(entry?.artifact).toBe(join(dist, 'bin', 'modules', 'source-1.mjs'));
  });

  it('reports nothing for a path byte-identical to what the previous build recorded', async () => {
    const fingerprints: Record<string, string> = {};
    for (let index = 0; index < SOURCES; index += 1) {
      fingerprints[`browser/modules/source-${index}.mjs`] = createHash('sha256')
        .update(`// ${index}\n`)
        .digest('hex');
    }
    await writeFile(join(engine, 'browser', 'modules', 'source-3.mjs'), '// edited\n');
    const summary = await auditBuildArtifacts(root, engine, {
      engineHeadSha: '',
      builtAt: '2026-01-01T00:00:00.000Z',
      packageableFingerprints: fingerprints,
    } as never);
    expect(summary.entries.map((entry) => entry.source)).toEqual(['browser/modules/source-3.mjs']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
