// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  isKnownFirefoxTopic,
  KNOWN_FIREFOX_OBSERVER_TOPICS,
  lintObserverTopics,
} from '../patch-lint-observer.js';

const FILE = 'browser/components/test.sys.mjs';
const BINARY = 'mybrowser';

describe('lintObserverTopics', () => {
  it('flags a malformed fork topic on a single-line call', () => {
    const issues = lintObserverTopics(
      'Services.obs.notifyObservers(null, "mybrowser_bad_topic");',
      FILE,
      BINARY
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('observer-topic-naming');
    expect(issues[0]?.message).toContain('mybrowser_bad_topic');
  });

  it('accepts a convention-following fork topic', () => {
    const issues = lintObserverTopics(
      'Services.obs.notifyObservers(null, "mybrowser-cache-cleared");',
      FILE,
      BINARY
    );
    expect(issues).toHaveLength(0);
  });

  it('parses multi-line call sites instead of skipping them', () => {
    const source = [
      'Services.obs.notifyObservers(',
      '  null,',
      '  "mybrowser_bad_topic"',
      ');',
    ].join('\n');
    const issues = lintObserverTopics(source, FILE, BINARY);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('mybrowser_bad_topic');
  });

  it('does not mis-capture a string inside a complex subject argument', () => {
    // The historical regex took the *first* string literal after "(",
    // which here lives inside the subject expression.
    const source =
      'Services.obs.notifyObservers(wrap({ msg: "mybrowser oops" }), "mybrowser-cache-cleared");';
    const issues = lintObserverTopics(source, FILE, BINARY);
    expect(issues).toHaveLength(0);
  });

  it('flags the actual topic even with a string decoy in the subject', () => {
    const source = [
      'Services.obs.notifyObservers(',
      '  wrap({ msg: "all good here" }),',
      '  "mybrowser_bad_topic",',
      '  "some data"',
      ');',
    ].join('\n');
    const issues = lintObserverTopics(source, FILE, BINARY);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('mybrowser_bad_topic');
  });

  it('never flags known Firefox topics, even when they embed the binary name', () => {
    // A fork named "idle" would historically see "idle-daily" flagged.
    const issues = lintObserverTopics(
      'Services.obs.notifyObservers(null, "idle-daily");',
      FILE,
      'idle'
    );
    expect(issues).toHaveLength(0);
  });

  it('skips simulated Firefox topics in tests (idle-daily shape)', () => {
    const issues = lintObserverTopics(
      'Services.obs.notifyObservers(null, "idle-daily");',
      FILE,
      BINARY
    );
    expect(issues).toHaveLength(0);
  });

  it('treats the quit-application family as known topics', () => {
    for (const topic of [
      'quit-application',
      'quit-application-requested',
      'quit-application-granted',
    ]) {
      expect(isKnownFirefoxTopic(topic)).toBe(true);
    }
    expect(KNOWN_FIREFOX_OBSERVER_TOPICS.has('idle-daily')).toBe(true);
  });

  it('skips constant-named topics entirely', () => {
    const source = [
      'const TOPIC = "mybrowser_bad_topic";',
      'Services.obs.addObserver(observer, TOPIC);',
      'Services.obs.removeObserver(observer, lazy.Topics.SOMETHING);',
    ].join('\n');
    const issues = lintObserverTopics(source, FILE, BINARY);
    expect(issues).toHaveLength(0);
  });

  it('skips template literals with interpolation and concatenations', () => {
    const source = [
      'Services.obs.notifyObservers(null, `mybrowser_${kind}`);',
      'Services.obs.notifyObservers(null, "mybrowser_" + kind);',
    ].join('\n');
    const issues = lintObserverTopics(source, FILE, BINARY);
    expect(issues).toHaveLength(0);
  });

  it('checks addObserver and removeObserver topic arguments too', () => {
    const source = [
      'Services.obs.addObserver(',
      '  { observe() { return null; } },',
      '  "mybrowser_observed"',
      ');',
      'Services.obs.removeObserver(observer, "mybrowser_observed");',
    ].join('\n');
    const issues = lintObserverTopics(source, FILE, BINARY);
    expect(issues).toHaveLength(2);
  });

  it('ignores commas nested in calls and objects when locating the topic', () => {
    const source = [
      'Services.obs.notifyObservers(',
      '  build(a, b, { c: 1, d: [2, 3] }),',
      '  "mybrowser-data-synced"',
      ');',
    ].join('\n');
    const issues = lintObserverTopics(source, FILE, BINARY);
    expect(issues).toHaveLength(0);
  });

  it('does not flag unrelated topics without the binary name', () => {
    const issues = lintObserverTopics(
      'Services.obs.notifyObservers(null, "some-other-topic");',
      FILE,
      BINARY
    );
    expect(issues).toHaveLength(0);
  });

  it('gives up gracefully on an unterminated call', () => {
    const issues = lintObserverTopics(
      'Services.obs.notifyObservers(null, "mybrowser_bad_topic"',
      FILE,
      BINARY
    );
    expect(issues).toHaveLength(0);
  });
});
