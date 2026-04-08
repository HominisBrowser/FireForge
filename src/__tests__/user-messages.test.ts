// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

// Branding errors
import { BrandingError } from '../core/branding.js';
// Base errors
import {
  CancellationError,
  GeneralError,
  InvalidArgumentError,
  ResolutionError,
} from '../errors/base.js';
// Build errors
import {
  AmbiguousBuildArtifactsError,
  BootstrapError,
  BuildError,
  MachNotFoundError,
  MozconfigError,
  PythonNotFoundError,
} from '../errors/build.js';
// Config errors
import {
  ConfigError,
  ConfigNotFoundError,
  InvalidFieldError,
  MissingFieldError,
} from '../errors/config.js';
// Download errors
import {
  DownloadError,
  EngineExistsError,
  ExtractionError,
  PartialEngineExistsError,
  VersionNotFoundError,
} from '../errors/download.js';
// Furnace errors
import { FurnaceError } from '../errors/furnace.js';
// Git errors
import {
  DirtyRepositoryError,
  GitError,
  GitIndexLockError,
  GitNotFoundError,
  PatchApplyError,
} from '../errors/git.js';
// Patch errors
import { PatchError } from '../errors/patch.js';

describe('userMessage snapshots', () => {
  // -- Base errors --
  it('GeneralError', () => {
    expect(new GeneralError('unexpected failure').userMessage).toMatchSnapshot();
  });

  it('InvalidArgumentError with argument', () => {
    expect(new InvalidArgumentError('must be a number', '--jobs').userMessage).toMatchSnapshot();
  });

  it('InvalidArgumentError without argument', () => {
    expect(new InvalidArgumentError('bad value').userMessage).toMatchSnapshot();
  });

  it('CancellationError', () => {
    expect(new CancellationError().userMessage).toMatchSnapshot();
  });

  it('ResolutionError', () => {
    expect(new ResolutionError('conflict unresolved').userMessage).toMatchSnapshot();
  });

  // -- Git errors --
  it('GitError with command', () => {
    expect(new GitError('checkout failed', 'checkout main').userMessage).toMatchSnapshot();
  });

  it('GitError without command', () => {
    expect(new GitError('unknown failure').userMessage).toMatchSnapshot();
  });

  it('GitNotFoundError', () => {
    expect(new GitNotFoundError().userMessage).toMatchSnapshot();
  });

  it('PatchApplyError', () => {
    expect(new PatchApplyError('/patches/001-toolbar.patch').userMessage).toMatchSnapshot();
  });

  it('DirtyRepositoryError', () => {
    expect(new DirtyRepositoryError().userMessage).toMatchSnapshot();
  });

  it('GitIndexLockError with age', () => {
    expect(new GitIndexLockError('/engine/.git/index.lock', 180_000).userMessage).toMatchSnapshot();
  });

  it('GitIndexLockError without age', () => {
    expect(new GitIndexLockError('/engine/.git/index.lock').userMessage).toMatchSnapshot();
  });

  // -- Download errors --
  it('DownloadError with URL', () => {
    expect(
      new DownloadError('connection timed out', 'https://archive.mozilla.org/test').userMessage
    ).toMatchSnapshot();
  });

  it('DownloadError without URL', () => {
    expect(new DownloadError('network error').userMessage).toMatchSnapshot();
  });

  it('ExtractionError', () => {
    expect(new ExtractionError('/tmp/firefox-140.0.tar.xz').userMessage).toMatchSnapshot();
  });

  it('VersionNotFoundError', () => {
    expect(new VersionNotFoundError('999.0').userMessage).toMatchSnapshot();
  });

  it('EngineExistsError', () => {
    expect(new EngineExistsError('/project/engine').userMessage).toMatchSnapshot();
  });

  it('PartialEngineExistsError', () => {
    expect(new PartialEngineExistsError('/project/engine').userMessage).toMatchSnapshot();
  });

  // -- Build errors --
  it('BuildError with command', () => {
    expect(new BuildError('compilation failed', 'mach build').userMessage).toMatchSnapshot();
  });

  it('BuildError without command', () => {
    expect(new BuildError('unknown build failure').userMessage).toMatchSnapshot();
  });

  it('MachNotFoundError', () => {
    expect(new MachNotFoundError('/project/engine').userMessage).toMatchSnapshot();
  });

  it('PythonNotFoundError', () => {
    expect(new PythonNotFoundError('3.8', '3.12').userMessage).toMatchSnapshot();
  });

  it('BootstrapError', () => {
    expect(new BootstrapError().userMessage).toMatchSnapshot();
  });

  it('MozconfigError', () => {
    expect(new MozconfigError('missing template').userMessage).toMatchSnapshot();
  });

  it('AmbiguousBuildArtifactsError', () => {
    expect(
      new AmbiguousBuildArtifactsError(['obj-x86_64', 'obj-aarch64']).userMessage
    ).toMatchSnapshot();
  });

  // -- Patch errors --
  it('PatchError with patch name', () => {
    expect(new PatchError('apply failed', '001-toolbar.patch').userMessage).toMatchSnapshot();
  });

  it('PatchError without patch name', () => {
    expect(new PatchError('generic failure').userMessage).toMatchSnapshot();
  });

  // -- Furnace errors --
  it('FurnaceError with component', () => {
    expect(new FurnaceError('registration failed', 'my-button').userMessage).toMatchSnapshot();
  });

  it('FurnaceError without component', () => {
    expect(new FurnaceError('config invalid').userMessage).toMatchSnapshot();
  });

  // -- Config errors --
  it('ConfigError with field', () => {
    expect(new ConfigError('invalid value', 'firefox.version').userMessage).toMatchSnapshot();
  });

  it('ConfigNotFoundError', () => {
    expect(new ConfigNotFoundError('/project/fireforge.json').userMessage).toMatchSnapshot();
  });

  it('MissingFieldError', () => {
    expect(new MissingFieldError('vendor').userMessage).toMatchSnapshot();
  });

  it('InvalidFieldError', () => {
    expect(new InvalidFieldError('build.jobs', 'number', 'many').userMessage).toMatchSnapshot();
  });

  // -- Branding errors --
  it('BrandingError', () => {
    expect(new BrandingError('template not found').userMessage).toMatchSnapshot();
  });
});
