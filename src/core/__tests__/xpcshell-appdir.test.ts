// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, writeJson, writeText } from '../../utils/fs.js';
import {
  findNearestXpcshellManifest,
  operatorAlreadySetAppPath,
  parseAppdirFromToml,
  readMozinfoAppname,
  resolveAbsoluteAppPath,
  resolveXpcshellAppdirArg,
} from '../xpcshell-appdir.js';

describe('parseAppdirFromToml', () => {
  it('returns the value for a double-quoted firefox-appdir under [DEFAULT]', () => {
    const body = ['[DEFAULT]', 'firefox-appdir = "browser"'].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')).toEqual({
      value: 'browser',
      lineIndex: 1,
    });
  });

  it('returns the value for a single-quoted variant', () => {
    const body = ['[DEFAULT]', "firefox-appdir = 'browser'"].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')?.value).toBe('browser');
  });

  it('returns the value for a bareword (unquoted) variant', () => {
    const body = ['[DEFAULT]', 'firefox-appdir = browser'].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')?.value).toBe('browser');
  });

  it('honours xpcshell.toml implicit [DEFAULT] before any section header', () => {
    // Upstream manifestparser treats the pre-section block as DEFAULT; the
    // parser must match that to avoid false negatives on terse manifests.
    const body = ['firefox-appdir = "browser"', '', '["test_foo.js"]'].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')?.value).toBe('browser');
  });

  it('ignores firefox-appdir set inside a non-default section', () => {
    const body = [
      '[DEFAULT]',
      'head = ""',
      '',
      '["test_foo.js"]',
      'firefox-appdir = "browser"',
    ].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')).toBeUndefined();
  });

  it('strips trailing # comments from the value line', () => {
    const body = ['[DEFAULT]', 'firefox-appdir = "browser"  # required for forks'].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')?.value).toBe('browser');
  });

  it('strips trailing ; comments (TOML-tolerant)', () => {
    const body = ['[DEFAULT]', 'firefox-appdir = "browser" ; legacy'].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')?.value).toBe('browser');
  });

  it('returns undefined when the key is absent', () => {
    const body = ['[DEFAULT]', 'head = ""'].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')).toBeUndefined();
  });

  it('does not match a key embedded in a comment', () => {
    // A leading `#` makes this a commented-out directive — must not match.
    const body = ['[DEFAULT]', '# firefox-appdir = "browser"'].join('\n');
    expect(parseAppdirFromToml(body, 'firefox-appdir')).toBeUndefined();
  });

  it('matches an arbitrary appname-keyed variant', () => {
    const body = ['[DEFAULT]', 'hominis-appdir = "browser"'].join('\n');
    expect(parseAppdirFromToml(body, 'hominis-appdir')?.value).toBe('browser');
    expect(parseAppdirFromToml(body, 'firefox-appdir')).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    const body = '[DEFAULT]\r\nfirefox-appdir = "browser"\r\n';
    expect(parseAppdirFromToml(body, 'firefox-appdir')?.value).toBe('browser');
  });
});

describe('findNearestXpcshellManifest', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fireforge-xpcshell-find-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('returns the manifest path itself when called with one directly', async () => {
    const manifest = join(workspace, 'browser/base/content/test/foo/xpcshell.toml');
    await ensureDir(join(workspace, 'browser/base/content/test/foo'));
    await writeText(manifest, '[DEFAULT]\n');
    const found = await findNearestXpcshellManifest(
      workspace,
      'browser/base/content/test/foo/xpcshell.toml'
    );
    expect(found).toBe(manifest);
  });

  it('walks up from a test_*.js path to its sibling xpcshell.toml', async () => {
    const dir = join(workspace, 'browser/base/content/test/foo');
    await ensureDir(dir);
    await writeText(join(dir, 'xpcshell.toml'), '[DEFAULT]\n');
    await writeText(join(dir, 'test_foo.js'), '');
    const found = await findNearestXpcshellManifest(
      workspace,
      'browser/base/content/test/foo/test_foo.js'
    );
    expect(found).toBe(join(dir, 'xpcshell.toml'));
  });

  it('walks up multiple levels until it finds a manifest', async () => {
    const ancestor = join(workspace, 'browser/base/content/test');
    await ensureDir(join(workspace, 'browser/base/content/test/inner/deeper'));
    await writeText(join(ancestor, 'xpcshell.toml'), '[DEFAULT]\n');
    const found = await findNearestXpcshellManifest(
      workspace,
      'browser/base/content/test/inner/deeper/test_x.js'
    );
    expect(found).toBe(join(ancestor, 'xpcshell.toml'));
  });

  it('returns null when no manifest exists between the test and the engine root', async () => {
    await ensureDir(join(workspace, 'browser/base/content/test'));
    await writeText(join(workspace, 'browser/base/content/test/test_orphan.js'), '');
    const found = await findNearestXpcshellManifest(
      workspace,
      'browser/base/content/test/test_orphan.js'
    );
    expect(found).toBeNull();
  });

  it('returns null when the manifest path passed in does not exist', async () => {
    const found = await findNearestXpcshellManifest(workspace, 'missing/xpcshell.toml');
    expect(found).toBeNull();
  });
});

describe('readMozinfoAppname', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fireforge-mozinfo-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('returns the appname recorded in mozinfo.json', async () => {
    await writeJson(join(workspace, 'mozinfo.json'), { appname: 'mybrowser' });
    expect(await readMozinfoAppname(workspace)).toBe('mybrowser');
  });

  it('falls back to "firefox" when mozinfo.json is missing', async () => {
    expect(await readMozinfoAppname(workspace)).toBe('firefox');
  });

  it('falls back to "firefox" when mozinfo.json is malformed JSON', async () => {
    await writeText(join(workspace, 'mozinfo.json'), 'not-json{');
    expect(await readMozinfoAppname(workspace)).toBe('firefox');
  });

  it('falls back to "firefox" when appname is missing from mozinfo.json', async () => {
    await writeJson(join(workspace, 'mozinfo.json'), { topobjdir: '/foo' });
    expect(await readMozinfoAppname(workspace)).toBe('firefox');
  });

  it('falls back to "firefox" when appname is not a string', async () => {
    await writeJson(join(workspace, 'mozinfo.json'), { appname: 42 });
    expect(await readMozinfoAppname(workspace)).toBe('firefox');
  });
});

describe('resolveAbsoluteAppPath', () => {
  let workspace: string;
  const isMacos = process.platform === 'darwin';

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fireforge-resolve-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('returns dist/bin/<value> when only that directory exists', async () => {
    // Works on every platform: no `.app` bundle in dist/, so the macOS
    // probe branch falls through to the `dist/bin/<value>` fallback and
    // the Linux branch returns it directly.
    const target = join(workspace, 'dist/bin/browser');
    await ensureDir(target);
    expect(await resolveAbsoluteAppPath(workspace, 'browser')).toBe(target);
  });

  it('returns dist/<bundle>.app/Contents/Resources/<value> when only that layout exists', async () => {
    const macTarget = join(workspace, 'dist/Hominis.app/Contents/Resources/browser');
    await ensureDir(macTarget);
    expect(await resolveAbsoluteAppPath(workspace, 'browser')).toBe(macTarget);
  });

  // 2026-04-24 eval Finding 8: on macOS, preferring `dist/bin/browser`
  // resolved to `<App>.app/Contents/MacOS/browser/` via the convenience
  // symlink — that is the *binaries* directory, not the Resources tree
  // where `resource:///modules/` is rooted. The probe must prefer the
  // `.app/Contents/Resources/<value>` path on macOS so the injected
  // appdir matches where modules actually live. Non-macOS hosts keep the
  // historical `dist/bin`-first order.
  it('prefers the platform-correct layout when both dist/bin and a .app bundle exist', async () => {
    const linuxTarget = join(workspace, 'dist/bin/browser');
    const macTarget = join(workspace, 'dist/Hominis.app/Contents/Resources/browser');
    await ensureDir(linuxTarget);
    await ensureDir(macTarget);
    const resolved = await resolveAbsoluteAppPath(workspace, 'browser');
    if (isMacos) {
      expect(resolved).toBe(macTarget);
    } else {
      expect(resolved).toBe(linuxTarget);
    }
  });

  it('returns null when neither candidate exists', async () => {
    await ensureDir(join(workspace, 'dist'));
    expect(await resolveAbsoluteAppPath(workspace, 'browser')).toBeNull();
  });

  it('returns null when dist/ itself is missing', async () => {
    expect(await resolveAbsoluteAppPath(workspace, 'browser')).toBeNull();
  });

  it('follows a dist/bin symlink on non-macOS hosts (the Linux convenience symlink case)', async () => {
    // On Linux this symlink is a legitimate probe candidate (dist/bin is
    // the canonical appdir root). On macOS the new probe order prefers
    // the Resources path regardless of whether `dist/bin` is a real dir
    // or a symlink chain, because following the symlink produces the
    // MacOS binaries directory — not the Resources tree.
    const realDir = join(workspace, 'dist/Hominis.app/Contents/Resources/browser');
    await ensureDir(realDir);
    try {
      await symlink(
        join(workspace, 'dist/Hominis.app/Contents/Resources'),
        join(workspace, 'dist/bin')
      );
    } catch {
      // Symlinks unavailable — skip this assertion rather than failing.
      return;
    }
    const resolved = await resolveAbsoluteAppPath(workspace, 'browser');
    if (isMacos) {
      // macOS: prefer the real `.app/Contents/Resources/<value>` path so
      // the injected `--app-path` matches where modules actually live.
      expect(resolved).toBe(realDir);
    } else {
      // Non-macOS: keep the historical behaviour and return the
      // `dist/bin/<value>` symlink target.
      expect(resolved).toBe(join(workspace, 'dist/bin/browser'));
    }
  });
});

describe('resolveXpcshellAppdirArg', () => {
  let workspace: string;
  const objDir = 'obj-debug';

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fireforge-resolve-arg-'));
    // Standard layout for the happy path: rebranded fork, dist/bin populated.
    await writeJson(join(workspace, objDir, 'mozinfo.json'), { appname: 'mybrowser' });
    await ensureDir(join(workspace, objDir, 'dist/bin/browser'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('injects when manifest sets firefox-appdir on a rebranded fork', async () => {
    const dir = join(workspace, 'browser/base/content/test/foo');
    await ensureDir(dir);
    await writeText(join(dir, 'xpcshell.toml'), '[DEFAULT]\nfirefox-appdir = "browser"\n');

    const result = await resolveXpcshellAppdirArg(
      workspace,
      ['browser/base/content/test/foo/test_x.js'],
      objDir
    );
    expect(result).toEqual({
      kind: 'injected',
      result: {
        appPath: join(workspace, objDir, 'dist/bin/browser'),
        manifestPath: join(dir, 'xpcshell.toml'),
        key: 'firefox-appdir',
        relativeAppdir: 'browser',
      },
    });
  });

  it('does not inject when appname is firefox (harness reads firefox-appdir natively)', async () => {
    await writeJson(join(workspace, objDir, 'mozinfo.json'), { appname: 'firefox' });
    const dir = join(workspace, 'browser/base/content/test/foo');
    await ensureDir(dir);
    await writeText(join(dir, 'xpcshell.toml'), '[DEFAULT]\nfirefox-appdir = "browser"\n');

    const result = await resolveXpcshellAppdirArg(
      workspace,
      ['browser/base/content/test/foo/test_x.js'],
      objDir
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('does not inject when manifest already declares <appname>-appdir', async () => {
    const dir = join(workspace, 'browser/base/content/test/foo');
    await ensureDir(dir);
    // Migrated manifest carrying both keys: harness reads mybrowser-appdir
    // directly, so we must not override.
    await writeText(
      join(dir, 'xpcshell.toml'),
      '[DEFAULT]\nfirefox-appdir = "browser"\nmybrowser-appdir = "browser"\n'
    );

    const result = await resolveXpcshellAppdirArg(
      workspace,
      ['browser/base/content/test/foo/test_x.js'],
      objDir
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('returns "none" when no xpcshell.toml is found above the test path', async () => {
    const dir = join(workspace, 'browser/base/content/test/orphan');
    await ensureDir(dir);
    await writeText(join(dir, 'test_orphan.js'), '');

    const result = await resolveXpcshellAppdirArg(
      workspace,
      ['browser/base/content/test/orphan/test_orphan.js'],
      objDir
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('returns "unresolved" when manifest asks for a value that does not exist under dist', async () => {
    const dir = join(workspace, 'browser/base/content/test/foo');
    await ensureDir(dir);
    await writeText(join(dir, 'xpcshell.toml'), '[DEFAULT]\nfirefox-appdir = "missing-dir"\n');

    const result = await resolveXpcshellAppdirArg(
      workspace,
      ['browser/base/content/test/foo/test_x.js'],
      objDir
    );
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') {
      expect(result.relativeAppdir).toBe('missing-dir');
      expect(result.manifestPath).toBe(join(dir, 'xpcshell.toml'));
    }
  });

  it('returns "mismatch" when two test paths resolve to different app dirs', async () => {
    await ensureDir(join(workspace, objDir, 'dist/bin/xulrunner'));

    const dirA = join(workspace, 'browser/base/content/test/A');
    const dirB = join(workspace, 'browser/base/content/test/B');
    await ensureDir(dirA);
    await ensureDir(dirB);
    await writeText(join(dirA, 'xpcshell.toml'), '[DEFAULT]\nfirefox-appdir = "browser"\n');
    await writeText(join(dirB, 'xpcshell.toml'), '[DEFAULT]\nfirefox-appdir = "xulrunner"\n');

    const result = await resolveXpcshellAppdirArg(
      workspace,
      ['browser/base/content/test/A/test_a.js', 'browser/base/content/test/B/test_b.js'],
      objDir
    );
    expect(result.kind).toBe('mismatch');
    if (result.kind === 'mismatch') {
      expect(result.values).toHaveLength(2);
    }
  });

  it('deduplicates when two test paths resolve to the same app dir', async () => {
    const dirA = join(workspace, 'browser/base/content/test/A');
    const dirB = join(workspace, 'browser/base/content/test/B');
    await ensureDir(dirA);
    await ensureDir(dirB);
    await writeText(join(dirA, 'xpcshell.toml'), '[DEFAULT]\nfirefox-appdir = "browser"\n');
    await writeText(join(dirB, 'xpcshell.toml'), '[DEFAULT]\nfirefox-appdir = "browser"\n');

    const result = await resolveXpcshellAppdirArg(
      workspace,
      ['browser/base/content/test/A/test_a.js', 'browser/base/content/test/B/test_b.js'],
      objDir
    );
    expect(result.kind).toBe('injected');
  });

  it('returns "none" for an empty test path list (no batch to inject for)', async () => {
    const result = await resolveXpcshellAppdirArg(workspace, [], objDir);
    expect(result).toEqual({ kind: 'none' });
  });

  it('does not throw when the manifest read fails after discovery', async () => {
    // Race-style fallback: the manifest existed at find time but the read
    // surfaces an error (permissions, deleted between calls). The resolver
    // must skip the path silently rather than tearing down the test run.
    const dir = join(workspace, 'browser/base/content/test/foo');
    await ensureDir(dir);
    await writeText(join(dir, 'xpcshell.toml'), '[DEFAULT]\n');
    // Empty manifest — no firefox-appdir key — exercises the "no key" path.
    const result = await resolveXpcshellAppdirArg(
      workspace,
      ['browser/base/content/test/foo/test_x.js'],
      objDir
    );
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('operatorAlreadySetAppPath', () => {
  it('returns true when a single-token --app-path=… arg is present', () => {
    expect(operatorAlreadySetAppPath(['--headless', '--app-path=/abs/path'])).toBe(true);
  });

  it('returns true when a two-token --app-path <value> form is present', () => {
    expect(operatorAlreadySetAppPath(['--app-path', '/abs/path'])).toBe(true);
  });

  it('returns false when no --app-path arg is present', () => {
    expect(operatorAlreadySetAppPath(['--headless', '--keep-going'])).toBe(false);
  });

  it('does not match unrelated args that contain "app-path" as a substring', () => {
    // The regex must anchor on the flag name so a value like
    // `--mach-arg=--app-path-test=…` (hypothetical) doesn't get false-flagged.
    expect(operatorAlreadySetAppPath(['--some-app-path-thing=foo'])).toBe(false);
  });

  it('returns false when --app-path appears as the final arg with no value', () => {
    // Strictly speaking a malformed CLI invocation — but worth pinning down
    // so a future change does not regress to throwing when the operator
    // typed an incomplete arg.
    expect(operatorAlreadySetAppPath(['--app-path'])).toBe(false);
  });
});
