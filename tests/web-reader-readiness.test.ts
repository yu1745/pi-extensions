import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readinessInput, readinessNote, waitForReadableContent, type PageSample, type ReadinessPage } from '../extensions/web-reader/readiness.ts';
import { DISMISS_CONSENT_SCRIPT } from '../extensions/web-reader/page.ts';
import type { ClassifierContext, ClassifierResult } from '@earendil-works/pi-ai';
import type { JevClassifier } from '../extensions/shared/jev/runtime.ts';

const url = 'https://example.com/article';
const sample: PageSample = { title: 'Article', text: 'An article with readable prose.', textLength: 3000, contentEvidence: true, pendingContent: false, consentText: '' };
function response(kind = 'content', ready = 0.88): ClassifierResult {
  return { api: 'typesafe-system-one', provider: 'typesafe', model: 'test', timestamp: 0, stopReason: 'stop', answers: {
    page_kind: { type: 'choice', choice: kind, confidence: 0.99, probabilities: { [kind]: 0.99 } },
    is_ready: { type: 'bool', probability: ready },
  } };
}
function fixture(state: (clock: number) => PageSample = () => sample) {
  let clock = 0;
  const page: ReadinessPage = {
    async evaluate<T>(script: string): Promise<T> { return (script === DISMISS_CONSENT_SCRIPT ? false : state(clock)) as T; },
    async waitForTimeout(ms) { clock += ms; },
  };
  return { page, now: () => clock, advance: (ms: number) => { clock += ms; } };
}
const service = (evaluate: JevClassifier['evaluate']): JevClassifier => ({ evaluate });

test('asks separate typed decisions and finds a restriction after long navigation', async () => {
  const gate = { ...sample, contentEvidence: false, text: `${'Language menu '.repeat(400)}该游戏包含您要求屏蔽的内容：一些裸露画面或色情内容` };
  const f = fixture(() => gate);
  const inputs: ClassifierContext[] = [];
  const result = await waitForReadableContent(f.page, url, service(async input => { inputs.push(input); return response('content_gate', 0.88); }), undefined, f.now);
  assert.equal(result.blocked, 'content_gate');
  assert.equal(result.jevScore, 0.88);
  assert.equal(result.incomplete, false);
  assert.deepEqual(Object.keys(inputs[0].questions), ['page_kind', 'is_ready']);
  assert.equal(inputs[0].questions.is_ready.type, 'bool');
  assert.deepEqual(Object.keys(inputs[0].questions.is_ready.criteria), ['true', 'false']);
  const state = readinessInput(url, gate).state as { contentExcerpt: string };
  assert.ok(state.contentExcerpt.includes('该游戏包含您要求屏蔽的内容'));
  assert.ok(state.contentExcerpt.length <= 500);
  assert.match(readinessNote(result), /not the requested content/);
});

test('ordinary articles remain readable and a high rendering score cannot mask a loader', async () => {
  const f = fixture();
  assert.equal((await waitForReadableContent(f.page, url, service(async () => response()), undefined, f.now)).pageKind, 'content');
  const loading = fixture(() => ({ ...sample, pendingContent: true }));
  const result = await waitForReadableContent(loading.page, url, service(async () => response('content', 0.99)), undefined, loading.now);
  assert.equal(result.incomplete, true);
  assert.ok(result.verdicts <= 6);
});

test('unavailable decisions do not turn a gate or a stable menu into successful content', async () => {
  const gate = fixture(() => ({ ...sample, text: 'This game contains content you have asked not to see.', contentEvidence: false }));
  assert.equal((await waitForReadableContent(gate.page, url, undefined, undefined, gate.now)).blocked, 'content_gate');
  const menu = fixture(() => ({ ...sample, contentEvidence: false }));
  assert.equal((await waitForReadableContent(menu.page, url, undefined, undefined, menu.now)).incomplete, true);
  assert.equal(menu.now(), 8000);
});

test('waits through a stable shell for late article text on fallback', async () => {
  const f = fixture(clock => clock < 4900 ? { ...sample, text: 'Navigation only', contentEvidence: false } : sample);
  const result = await waitForReadableContent(f.page, url, undefined, undefined, f.now);
  assert.equal(result.pageKind, 'content');
  assert.ok(f.now() >= 4900);
});

test('does not add another wait budget after a decision failure', async () => {
  const f = fixture(() => ({ ...sample, contentEvidence: false }));
  const result = await waitForReadableContent(f.page, url, service(async () => { f.advance(7000); throw new Error('unavailable'); }), undefined, f.now);
  assert.equal(result.incomplete, true);
  assert.equal(result.fallback, true);
  assert.equal(f.now(), 8000);
});

test('resamples before accepting a verdict when equal-length content changed during the request', async () => {
  let changed = false;
  const f = fixture(() => changed ? { ...sample, text: 'Different shell of same length', contentEvidence: false } : sample);
  const result = await waitForReadableContent(f.page, url, service(async () => {
    if (!changed) { changed = true; return response('content', 0.99); }
    return response('content', 0.1);
  }), undefined, f.now);
  assert.equal(result.incomplete, true);
});

test('keeps articles discussing restrictions when their real content is present', async () => {
  const f = fixture(() => ({ ...sample, text: 'A technical guide to the notice: verify your age.' }));
  const result = await waitForReadableContent(f.page, url, service(async () => response('content', 0.99)), undefined, f.now);
  assert.equal(result.pageKind, 'content');
  assert.equal(result.blocked, undefined);
});

test('native bool probabilities retain the exact readiness thresholds', async () => {
  for (const [probability, evidence, expected] of [[0.9, false, false], [0.90001, false, true], [0.5, true, true], [0.4999, true, false]] as const) {
    const f = fixture(() => ({ ...sample, contentEvidence: evidence }));
    const verdict = await waitForReadableContent(f.page, url, service(async () => response('content', probability)), undefined, f.now);
    assert.equal(verdict.pageKind === 'content', expected, `probability=${probability} evidence=${evidence}`);
    assert.ok(f.now() <= 8000);
    assert.ok(verdict.verdicts <= 6);
  }
});

test('reports an unresolved consent wall and propagates user cancellation', async () => {
  const f = fixture(() => ({ ...sample, contentEvidence: false, consentText: 'Cookie settings' }));
  assert.equal((await waitForReadableContent(f.page, url, service(async () => response('consent_wall')), undefined, f.now)).blocked, 'consent_wall');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(waitForReadableContent(f.page, url, undefined, controller.signal, f.now), /cancelled/);
});
