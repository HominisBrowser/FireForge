// SPDX-License-Identifier: EUPL-1.2
/**
 * Marker-comment resolution shared between furnace apply and deploy.
 *
 * When `markerComment` is unset in fireforge.json, fall back to
 * `binaryName.toUpperCase()` so the patch-lint rule
 * `lintModificationComments` (which keys on `${binaryName.toUpperCase()}:`)
 * accepts furnace-emitted edits on the next `lint`/`export` round-trip. The
 * helper tolerates the undefined-config case (a project that has not run
 * `fireforge setup` yet) and the missing-binaryName case (test fixtures that
 * mock `loadConfig` with a partial shape).
 */
export function resolveFurnaceMarkerComment(
  forgeConfig: { markerComment?: string; binaryName?: string } | undefined
): string | undefined {
  if (!forgeConfig) return undefined;
  if (forgeConfig.markerComment !== undefined) return forgeConfig.markerComment;
  if (forgeConfig.binaryName) return forgeConfig.binaryName.toUpperCase();
  return undefined;
}
