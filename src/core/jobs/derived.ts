// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { parse } from 'jsonc-parser';

import { getNodeErrorCode } from '../../utils/errors.js';
import { readSourceBlobs, recordAuthoredDerivedOutputs } from '../authored/index.js';
import { validateFurnaceConfig } from '../furnace-config.js';
import { typecheckJsconfigList } from '../furnace-jsconfig.js';
import { coordinatorNamespace, readAdmittedSnapshot } from './guard.js';
import type { SlotRecord } from './slot-types.js';
import { slotDirectory } from './store.js';
import { readJson, writeDurable } from './store.js';

export interface DerivedOutput {
  path: string;
  sha256: string;
  mode: '100644' | '100755';
  sourceId: string;
  generation: number;
  phase: string;
  generatorVersion: string;
}

function withoutManagedPaths(bytes: Buffer): unknown {
  const value: unknown = parse(bytes.toString());
  if (value === null || typeof value !== 'object') throw new Error('Invalid generated jsconfig');
  const object = value as Record<string, unknown>;
  const compiler = object['compilerOptions'] as Record<string, unknown> | undefined;
  const paths = compiler?.['paths'] as Record<string, unknown> | undefined;
  if (paths && compiler) {
    compiler['paths'] = Object.fromEntries(
      Object.entries(paths).filter(([key]) => !key.startsWith('chrome://global/content/elements/'))
    );
    if (Object.keys(compiler['paths'] as object).length === 0) delete compiler['paths'];
  }
  if (compiler && Object.keys(compiler).length === 0) delete object['compilerOptions'];
  return object;
}

/** Record only the closed generated-config destinations declared by captured Furnace configuration. */
export async function recordDerivedOutput(
  projectRoot: string,
  path: string,
  provenance: { generatorVersion: string; sourceId?: string; phase?: string }
): Promise<void> {
  const { snapshot, slot, phase } = await readAdmittedSnapshot(projectRoot);
  if (!['typecheck', 'check'].includes(process.env['FIREFORGE_ADAPTER_COMMAND'] ?? ''))
    throw new Error('This phase cannot declare generated configuration');
  if (
    (provenance.sourceId !== undefined && provenance.sourceId !== snapshot.id) ||
    (provenance.phase !== undefined && provenance.phase !== phase) ||
    !provenance.generatorVersion
  )
    throw new Error('Derived output provenance mismatch');
  const configInput = snapshot.inputs.find((input) => input.path === 'furnace.json');
  if (!configInput) throw new Error('No captured Furnace contract authorizes derived output');
  const configBytes = (await readSourceBlobs(snapshot.repository, [configInput.blob])).get(
    configInput.blob
  );
  if (!configBytes) throw new Error('Captured Furnace configuration unavailable');
  const config = validateFurnaceConfig(JSON.parse(configBytes.toString()) as unknown);
  const normalized = relative(slot.root, resolve(slot.root, path)).split(sep).join('/');
  if (normalized.startsWith('../') || normalized === '..')
    throw new Error('Derived output escapes slot');
  const jsconfigs = typecheckJsconfigList(config);
  if (!jsconfigs.includes(normalized) && config.typecheckTagMap !== normalized)
    throw new Error('Path is not a captured generated-config destination');
  const stat = await lstat(join(slot.root, normalized));
  if (!stat.isFile()) throw new Error('Derived output must be a regular file');
  const bytes = await readFile(join(slot.root, normalized));
  if (jsconfigs.includes(normalized)) {
    const input = snapshot.inputs.find((entry) => entry.path === normalized);
    const engineFile = normalized.startsWith('engine/')
      ? snapshot.files.find((entry) => entry.path === normalized.slice(7))
      : undefined;
    const blob = input?.blob ?? engineFile?.blob;
    if (!blob) throw new Error('Generated jsconfig has no captured authoritative projection');
    const base = (await readSourceBlobs(snapshot.repository, [blob])).get(blob);
    if (
      !base ||
      JSON.stringify(withoutManagedPaths(base)) !== JSON.stringify(withoutManagedPaths(bytes))
    )
      throw new Error('Generator changed authoritative jsconfig settings');
  }
  const namespace = coordinatorNamespace();
  if (
    normalized.startsWith('engine/') &&
    snapshot.files.some((file) => file.path === normalized.slice(7))
  ) {
    await recordAuthoredDerivedOutputs({
      engineDir: join(slot.root, 'engine'),
      ledgerPath: join(slotDirectory(namespace, slot.id), 'materialization.json'),
      snapshotId: snapshot.id,
      paths: [normalized.slice(7)],
    });
  }
  const outputs = await readDerivedOutputs(namespace, slot);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
  // A repeat of the generator declares nothing new, so the ledger keeps the phase that first did.
  if (outputs[normalized]?.sha256 === sha256 && outputs[normalized].mode === mode) return;
  outputs[normalized] = {
    path: normalized,
    sha256,
    mode,
    sourceId: snapshot.id,
    generation: slot.generation,
    phase,
    generatorVersion: provenance.generatorVersion,
  };
  await writeDurable(join(slotDirectory(namespace, slot.id), 'derived.json'), outputs);
}

/** Read a generation-bound ledger; output bytes are checked again at the sealing boundary. */
export async function readDerivedOutputs(
  namespace: string,
  slot: SlotRecord
): Promise<Record<string, DerivedOutput>> {
  let result: Record<string, DerivedOutput>;
  try {
    result = await readJson(join(slotDirectory(namespace, slot.id), 'derived.json'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return {};
    throw error;
  }
  if (
    Object.values(result).some(
      (entry) =>
        entry.sourceId !== slot.sourceId ||
        entry.generation !== slot.generation ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
  )
    throw new Error('Derived output ledger belongs to a different source/generation');
  return result;
}
