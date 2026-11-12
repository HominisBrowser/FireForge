// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { memoryFiles, noTransaction } from '../testing/files.js';
import { applyEdits } from './files.js';
import {
  addDestroy,
  addInit,
  addSubscript,
  asCall,
  validateWireExpression,
  validateWireName,
} from './js.js';
import { planWire } from './wire.js';

const MARKER = 'MYBROWSER:';

const BROWSER_MAIN = `var gBrowserMain = {
  load() {
    try {
      Services.scriptloader.loadSubScript("chrome://browser/content/first.js", this);
    } catch (e) {
      console.error("first", e);
    }
    try {
      Services.scriptloader.loadSubScript("chrome://browser/content/second.js", this);
    } catch (e) {
      console.error("second", e);
    }
    let after = "}";
  },
};
`;

const BROWSER_INIT = `var gBrowserInit = {
  onLoad() {
    // keep: braces in strings { } do not matter
    let text = "{";
    gBrowserStartup.init();
  },
  onUnload() {
    gBrowserShutdown.go();
  },
};
`;

const EMPTY_INIT = `var gBrowserInit = {
  onLoad() {},
  uninit() {},
};
`;

describe('addSubscript', () => {
  it('inserts after the last existing loadSubScript block', () => {
    const next = addSubscript(BROWSER_MAIN, 'third', MARKER) ?? '';
    expect(next).toContain(
      `    }\n    // ${MARKER} wire-subscript third\n    try {\n      Services.scriptloader.loadSubScript("chrome://browser/content/third.js", this);`
    );
    expect(next.indexOf('third.js')).toBeGreaterThan(next.indexOf('second.js'));
    expect(next.indexOf('third.js')).toBeLessThan(next.indexOf('let after'));
  });

  it('is idempotent', () => {
    expect(addSubscript(BROWSER_MAIN, 'second', MARKER)).toBeUndefined();
  });

  it('does not match a longer name', () => {
    expect(addSubscript(BROWSER_MAIN, 'sec', MARKER)).toBeDefined();
  });

  it('inserts before the closing brace when nothing is loaded yet', () => {
    const next = addSubscript('function f() {\n  work();\n}\n', 'first', MARKER) ?? '';
    expect(next).toBe(
      [
        'function f() {',
        '  work();',
        `  // ${MARKER} wire-subscript first`,
        '  try {',
        '    Services.scriptloader.loadSubScript("chrome://browser/content/first.js", this);',
        '  } catch (e) {',
        '    console.error("Failed to load first.js:", e);',
        '  }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('refuses a file with no closing brace to anchor on', () => {
    expect(() => addSubscript('work();\n', 'first', MARKER)).toThrow(/no closing brace/);
  });

  it('refuses a file that does not parse', () => {
    expect(() => addSubscript('function {', 'first', MARKER)).toThrow(/cannot be parsed/);
  });
});

describe('addInit and addDestroy', () => {
  it('puts the first init before the first statement of onLoad', () => {
    const next = addInit(BROWSER_INIT, 'Feature.init', { marker: MARKER }) ?? '';
    expect(next).toContain(
      `    // keep: braces in strings { } do not matter\n    // ${MARKER} wire-init Feature\n    try {\n      if (typeof Feature !== "undefined") {\n        Feature.init();\n      }\n    } catch (e) {\n      console.error("Feature init failed:", e);\n    }\n    let text`
    );
  });

  it('adds later inits after the last guarded block, or after the one --after names', () => {
    const one = addInit(BROWSER_INIT, 'One.init()', { marker: MARKER }) ?? '';
    const two = addInit(one, 'Two.init', { marker: MARKER }) ?? '';
    expect(two.indexOf('One.init')).toBeLessThan(two.indexOf('Two.init'));
    const three = addInit(two, 'Three.init', { marker: MARKER, after: 'One' }) ?? '';
    expect(three.indexOf('One.init')).toBeLessThan(three.indexOf('Three.init'));
    expect(three.indexOf('Three.init')).toBeLessThan(three.indexOf('Two.init'));
  });

  it('matches --after on whole identifiers', () => {
    const one = addInit(BROWSER_INIT, 'FooBar.init', { marker: MARKER }) ?? '';
    const two = addInit(one, 'Other.init', { marker: MARKER }) ?? '';
    const three = addInit(two, 'Last.init', { marker: MARKER, after: 'Foo' }) ?? '';
    expect(three.indexOf('Last.init')).toBeGreaterThan(three.indexOf('Other.init'));
  });

  it('is idempotent for the bare and the called form', () => {
    const next = addInit(BROWSER_INIT, 'Feature.init', { marker: MARKER }) ?? '';
    expect(addInit(next, 'Feature.init', { marker: MARKER })).toBeUndefined();
    expect(addInit(next, 'Feature.init()', { marker: MARKER })).toBeUndefined();
  });

  it('does not count a commented-out call as wired', () => {
    const commented = BROWSER_INIT.replace(
      'gBrowserStartup.init();',
      'gBrowserStartup.init();\n    // Feature.init();'
    );
    expect(addInit(commented, 'Feature.init', { marker: MARKER })).toContain(
      'if (typeof Feature !== "undefined")'
    );
  });

  it('fills an empty onLoad body', () => {
    const next = addInit(EMPTY_INIT, 'Feature.init', { marker: MARKER }) ?? '';
    expect(next).toContain('onLoad() {\n    // MYBROWSER: wire-init Feature');
  });

  it('puts destroy first in onUnload, newest first', () => {
    const one = addDestroy(BROWSER_INIT, 'One.destroy', MARKER) ?? '';
    const two = addDestroy(one, 'Two.destroy', MARKER) ?? '';
    expect(two.indexOf('Two.destroy')).toBeLessThan(two.indexOf('One.destroy'));
    expect(two.indexOf('One.destroy')).toBeLessThan(two.indexOf('gBrowserShutdown'));
  });

  it('accepts uninit and does not match a substring when judging idempotency', () => {
    const next = addDestroy(EMPTY_INIT, 'Feature.destroy', MARKER) ?? '';
    expect(next).toContain('uninit() {\n    // MYBROWSER: wire-destroy Feature');
    expect(addDestroy(next, 'Feature.destroy', MARKER)).toBeUndefined();
    expect(addDestroy(next, 'eature.destroy', MARKER)).toBeDefined();
  });

  it('refuses a file without the method', () => {
    expect(() => addInit('var x = { other() {} };', 'A.init', { marker: MARKER })).toThrow(
      /onLoad/
    );
    expect(() => addDestroy('var x = { other() {} };', 'A.go', MARKER)).toThrow(/onUnload/);
  });
});

describe('validation', () => {
  it('accepts safe names and expressions', () => {
    expect(() => {
      validateWireName('my-feature_2');
    }).not.toThrow();
    expect(() => {
      validateWireExpression('A.b.c', 'init');
    }).not.toThrow();
    expect(() => {
      validateWireExpression('A.b()', 'init');
    }).not.toThrow();
    expect(asCall('A.b')).toBe('A.b()');
    expect(asCall('A.b()')).toBe('A.b()');
  });

  it.each(['../x', 'a/b', '1abc', 'a b', '', '__proto__', 'constructor'])(
    'refuses the name %j',
    (name) => {
      expect(() => {
        validateWireName(name);
      }).toThrow();
    }
  );

  it.each(['a;b', 'a["x"]', 'a-b', '1a', 'a.__proto__.x', 'A.constructor()', 'a..b', 'a()()'])(
    'refuses the expression %j',
    (expression) => {
      expect(() => {
        validateWireExpression(expression, 'init');
      }).toThrow();
    }
  );
});

describe('planWire', () => {
  const JAR = 'browser.jar:\n        content/browser/first.js    (content/first.js)\n';
  const XHTML = '<window>\n#include browser-sets.inc\n<html:body>\n</window>\n';
  const DOM = {
    file: 'browser/base/content/frag.inc.xhtml',
    target: 'browser/base/content/browser.xhtml',
  };

  function engine(extra: Record<string, string> = {}): ReturnType<typeof memoryFiles> {
    return memoryFiles({
      'browser/base/content/browser-main.js': BROWSER_MAIN,
      'browser/base/content/browser-init.js': BROWSER_INIT,
      'browser/base/content/browser.xhtml': XHTML,
      'browser/base/content/frag.inc.xhtml': '<box id="frag"/>\n',
      'browser/base/content/feature.js': '// feature\n',
      'browser/base/jar.mn': JAR,
      ...extra,
    });
  }

  const request = { name: 'feature', subscriptDir: 'browser/base/content', marker: MARKER };

  it('wires the subscript, init, destroy, include and jar entry in one plan', async () => {
    const files = engine();
    const plan = await planWire(files, {
      ...request,
      init: 'Feature.init',
      destroy: 'Feature.destroy',
      dom: DOM,
    });
    expect(plan.steps.every((step) => !step.present)).toBe(true);
    await applyEdits(noTransaction, files, plan.edits);
    expect(files.contents.get('browser/base/content/browser-main.js')).toContain('feature.js');
    const init = files.contents.get('browser/base/content/browser-init.js') ?? '';
    expect(init).toContain('Feature.init();');
    expect(init).toContain('Feature.destroy();');
    expect(files.contents.get('browser/base/content/browser.xhtml')).toBe(
      '<window>\n#include frag.inc.xhtml\n#include browser-sets.inc\n<html:body>\n</window>\n'
    );
    expect(files.contents.get('browser/base/jar.mn')).toContain(
      'content/browser/feature.js    (content/feature.js)'
    );
  });

  it('reports every step as present the second time', async () => {
    const files = engine();
    const wire = { ...request, init: 'Feature.init', dom: DOM };
    await applyEdits(noTransaction, files, (await planWire(files, wire)).edits);
    const again = await planWire(files, wire);
    expect(again.edits).toEqual([]);
    expect(again.steps.every((step) => step.present)).toBe(true);
  });

  it('computes the jar source of a subscript outside browser/base/content', async () => {
    const files = engine({ 'browser/base/extra/feature.js': '' });
    const plan = await planWire(files, { ...request, subscriptDir: 'browser/base/extra' });
    const jar = plan.edits.find((edit) => edit.path === 'browser/base/jar.mn');
    expect(jar?.content).toContain('(extra/feature.js)');
  });

  it('plans nothing when a later step cannot be done, so nothing is half wired', async () => {
    const files = engine({ 'browser/base/content/browser.xhtml': '<window/>\n' });
    const before = new Map(files.contents);
    await expect(planWire(files, { ...request, dom: DOM })).rejects.toThrow(
      /neither "#include browser-sets.inc" nor <html:body>/
    );
    expect(files.contents).toEqual(before);
  });

  it('falls back to <html:body> and replaces an inlined fragment', async () => {
    const onlyBody = engine({
      'browser/base/content/browser.xhtml': '<window>\n<html:body>\n</window>\n',
    });
    const plan = await planWire(onlyBody, { ...request, dom: DOM });
    expect(plan.edits.find((edit) => edit.path === DOM.target)?.content).toBe(
      '<window>\n<html:body>\n#include frag.inc.xhtml\n</window>\n'
    );
    const inlined = engine({
      'browser/base/content/browser.xhtml':
        '<window>\n  <box id="frag"/>\n\n#include browser-sets.inc\n</window>\n',
    });
    const migrated = await planWire(inlined, { ...request, dom: DOM });
    expect(migrated.edits.find((edit) => edit.path === DOM.target)?.content).toBe(
      '<window>\n#include frag.inc.xhtml\n\n#include browser-sets.inc\n</window>\n'
    );
  });

  it('replaces exactly the inlined element, not another one carrying the id in a longer attribute', async () => {
    const files = engine({
      'browser/base/content/frag.inc.xhtml': '<vbox id="frag">\n  <label/>\n</vbox>\n',
      'browser/base/content/browser.xhtml':
        '<window>\n  <box data-testid="frag"/>\n  <vbox id="frag">\n    <vbox/>\n    <label/>\n  </vbox>\n  <toolbar id="keep"/>\n</window>\n',
    });
    const plan = await planWire(files, { ...request, dom: DOM });
    expect(plan.edits.find((edit) => edit.path === DOM.target)?.content).toBe(
      '<window>\n  <box data-testid="frag"/>\n#include frag.inc.xhtml\n  <toolbar id="keep"/>\n</window>\n'
    );
  });

  it('computes the include path relative to a target outside browser/base/content', async () => {
    const files = engine({ 'browser/other/win.xhtml': '<html:body>\n' });
    const plan = await planWire(files, {
      ...request,
      dom: { file: DOM.file, target: 'browser/other/win.xhtml' },
    });
    expect(plan.edits.find((edit) => edit.path === 'browser/other/win.xhtml')?.content).toContain(
      '#include ../base/content/frag.inc.xhtml'
    );
  });

  it('can insist that the subscript exists, and always that the fragment does', async () => {
    const files = engine();
    await expect(
      planWire(files, { ...request, name: 'ghost', requireSubscript: true })
    ).rejects.toThrow(/Subscript file not found: browser\/base\/content\/ghost\.js/);
    await expect(
      planWire(files, { ...request, dom: { file: 'nope.inc.xhtml', target: DOM.target } })
    ).rejects.toThrow(/DOM fragment not found/);
  });

  it('refuses unsafe input before reading anything', async () => {
    const files = engine();
    await expect(planWire(files, { ...request, name: '../x' })).rejects.toThrow(
      /Invalid subscript name/
    );
    await expect(planWire(files, { ...request, init: 'a;b' })).rejects.toThrow(
      /Invalid init expression/
    );
    await expect(planWire(files, { ...request, after: 'a/b' })).rejects.toThrow(
      /Invalid after name/
    );
  });
});
