// Real nsIXPCComponents_Utils members typecheck, and their jsval results stay
// loose: a waived or cloned object keeps its expandos.
const sandbox = Cu.Sandbox(null, { wantXrays: false });
export const value = Cu.evalInSandbox('1 + 1', sandbox, null, 'mod.mjs', 1);
Cu.waiveXrays(sandbox).expando = Cu.cloneInto({ a: 1 }, sandbox).a;
Cu.importGlobalProperties(['fetch']);
export const dead = Cu.isDeadWrapper(sandbox) || Cu.isInAutomation;
export const weak = Cu.getWeakReference(sandbox).get();
Cu.reportError(new Error('reported'));
// Intentional bug: `now()` lives on ChromeUtils, not Cu.
export const stamp = Cu.now();
