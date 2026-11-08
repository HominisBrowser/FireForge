// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;
/** A display does not change often enough to ask for every scheduling pass. */
const PROBE_INTERVAL_MS = 10_000;
/** The graphics bit of the root power domain's `System Capabilities`. */
const GRAPHICS_CAPABILITY = 0x2;

export interface DisplayAnswer {
  state: 'usable' | 'unavailable' | 'unknown';
  detail: string;
}

const property = (text: string, key: string): string | undefined =>
  new RegExp(`"${key}"\\s*=\\s*([^\\n]+)`).exec(text)?.[1]?.trim();

interface OnlineDisplay {
  asleep: boolean;
  internal: boolean;
}

/** The displays `system_profiler SPDisplaysDataType` has online. Every entry is a name line and its rows. */
function onlineDisplays(profile: string): OnlineDisplay[] {
  const entries: Array<OnlineDisplay & { online: boolean }> = [];
  for (const line of profile.split('\n')) {
    const row = line.trim();
    if (/^[^:]+:$/.test(row)) entries.push({ online: false, asleep: false, internal: false });
    const entry = entries.at(-1);
    if (entry === undefined) continue;
    if (row === 'Online: Yes') entry.online = true;
    else if (row === 'Display Asleep: Yes') entry.asleep = true;
    else if (row === 'Connection Type: Internal') entry.internal = true;
  }
  return entries.filter((entry) => entry.online);
}

/**
 * Whether the lid is closed, from the root power domain's `AppleClamshellState`.
 *
 * @param rootDomain - `ioreg -r -k AppleClamshellState -d1`, or undefined if it failed
 */
export function clamshellClosed(rootDomain: string | undefined): boolean {
  return rootDomain !== undefined && property(rootDomain, 'AppleClamshellState') === 'Yes';
}

/**
 * Whether a display is active: graphics on and a display awake. A closed lid only
 * takes out the built-in panel, so a docked laptop has its external one. Nothing
 * readable is unknown, and an unknown display runs, since a probe that cannot read
 * a machine must not stop work.
 *
 * @param rootDomain - `ioreg -r -k AppleClamshellState -d1`, or undefined if it failed
 * @param profile - `system_profiler SPDisplaysDataType`, or undefined if it failed
 */
export function readDisplayState(
  rootDomain: string | undefined,
  profile: string | undefined
): DisplayAnswer {
  const capabilities =
    rootDomain === undefined ? undefined : property(rootDomain, 'System Capabilities');
  if (
    capabilities !== undefined &&
    /^\d+$/.test(capabilities) &&
    (Number(capabilities) & GRAPHICS_CAPABILITY) === 0
  )
    return { state: 'unavailable', detail: 'graphics off' };
  const lidClosed = clamshellClosed(rootDomain);
  const displays = profile === undefined ? undefined : onlineDisplays(profile);
  if (displays === undefined || displays.length === 0)
    return displays !== undefined && lidClosed
      ? { state: 'unavailable', detail: 'lid closed and no display online' }
      : { state: 'unknown', detail: 'no display could be read' };
  const active = displays.filter((display) => !display.asleep && !(lidClosed && display.internal));
  if (active.length > 0)
    return { state: 'usable', detail: `${String(active.length)} display(s) active` };
  return {
    state: 'unavailable',
    detail: displays.some((display) => display.asleep)
      ? 'display asleep'
      : 'lid closed and no external display',
  };
}

/** A host program's output, or undefined when it failed or ran past the probe timeout. */
export async function hostReading(
  program: string,
  args: readonly string[]
): Promise<string | undefined> {
  try {
    const { stdout } = await runFile(program, [...args], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** The root power domain, as {@link readDisplayState} and {@link clamshellClosed} read it. */
export const readRootDomain = (): Promise<string | undefined> =>
  hostReading('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d1']);

/** The display profile, as {@link readDisplayState} reads it. */
export const readDisplayProfile = (): Promise<string | undefined> =>
  hostReading('/usr/sbin/system_profiler', ['SPDisplaysDataType']);

/** The login session this process runs in, as `launchctl` names it. `Aqua` can show a window. */
async function sessionName(): Promise<string | undefined> {
  return (await hostReading('/bin/launchctl', ['managername']))?.trim();
}

let last: { at: number; answer: DisplayAnswer } | undefined;

/**
 * Whether a window could be seen right now: this process has to be in the login
 * session and a display has to be active. Read-only, and unknown off macOS.
 */
export async function probeDisplay(now: number = Date.now()): Promise<DisplayAnswer> {
  if (process.platform !== 'darwin')
    return { state: 'unknown', detail: 'no display probe on this platform' };
  if (last !== undefined && now - last.at < PROBE_INTERVAL_MS) return last.answer;
  const name = await sessionName();
  const answer: DisplayAnswer =
    name === undefined || name === '' || name === 'Aqua'
      ? readDisplayState(await readRootDomain(), await readDisplayProfile())
      : {
          state: 'unavailable',
          detail: `this supervisor runs in "${name}", outside the login session`,
        };
  last = { at: now, answer };
  return answer;
}

/**
 * Why this process cannot put a window on the user's screen, or undefined when it
 * can or cannot tell. A window needs the login session, which a process started
 * from SSH or a background service does not have.
 *
 * @param managerName - `launchctl managername`, or undefined if it failed
 */
export function sessionRefusal(managerName: string | undefined): string | undefined {
  const name = managerName?.trim();
  if (name === undefined || name === '' || name === 'Aqua') return undefined;
  return `A step with a window needs the login session, and this supervisor runs in "${name}". Let it exit, then submit from a process in the login session`;
}

/** {@link sessionRefusal} for this process. Nothing to ask off macOS. */
export async function probeSessionRefusal(): Promise<string | undefined> {
  return process.platform === 'darwin' ? sessionRefusal(await sessionName()) : undefined;
}
