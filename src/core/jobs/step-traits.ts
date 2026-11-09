// SPDX-License-Identifier: EUPL-1.2

interface TraitInput {
  command: string;
  args: readonly string[];
}

/** What an adapter step does to shared resources and to the slot's build state. */
export interface StepTraits {
  /** `test --build` or `test --build-only`: a faster build precedes the harness. */
  preTestBuild: boolean;
  /** `test --build-only`: no harness runs. */
  buildOnly: boolean;
  /** `test --negative-control`: a mutation applied and restored around the harness. */
  control: boolean;
  /** `build --ui`: a UI-only package refresh over an existing full build. */
  uiBuild: boolean;
  /** A build runs and leaves a package baseline (`build` or a pre-test build). */
  builds: boolean;
  /** A build that requires the full-build anchor to still match its source. */
  requiresAnchor: boolean;
  /** Runs Mach or a compiler, so the native toolchain contract applies. */
  native: boolean;
  /** Holds the host's single build lane. */
  buildLane: boolean;
  /** Runs a browser. */
  browser: boolean;
  /** Runs a browser with a visible window. */
  display: boolean;
  /** Reads the packaged build, so a current trusted build must already exist. */
  readsPackage: boolean;
  /** `package --recipe release`: a whole build of its own, in its own object directory. */
  releaseBuild: boolean;
  /** `test --perf-samples`: records timings that have to come from a host nothing else runs on. */
  perfSampling: boolean;
  /** A static check (`check`, `typecheck`, `lint`, `verify`, `status`): no build, browser, Mach or compiler. */
  light: boolean;
}

/** The adapters that read captured source and run nothing a build or a browser needs. */
const LIGHT_COMMANDS: ReadonlySet<string> = new Set([
  'check',
  'typecheck',
  'lint',
  'verify',
  'status',
]);

/** The single reading of an adapter step's flags. */
export function stepTraits(step: TraitInput | undefined): StepTraits {
  const args = step?.args ?? [];
  const command = step?.command;
  const buildOnly = command === 'test' && args.includes('--build-only');
  const preTestBuild = command === 'test' && (buildOnly || args.includes('--build'));
  const control =
    command === 'test' &&
    args.some((arg) => arg === '--negative-control' || arg.startsWith('--negative-control='));
  const uiBuild = command === 'build' && args.includes('--ui');
  const browser = command === 'run' || (command === 'test' && !buildOnly);
  const releaseBuild =
    command === 'package' && args.some((arg) => arg === '--recipe' || arg.startsWith('--recipe='));
  return {
    preTestBuild,
    buildOnly,
    control,
    uiBuild,
    builds: command === 'build' || preTestBuild,
    requiresAnchor: uiBuild || preTestBuild,
    native: command === 'build' || command === 'package' || preTestBuild || control,
    buildLane:
      command === 'build' ||
      command === 'furnace' ||
      command === 'package' ||
      preTestBuild ||
      control,
    browser,
    display: browser && !args.includes('--headless'),
    readsPackage:
      (command === 'test' || command === 'run' || command === 'package') &&
      !preTestBuild &&
      !releaseBuild,
    releaseBuild,
    perfSampling:
      command === 'test' &&
      args.some((arg) => arg === '--perf-samples' || arg.startsWith('--perf-samples=')),
    light: command !== undefined && LIGHT_COMMANDS.has(command),
  };
}
