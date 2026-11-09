// SPDX-License-Identifier: EUPL-1.2
import type { Command } from 'commander';

import { readCoordinatorConfig } from '../core/jobs/admission-context.js';
import { liveEndpoint } from '../core/jobs/client.js';
import { executorFingerprint } from '../core/jobs/executor-fingerprint.js';
import {
  type PinnedBuild,
  pinPreviousRuntime,
  pinRuntime,
  readPinnedRuntime,
} from '../core/jobs/pinned-runtime.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { getCliVersion } from '../utils/build-info.js';
import { getPackageRoot } from '../utils/package-root.js';
import { jobAction, namespaceOf, printResult } from './job-support.js';

const buildText = (build: PinnedBuild): string => `FireForge ${build.version} (${build.id})`;

/** Which FireForge the host pins, which one its supervisor runs, and whether this checkout is the pinned one. */
interface RuntimeView {
  pinned: PinnedBuild | null;
  previous: PinnedBuild | null;
  supervisor: {
    pid: number;
    version: string | null;
    packageRoot: string | null;
    pinned: boolean;
  } | null;
  client: { version: string; pinned: boolean };
}

/** Which FireForge the host pins and runs, for `host status`. */
export async function runtimeStatus(
  namespace: string
): Promise<{ data: { runtime: RuntimeView }; lines: string[] }> {
  const record = await readPinnedRuntime(namespace);
  const endpoint = await liveEndpoint(namespace);
  const own = await executorFingerprint();
  const pinned = record?.current;
  const lines = [
    pinned === undefined
      ? 'FireForge: no pinned build; each supervisor start runs the package of the client that starts it (pin one: fireforge host upgrade)'
      : `FireForge: pinned ${buildText(pinned)} from ${pinned.source}${record?.previous === undefined ? '' : `; previous ${buildText(record.previous)}`}`,
  ];
  if (endpoint !== undefined)
    lines.push(
      `Supervisor: pid ${String(endpoint.owner.pid)} runs FireForge ${endpoint.version ?? 'of unknown version'}${
        pinned !== undefined && endpoint.executorDigest !== pinned.executorDigest
          ? `; the host switches to ${pinned.version} when it next goes idle`
          : ''
      }`
    );
  if (pinned !== undefined)
    lines.push(
      `This checkout: FireForge ${getCliVersion()}, ${own === pinned.executorDigest ? 'the pinned build' : 'another build than the pinned one, which runs its jobs'}`
    );
  return {
    data: {
      runtime: {
        pinned: pinned ?? null,
        previous: record?.previous ?? null,
        supervisor:
          endpoint === undefined
            ? null
            : {
                pid: endpoint.owner.pid,
                version: endpoint.version ?? null,
                packageRoot: endpoint.packageRoot ?? null,
                pinned: pinned !== undefined && endpoint.executorDigest === pinned.executorDigest,
              },
        client: { version: getCliVersion(), pinned: own === pinned?.executorDigest },
      },
    },
    lines,
  };
}

/** Pins a build, or returns to the previous one, and says when the host takes it up. */
async function hostUpgrade(
  namespace: string,
  options: { from?: string; previous?: boolean }
): Promise<void> {
  if (options.previous === true && options.from !== undefined)
    throw new InvalidArgumentError('host upgrade takes --from or --previous, not both');
  const config = await readCoordinatorConfig(namespace);
  const endpoint = await liveEndpoint(namespace);
  const { current, previous } =
    options.previous === true
      ? await pinPreviousRuntime(namespace)
      : (
          await pinRuntime(namespace, {
            from: options.from ?? getPackageRoot(),
            runtime: config.runtime,
            ...(endpoint?.packageRoot === undefined ? {} : { running: endpoint.packageRoot }),
          })
        ).record;
  const takeUp =
    endpoint === undefined
      ? 'The next supervisor start runs it.'
      : endpoint.executorDigest === current.executorDigest
        ? `The running supervisor (pid ${String(endpoint.owner.pid)}) already runs it.`
        : `The running supervisor (pid ${String(endpoint.owner.pid)}) switches to it when it next goes idle; jobs submitted meanwhile wait for it.`;
  printResult(
    { namespace, pinned: current, previous: previous ?? null },
    [
      `Pinned ${buildText(current)} from ${current.source}. ${takeUp}`,
      ...(previous === undefined
        ? []
        : [
            `Previous: ${buildText(previous)}; return to it with: fireforge host upgrade --previous`,
          ]),
    ].join('\n')
  );
}

/** `host upgrade`: the one build every supervisor start on this host runs. */
export function registerHostUpgrade(host: Command, ctx: CommandContext): void {
  host
    .command('upgrade')
    .description('Pin the FireForge build every supervisor on this host runs, whoever starts it')
    .option(
      '--from <package>',
      'A built FireForge package directory to pin; defaults to the one running this command'
    )
    .option('--previous', 'Return to the build pinned before the current one')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: { from?: string; previous?: boolean; namespace?: string }) => {
        await hostUpgrade(namespaceOf(options), options);
      })
    );
}
