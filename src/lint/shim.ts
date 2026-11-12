// SPDX-License-Identifier: EUPL-1.2
/**
 * The declarations both type passes add to every program: Firefox's
 * privileged globals, Lit, and the test harness.
 *
 * Firefox JavaScript runs in scopes TypeScript does not know, so the shim
 * declares the common globals, mostly as `any`. Structured globals
 * (`ChromeUtils`, `Cu`, `Localization`) are declared through named
 * interfaces (`ChromeUtilsShim`, `CuShim`, ...) so a project shim adds
 * members by interface merging; `Cu` has a closed member list
 * (`nsIXPCComponents_Utils`), so calling a member it lacks is an error.
 * `resource:` and `chrome:` imports no file resolves fall to ambient
 * wildcard modules and type as `any`.
 */

/** Firefox's privileged globals. */
export const FIREFOX_GLOBALS_SHIM = `
declare var Services: any;
// Extensible via interface merging from a project shim.
interface ChromeUtilsShim {
  defineESModuleGetters(target: any, modules: Record<string, string>): void;
  importESModule(specifier: string): any;
  import(specifier: string): any;
  registerWindowActor(name: string, options: Record<string, any>): void;
  defineModuleGetter(target: any, name: string, specifier: string): void;
  defineLazyGetter(target: any, name: string, getter: () => any): void;
  generateQI(interfaces: any[]): Function;
  getClassName(obj: any, unwrap?: boolean): string;
  isClassInfo(obj: any): boolean;
  // Two WebIDL overloads (URI string or nsIURI) collapsed into one loose signature.
  predictRemoteTypeForURI(uri: string | object | null, options?: object): string | null;
}
declare var ChromeUtils: ChromeUtilsShim;
// Components.utils (js/xpconnect/idl/xpccomponents.idl, nsIXPCComponents_Utils).
// Every member is listed with loose (any) jsval parameters and
// results, so Xray-waived and cloned objects keep their expandos, but the
// member set is closed: a call to a member Cu does not have (Cu.now() is
// ChromeUtils.now()) is a typecheck error instead of a runtime TypeError.
// Extensible via interface merging, same as ChromeUtilsShim.
interface CuShim {
  QueryInterface(iid: any): any;
  printStderr(message: string): void;
  reportError(error: any, stack?: any): void;
  readonly Sandbox: { new (principal: any, options?: any): any; (principal: any, options?: any): any };
  evalInSandbox(
    source: string,
    sandbox: any,
    version?: any,
    filename?: string,
    lineNo?: number,
    enforceFilenameRestrictions?: boolean
  ): any;
  getUAWidgetScope(principal: any): any;
  getSandboxMetadata(sandbox: any): any;
  setSandboxMetadata(sandbox: any, metadata: any): void;
  setSandboxLocaleOverride(sandbox: any, locale: string): void;
  setSandboxTimezoneOverride(sandbox: any, timezone: string): void;
  isESModuleLoaded(resourceURI: string): boolean;
  importGlobalProperties(propertyList: any): void;
  getWeakReference(obj: any): { get(): any };
  forceGC(): void;
  forceCC(listener?: any): void;
  createCCLogger(): any;
  finishCC(): void;
  ccSlice(budget: number): void;
  getMaxCCSliceTimeSinceClear(): number;
  clearMaxCCTime(): void;
  forceShrinkingGC(): void;
  schedulePreciseGC(callback: any): void;
  schedulePreciseShrinkingGC(callback: any): void;
  unlinkGhostWindows(): void;
  intentionallyLeak(): void;
  getJSTestingFunctions(): any;
  getFunctionSourceLocation(func: any): any;
  callFunctionWithAsyncStack(func: any, stack: any, asyncCause: string): any;
  getGlobalForObject(obj: any): any;
  isProxy(obj: any): boolean;
  exportFunction(func: any, scope: any, options?: any): any;
  createObjectIn(scope: any, options?: any): any;
  makeObjectPropsNormal(obj: any): void;
  isDeadWrapper(obj: any): boolean;
  isRemoteProxy(val: any): boolean;
  recomputeWrappers(obj?: any): void;
  setWantXrays(scope: any): void;
  dispatch(runnable: any, scope?: any): void;
  readonly isInAutomation: boolean;
  exitIfInAutomation(): void;
  crashIfNotInAutomation(): void;
  setGCZeal(zeal: number): void;
  nukeSandbox(obj: any): void;
  blockScriptForGlobal(global: any): void;
  unblockScriptForGlobal(global: any): void;
  isOpaqueWrapper(obj: any): boolean;
  isXrayWrapper(obj: any): boolean;
  waiveXrays(val: any): any;
  unwaiveXrays(val: any): any;
  getClassName(obj: any, unwrap: boolean): string;
  getIncumbentGlobal(callback?: any): any;
  getDebugName(obj: any): string;
  getWatchdogTimestamp(category: string): number;
  getJSEngineTelemetryValue(): any;
  cloneInto(value: any, scope: any, options?: any): any;
  getWebIDLCallerPrincipal(): any;
  getObjectPrincipal(obj: any): any;
  getRealmLocation(obj: any): string;
  readUTF8File(file: any): string;
  readUTF8URI(url: any): string;
  createSpellChecker(): any;
  createCommandLine(args: string[], workingDir: any, state: number): any;
  createCommandParams(): any;
  createLoadContext(): any;
  createPrivateLoadContext(): any;
  createPersistentProperties(): any;
  createDocumentEncoder(contentType: string): any;
  createHTMLCopyEncoder(): any;
  readonly loadedESModules: string[];
  getModuleImportStack(location: string): string;
}
declare var Cu: CuShim;
declare var Ci: any;
declare var Cc: any;
declare var Cr: any;
declare var Components: any;
declare var XPCOMUtils: any;
declare var lazy: Record<string, any>;
declare var PathUtils: any;
declare var IOUtils: any;
declare var FileUtils: any;
declare var gBrowser: any;
declare var gURLBar: any;
declare var gNavigatorBundle: any;
declare var AppConstants: any;
declare class JSWindowActorChild {
  readonly browsingContext: any;
  readonly contentWindow: any;
  readonly document: any;
  sendAsyncMessage(name: string, data?: any, transfers?: any[]): void;
  sendQuery(name: string, data?: any, transfers?: any[]): Promise<any>;
}
declare class JSWindowActorParent {
  readonly browsingContext: any;
  sendAsyncMessage(name: string, data?: any, transfers?: any[]): void;
  sendQuery(name: string, data?: any, transfers?: any[]): Promise<any>;
}
// Fluent localization, a stable chrome global. Members stay loose (any),
// but the constructor shape is declared so "new Localization([...])" and
// "new Localization([...], true)" typecheck without a local cast. Both
// interfaces are extensible via interface merging from a project extra
// shim, same as ChromeUtilsShim.
interface LocalizationInstanceShim {
  formatValue(id: string, args?: Record<string, unknown>): any;
  formatValues(keys: any[]): any;
  formatMessages(keys: any[]): any;
  formatValueSync(id: string, args?: Record<string, unknown>): any;
  formatValuesSync(keys: any[]): any;
  formatMessagesSync(keys: any[]): any;
  addResourceIds(ids: Array<string | { path: string; optional?: boolean }>): void;
  removeResourceIds(ids: string[]): number;
  setAsync(): void;
}
interface LocalizationShim {
  new (
    resourceIds: Array<string | { path: string; optional?: boolean }>,
    sync?: boolean
  ): LocalizationInstanceShim;
}
declare var Localization: LocalizationShim;

// Shorthand ambient modules: imports of URLs no file resolves are typed any.
declare module 'resource:*';
declare module 'chrome:*';

`;

/**
 * Loose test-harness globals (mochitest browser-chrome, xpcshell), appended
 * after the project's test shim, whose typed declarations come first and win.
 */
export const TEST_HARNESS_SHIM = `
// ── FireForge test-harness shim (loose baseline) ──
declare var TestUtils: any;
declare var BrowserTestUtils: any;
declare var SpecialPowers: any;
declare var EventUtils: any;
declare var SimpleTest: any;
declare var Assert: any;
declare var gTestPath: string;
declare var content: any;
declare function add_task(task: (...args: any[]) => any): any;
declare function add_setup(task: (...args: any[]) => any): any;
declare function ok(condition: any, message?: string): void;
declare function is(actual: any, expected: any, message?: string): void;
declare function isnot(actual: any, expected: any, message?: string): void;
declare function todo(condition: any, message?: string): void;
declare function todo_is(actual: any, expected: any, message?: string): void;
declare function todo_isnot(actual: any, expected: any, message?: string): void;
declare function info(message: string): void;
declare function registerCleanupFunction(callback: (...args: any[]) => any): void;
declare function waitForExplicitFinish(): void;
declare function finish(): void;
declare function do_get_profile(): any;
declare function run_test(): any;

`;

/**
 * Typed Lit: `LitElement` (with `ReactiveElement`'s lifecycle) and
 * `MozLitElement` with closed member lists, so a misspelt member of a widget
 * is an error; template helpers stay loose. A widget casts its base to the
 * global `MozLitElementWith<Extra>` to declare the getters `static queries`
 * installs. A project shim can merge members into `LitElementShimMembers`.
 */
export const LIT_TYPES_SHIM = `
// ── FireForge typed Lit (litTypes) ──
interface LitPropertyDeclarationShim {
  type?: unknown;
  attribute?: boolean | string;
  reflect?: boolean;
  state?: boolean;
  noAccessor?: boolean;
  converter?: unknown;
  hasChanged?(value: unknown, oldValue: unknown): boolean;
  fluent?: boolean;
}
interface LitElementShimMembers {
  readonly renderRoot: HTMLElement | DocumentFragment;
  readonly isUpdatePending: boolean;
  readonly hasUpdated: boolean;
  readonly updateComplete: Promise<boolean>;
  renderOptions: any;
  requestUpdate(name?: PropertyKey, oldValue?: unknown, options?: LitPropertyDeclarationShim): void;
  addController(controller: any): void;
  removeController(controller: any): void;
  connectedCallback(): void;
  disconnectedCallback(): void;
  attributeChangedCallback(name: string, oldValue: string | null, value: string | null): void;
  createRenderRoot(): HTMLElement | DocumentFragment;
  enableUpdating(requestedUpdate: boolean): void;
  scheduleUpdate(): void | Promise<unknown>;
  performUpdate(): void;
  getUpdateComplete(): Promise<boolean>;
  shouldUpdate(changedProperties: Map<PropertyKey, unknown>): boolean;
  willUpdate(changedProperties: Map<PropertyKey, unknown>): void;
  update(changedProperties: Map<PropertyKey, unknown>): void;
  render(): unknown;
  firstUpdated(changedProperties: Map<PropertyKey, unknown>): void;
  updated(changedProperties: Map<PropertyKey, unknown>): void;
}
declare module 'chrome://global/content/vendor/lit.all.mjs' {
  export class ReactiveElement extends HTMLElement {
    static properties: Record<string, LitPropertyDeclarationShim>;
    static styles: any;
    static shadowRootOptions: ShadowRootInit;
    static get observedAttributes(): string[];
    static createProperty(name: PropertyKey, options?: LitPropertyDeclarationShim): void;
    static addInitializer(initializer: (element: ReactiveElement) => void): void;
  }
  export interface ReactiveElement extends LitElementShimMembers {}
  export class LitElement extends ReactiveElement {}
  export const html: (strings: TemplateStringsArray, ...values: unknown[]) => any;
  export const svg: (strings: TemplateStringsArray, ...values: unknown[]) => any;
  export const css: (strings: TemplateStringsArray, ...values: unknown[]) => any;
  export const nothing: any;
  export const noChange: any;
  export const render: any;
  export const unsafeCSS: any;
  export const classMap: any;
  export const styleMap: any;
  export const ifDefined: any;
  export const repeat: any;
  export const when: any;
  export const map: any;
  export const live: any;
  export const ref: any;
  export const createRef: any;
  export const until: any;
  export const guard: any;
  export const choose: any;
  export const keyed: any;
  export const cache: any;
  export const join: any;
  export const range: any;
  export const unsafeHTML: any;
  export const unsafeSVG: any;
  export const literal: any;
  export const unsafeStatic: any;
  export const staticHtml: any;
  export const staticSvg: any;
  export const directive: any;
  export const Directive: any;
  export const AsyncDirective: any;
  export const PartType: any;
  export const defaultConverter: any;
  export const notEqual: any;
  export const adoptStyles: any;
  export const supportsAdoptingStyleSheets: boolean;
  export const CSSResult: any;
  export const isServer: boolean;
}
declare module 'chrome://global/content/lit-utils.mjs' {
  import { LitElement } from 'chrome://global/content/vendor/lit.all.mjs';
  export class MozLitElement extends LitElement {
    static queries: Record<string, string | Record<string, unknown>>;
    static fragment: unknown;
    dispatchOnUpdateComplete(event: Event): Promise<void>;
  }
  export const MozBaseInputElement: any;
  export const MozBoolInputElement: any;
  export const SelectControlBaseElement: any;
  export const SelectControlItemMixin: any;
}
// MozLitElement with instance members Extra: what a widget casts its base
// to for the getters static queries installs (and properties it declares
// only in static properties). A class field would redefine a query getter
// and throw, and a constructor declaration reads it before renderRoot.
type MozLitElementWith<Extra> = Pick<
  typeof import('chrome://global/content/lit-utils.mjs').MozLitElement,
  keyof typeof import('chrome://global/content/lit-utils.mjs').MozLitElement
> &
  (new () => import('chrome://global/content/lit-utils.mjs').MozLitElement & Extra);
`;

/** Without typed Lit, `MozLitElementWith<Extra>` is `any`, as the base it casts is. */
export const LOOSE_LIT_SHIM = `
// FireForge loose Lit (litTypes off).
type MozLitElementWith<Extra> = any;
`;
