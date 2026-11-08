// SPDX-License-Identifier: EUPL-1.2
/** Privileged harness adapters; coverage runs in each process, before its JS runtime dies. */
function coverageRuntime(output: string, token: string): string {
  return `
const Services = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;
const Cc = Components.classes, Ci = Components.interfaces;
const FF_OUTPUT = ${JSON.stringify(output)}, FF_TOKEN = ${JSON.stringify(token)};
const FF_PID = Services.appinfo.processID;
function ffWrite(name, text) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(FF_OUTPUT); file.append(name);
  const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
  stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
  const converter = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
  converter.init(stream, "UTF-8");
  converter.writeString(text); converter.close();
}
function ffRecord(kind, data) {
  ffWrite(FF_PID + "." + kind + ".json", JSON.stringify({ schemaVersion: 1, token: FF_TOKEN, pid: FF_PID, ...data }));
}
function ffHasFlush(pid) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(FF_OUTPUT); file.append(pid + ".flushed.json");
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    stream.init(file, 0x01, 0, 0);
    const converter = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
    converter.init(stream, "UTF-8", 0, 0);
    let text = "", chunk = {};
    while (converter.readString(4096, chunk)) text += chunk.value;
    converter.close();
    const receipt = JSON.parse(text);
    return receipt.token === FF_TOKEN && receipt.pid === pid && Array.isArray(receipt.errors) && receipt.errors.length === 0;
  } catch { return false; }
}
ffRecord("started", { processType: Services.appinfo.processType });
function ffFlush(reason) {
  const errors = []; let lcov = "", globals = 0;
  try {
    const { addDebuggerToGlobal } = ChromeUtils.importESModule("resource://gre/modules/jsdebugger.sys.mjs");
    const scope = Components.utils.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { freshCompartment: true });
    addDebuggerToGlobal(scope);
    const debuggerInstance = new scope.Debugger();
    const testing = Components.utils.getJSTestingFunctions();
    for (const wrapped of debuggerInstance.findAllGlobals()) {
      try { lcov += testing.getLcovInfo(wrapped.unsafeDereference()); globals++; }
      catch (error) { errors.push(String(error)); }
    }
  } catch (error) { errors.push(String(error)); }
  ffWrite(FF_PID + ".lcov", lcov);
  const receipt = { reason, globals, sourceRecords: (lcov.match(/^SF:/gm) || []).length, errors };
  ffRecord("flushed", receipt); return receipt;
}
`;
}

/** Install synchronous xpcshell shutdown collection and delayed content-process coverage. */
export function xpcshellCoverageHead(output: string, token: string): string {
  return `(() => {\n${coverageRuntime(output, token)}
if (Services.appinfo.processType === 0) Services.ppmm.loadProcessScript(${JSON.stringify(`data:application/javascript,${encodeURIComponent(contentCoverageScript(output, token))}`)}, true);
Services.obs.addObserver(() => ffFlush("xpcom-will-shutdown"), "xpcom-will-shutdown");
})();\n`;
}

/** Flush an instrumented child on request and at its last synchronous shutdown observation. */
export function contentCoverageScript(output: string, token: string): string {
  return `(() => {\n${coverageRuntime(output, token)}
if (Services.appinfo.processType === 0) {
  sendAsyncMessage("FireForge:CoverageReady:${token}", { pid: FF_PID }); return;
}
addMessageListener("FireForge:CoverageFlush:${token}", () => {
  const receipt = ffFlush("parent-barrier");
  sendAsyncMessage("FireForge:CoverageAck:${token}", { pid: FF_PID, ...receipt });
});
Services.obs.addObserver(() => ffFlush("content-child-will-shutdown"), "content-child-will-shutdown");
sendAsyncMessage("FireForge:CoverageReady:${token}", { pid: FF_PID });
})();\n`;
}

/** A bounded acknowledged parent barrier, plus a synchronous child shutdown fallback. */
export function browserCoverageApi(output: string, token: string): string {
  const content = `data:application/javascript,${encodeURIComponent(contentCoverageScript(output, token))}`;
  return `var fireforgeCoverage = class extends ExtensionAPI {
  getAPI(context) { return { fireforgeCoverage: { start() {
    if (this.started) return; this.started = true;
    ${coverageRuntime(output, token)}
    const { AsyncShutdown } = ChromeUtils.importESModule("resource://gre/modules/AsyncShutdown.sys.mjs");
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const known = new Set(), acknowledged = new Set(), readyManagers = new Set(); let wake;
    Services.ppmm.addMessageListener("FireForge:CoverageReady:${token}", message => {
      readyManagers.add(message.target);
      if (message.data.pid !== FF_PID) known.add(message.data.pid);
      if (wake) wake();
    });
    Services.ppmm.addMessageListener("FireForge:CoverageAck:${token}", message => {
      acknowledged.add(message.data.pid); if (wake) wake();
    });
    Services.ppmm.loadProcessScript(${JSON.stringify(content)}, true);
    AsyncShutdown.appShutdownConfirmed.addBlocker("FireForge acknowledged JS coverage", async () => {
      const liveManagers = Array.from({ length: Services.ppmm.childCount }, (_, i) => Services.ppmm.getChildAt(i));
      Services.ppmm.broadcastAsyncMessage("FireForge:CoverageFlush:${token}");
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 10000);
        wake = () => { if (liveManagers.every(manager => readyManagers.has(manager)) && [...known].every(pid => acknowledged.has(pid) || ffHasFlush(pid))) { clearTimeout(timeout); resolve(); } };
        wake();
      });
      ffFlush("parent-shutdown-barrier");
      const finalManagers = Array.from({ length: Services.ppmm.childCount }, (_, i) => Services.ppmm.getChildAt(i));
      ffRecord("barrier", { missingReady: [...new Set([...liveManagers, ...finalManagers])].filter(manager => !readyManagers.has(manager)).length, pending: [...known].filter(pid => !acknowledged.has(pid) && !ffHasFlush(pid)), acknowledged: [...acknowledged] });
    });
  } } }; }
};\n`;
}

/** Python exec preserves PID: the start receipt names the actual xpcshell process. */
export function xpcshellCoverageWrapper(
  binary: string,
  head: string,
  output: string,
  token: string
): string {
  return `#!/usr/bin/env python3
import json, os
output = ${JSON.stringify(output)}
with open(os.path.join(output, str(os.getpid()) + ".started.json"), "w", encoding="utf-8") as receipt:
    json.dump({"schemaVersion": 1, "token": ${JSON.stringify(token)}, "pid": os.getpid(), "processType": "xpcshell-wrapper"}, receipt)
binary = ${JSON.stringify(binary)}
os.execv(binary, [binary, "-f", ${JSON.stringify(head)}] + __import__("sys").argv[1:])
`;
}
