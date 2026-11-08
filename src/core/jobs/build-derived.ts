// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import {
  composeCapturedBuildOutputs,
  readSourceBlobs,
  recordAuthoredDerivedOutputs,
} from '../authored/index.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { assertBuildPreimages, buildPristineInputs } from './build-preimage.js';
import { readDerivedOutputs } from './derived.js';
import { executorFingerprint } from './evidence.js';
import type { BuildDerivedFile, BuildDerivedLedger, SlotRecord } from './slot-types.js';
import { readJson, slotDirectory, writeDurable } from './store.js';
import { readRegularFile } from './tool-files.js';

/** Register the exact existing generator output before a build; never accept an arbitrary runtime prefix. */
export async function prepareBuildDerived(
  namespace: string,
  slot: SlotRecord,
  snapshot: AuthoredSnapshot,
  apply = false
): Promise<void> {
  const previous = await readBuildDerived(namespace, slot);
  const derived = await readDerivedOutputs(namespace, slot);
  const expected = await composeCapturedBuildOutputs(snapshot, {
    pristineRepository: slot.pristineRepository,
  });
  await assertBuildPreimages(slot, snapshot, [...expected.files.keys()], previous, derived);
  const files: Record<string, BuildDerivedFile> = {};
  for (const [path, file] of expected.files) {
    files[path] = { sha256: file.sha256, mode: file.mode };
    if (apply) {
      const target = join(slot.root, 'engine', path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
      await chmod(target, file.mode === '100755' ? 0o755 : 0o644);
    }
  }
  await writeDurable(join(slotDirectory(namespace, slot.id), 'build-derived.json'), {
    sourceId: snapshot.id,
    generation: slot.generation,
    provenance: expected.provenance,
    toolsDigest: await executorFingerprint(),
    files,
  } satisfies BuildDerivedLedger);
  if (apply) await verifyBuildDerived(namespace, slot, snapshot);
}

/** Compare exact bytes/modes and reconcile only existing source-owned ledger entries after sanctioned generation. */
export async function verifyBuildDerived(
  namespace: string,
  slot: SlotRecord,
  snapshot: AuthoredSnapshot
): Promise<void> {
  const files = await readBuildDerived(namespace, slot);
  for (const [path, image] of Object.entries(files)) {
    const file = await readRegularFile(
      join(slot.root, 'engine', path),
      `Build generation drift: ${path}`
    );
    if (file.mode !== image.mode || file.sha256 !== image.sha256)
      throw new Error(`Build generation drift: ${path}`);
  }
  const managed = Object.keys(files).filter((path) =>
    snapshot.files.some((file) => file.path === path && file.kind !== 'delete')
  );
  if (managed.length)
    await recordAuthoredDerivedOutputs({
      engineDir: join(slot.root, 'engine'),
      ledgerPath: join(slotDirectory(namespace, slot.id), 'materialization.json'),
      snapshotId: snapshot.id,
      paths: managed,
    });
}

/** The expected map is bound to captured inputs and generator provenance, not to whatever the runtime wrote. */
export async function readBuildDerived(
  namespace: string,
  slot: SlotRecord
): Promise<Record<string, BuildDerivedFile>> {
  let ledger: BuildDerivedLedger;
  try {
    ledger = await readJson(join(slotDirectory(namespace, slot.id), 'build-derived.json'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return {};
    throw error;
  }
  if (
    ledger.sourceId !== slot.sourceId ||
    ledger.generation !== slot.generation ||
    ledger.provenance.sourceId !== slot.sourceId
  )
    throw new Error('Build generation belongs to a different captured source');
  return ledger.files;
}

/**
 * Takes an old generation's outputs out before the source changes, leaving any
 * the next source generates byte for byte. Those keep their mtime, so one line
 * of JavaScript does not rewrite the mozconfig and send the next build back
 * through configure. An output either snapshot owns has to go through the
 * materialization ledger, so it is always restored.
 */
export async function retireBuildDerived(
  namespace: string,
  slot: SlotRecord,
  next: AuthoredSnapshot
): Promise<void> {
  const files = await readBuildDerived(namespace, slot);
  const snapshot = await readJson<AuthoredSnapshot>(
    join(slotDirectory(namespace, slot.id), 'snapshot.json')
  );
  const original = new Map(snapshot.files.map((file) => [file.path, file]));
  const nextOwned = new Set(next.files.map((file) => file.path));
  const expected =
    Object.keys(files).length === 0
      ? undefined
      : await composeCapturedBuildOutputs(next, { pristineRepository: slot.pristineRepository });
  const ownedBlobs = await readSourceBlobs(
    snapshot.repository,
    Object.keys(files).flatMap((path) =>
      original.get(path)?.blob ? [original.get(path)?.blob as string] : []
    )
  );
  const pristine = await buildPristineInputs(slot, Object.keys(files));
  const restored: string[] = [];
  const kept: Record<string, BuildDerivedFile> = {};
  for (const [path, image] of Object.entries(files)) {
    const target = join(slot.root, 'engine', path);
    const current = await readRegularFile(target, `Unreconciled old build output: ${path}`);
    if (current.mode !== image.mode || current.sha256 !== image.sha256)
      throw new Error(`Unreconciled old build output: ${path}`);
    const owned = original.get(path);
    const generated = expected?.files.get(path);
    if (
      generated?.sha256 === image.sha256 &&
      generated.mode === image.mode &&
      owned === undefined &&
      !nextOwned.has(path)
    ) {
      kept[path] = image;
      continue;
    }
    const base = pristine.entries.get(path);
    const source = owned?.blob
      ? { bytes: ownedBlobs.get(owned.blob), mode: owned.mode }
      : base
        ? { bytes: pristine.blobs.get(base.blob), mode: base.mode }
        : undefined;
    if (source?.bytes) {
      await writeFile(target, source.bytes);
      await chmod(target, source.mode === '100755' ? 0o755 : 0o644);
      if (owned) restored.push(path);
    } else await rm(target);
  }
  if (restored.length)
    await recordAuthoredDerivedOutputs({
      engineDir: join(slot.root, 'engine'),
      ledgerPath: join(slotDirectory(namespace, slot.id), 'materialization.json'),
      snapshotId: slot.sourceId,
      paths: restored,
    });
  const ledger = join(slotDirectory(namespace, slot.id), 'build-derived.json');
  if (expected === undefined || Object.keys(kept).length === 0) await rm(ledger, { force: true });
  else
    await writeDurable(ledger, {
      sourceId: next.id,
      generation: slot.generation + 1,
      provenance: expected.provenance,
      toolsDigest: await executorFingerprint(),
      files: kept,
    } satisfies BuildDerivedLedger);
}
