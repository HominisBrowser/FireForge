// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getNodeErrorCode, toError } from '../../utils/errors.js';
import { executionEnvironmentDigest, executorFingerprint } from '../jobs/evidence.js';
import {
  assertToolchainCurrent,
  readHostToolchain,
  toolchainManifestPath,
} from '../jobs/native-tools.js';
import { pinnedEntry } from '../jobs/pinned-runtime.js';
import { assertProjectToolCompatibility } from '../jobs/project-tools.js';
import { qualityToolsOnce } from '../jobs/quality-tools.js';
import type { CoordinatorConfig } from '../jobs/schema.js';
import { readSlots } from '../jobs/slots.js';
import { sourceLoaderCacheEnvironment } from '../jobs/source-loader.js';
import { readJson } from '../jobs/store.js';

const run = promisify(execFile);

/** What one slot root answers, under the coordinator's own Node and environment. */
export interface SlotToolAnswer {
  project: string;
  quality: string;
  /** The slot holds the source being judged, so a different answer means its tools changed. */
  exact: boolean;
}

/** The tools as they are now, which evidence has to equal to count. */
export interface CurrentIdentity {
  executor?: string;
  environment?: string;
  answers: SlotToolAnswer[];
  /** The host's recorded toolchain, when it has one. */
  toolchain?: string;
  /** Why that toolchain's bytes are not the recorded ones. */
  toolchainProblem?: string;
  /** Why the coordinator's tools could not be measured at all. */
  unmeasured?: string;
}

interface MeasuredTools {
  executor: string;
  environment: string;
  answers: Array<{ root: string; project?: string; quality?: string }>;
}

/** Runs in a process started the way the supervisor starts its own: see {@link measureCurrentIdentity}. */
export async function measureTools(roots: readonly string[]): Promise<MeasuredTools> {
  return {
    executor: await executorFingerprint(),
    environment: executionEnvironmentDigest(),
    answers: await Promise.all(
      roots.map(async (root) => {
        // A slot another job is preparing cannot answer now. That is no answer, not a change.
        try {
          return {
            root,
            project: await assertProjectToolCompatibility(root),
            quality: await qualityToolsOnce(root),
          };
        } catch {
          return { root };
        }
      })
    ),
  };
}

/**
 * Asks a process with the Node, environment and FireForge a job gets, since the
 * caller's own prove nothing: the host's pinned build, verified, when it pins one.
 */
async function askCoordinatorRuntime(
  namespace: string,
  roots: readonly string[]
): Promise<MeasuredTools> {
  const { runtime } = await readJson<CoordinatorConfig>(join(namespace, 'config.json'));
  const pinned = await pinnedEntry(namespace);
  const fromSource = pinned === undefined && import.meta.url.endsWith('.ts');
  const entry =
    pinned?.cli ??
    fileURLToPath(
      new URL(
        fromSource ? '../../../bin/fireforge.ts' : '../../../bin/fireforge.js',
        import.meta.url
      )
    );
  const { stdout } = await run(
    runtime.node,
    [
      ...(fromSource
        ? [
            '--import',
            fileURLToPath(new URL('../jobs/source-loader-bootstrap.cjs', import.meta.url)),
          ]
        : []),
      entry,
      'prove',
      'measure-tools',
      ...roots,
    ],
    {
      env: {
        ...runtime.environment,
        ...sourceLoaderCacheEnvironment(fromSource),
        NODE_DISABLE_COMPILE_CACHE: '1',
        JITI_FS_CACHE: 'false',
      },
      // Nothing about a caller's checkout is any part of the answer.
      cwd: namespace,
      maxBuffer: 1 << 20,
    }
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as MeasuredTools;
}

/** The recorded toolchain, and, when evidence depends on it, whether its bytes are still those. */
async function currentToolchain(
  namespace: string,
  options: { measure: boolean; full: boolean }
): Promise<Pick<CurrentIdentity, 'toolchain' | 'toolchainProblem'>> {
  try {
    await access(toolchainManifestPath(namespace));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return {};
    throw error;
  }
  const manifest = await readHostToolchain(namespace);
  if (!options.measure) return { toolchain: manifest.digest };
  try {
    await assertToolchainCurrent(manifest, { full: options.full });
    return { toolchain: manifest.digest };
  } catch (error) {
    return { toolchain: manifest.digest, toolchainProblem: toError(error).message };
  }
}

/**
 * Measures the identity evidence is compared with. FireForge, Node and the
 * environment are the coordinator's; project and quality tools live in a slot's
 * root, so a slot answers for them. A slot holding this source can say they
 * changed. One holding another source can only say they did not, because its
 * configuration files are that source's.
 *
 * @param namespace - The coordinator namespace
 * @param source - The source being judged
 * @param needed - Whether there is any evidence to compare this with
 * @param full - Read every toolchain byte rather than compare a stat signature
 */
export async function measureCurrentIdentity(
  namespace: string,
  source: string,
  needed: boolean,
  full: boolean
): Promise<CurrentIdentity> {
  const toolchain = await currentToolchain(namespace, { measure: needed, full });
  if (!needed) return { ...toolchain, answers: [] };
  const usable = (await readSlots(namespace)).filter((slot) => slot.quarantined === null);
  const exact = usable.filter((slot) => slot.sourceId === source);
  // A slot on this source has the answer, so the others need no reading.
  const slots = exact.length > 0 ? exact : usable;
  try {
    const measured = await askCoordinatorRuntime(
      namespace,
      slots.map((slot) => slot.root)
    );
    return {
      executor: measured.executor,
      environment: measured.environment,
      ...toolchain,
      answers: measured.answers.flatMap((answer) => {
        const slot = slots.find((entry) => entry.root === answer.root);
        return answer.project === undefined || answer.quality === undefined || slot === undefined
          ? []
          : [
              {
                project: answer.project,
                quality: answer.quality,
                exact: slot.sourceId === source,
              },
            ];
      }),
    };
  } catch (error) {
    // The CLI reports a refusal on stdout, which the failed command's message leaves out.
    const { stdout = '' } = error as { stdout?: string };
    return {
      ...toolchain,
      answers: [],
      unmeasured: `${toError(error).message.split('\n')[0] ?? ''} ${stdout}`.trim(),
    };
  }
}
