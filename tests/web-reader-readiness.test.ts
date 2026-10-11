import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readinessInput, readinessNote, waitForReadableContent, type PageSample, type ReadinessPage } from '../extensions/web-reader/readiness.ts';
import { DISMISS_CONSENT_SCRIPT } from '../extensions/web-reader/page.ts';
import type { JevEvaluateRequest, JevEvaluateResponse, JevServiceV1 } from '../extensions/shared/jev/types.ts';

const url = 'https://example.com/article';
const sample: PageSample = { title: 'Article', text: 'An article with readable prose.', textLength: 3000, contentEvidence: true, pendingContent: false, consentText: '' };
function response(kind = 'content', ready = 0.88): JevEvaluateResponse {
  return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers: {
    page_kind: { type: 'choice', choice: kind, confidence: 0.99, probabilities: { [kind]: 0.99 } },
    is_ready: { type: 'noul', noul: ready },
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
const service = (evaluate: JevServiceV1['evaluate']): JevServiceV1 => ({ version: 1, evaluate });

test('asks separate typed decisions and finds a restriction after long navigation', async () => {
  const gate = { ...sample, contentEvidence: false, text: `${'Language menu '.repeat(400)}该游戏包含您要求屏蔽的内容：一些裸露画面或色情内容` };
  const f = fixture(() => gate);
  const inputs: JevEvaluateRequest[] = [];
  const result = await waitForReadableContent(f.page, url, service(async input => { inputs.push(input); return response('content_gate', 0.88); }), undefined, f.now);
  assert.equal(result.blocked, 'content_gate');
  assert.equal(result.jevScore, 0.88);
  assert.equal(result.incomplete, false);
  assert.deepEqual(Object.keys(inputs[0].questions), ['page_kind', 'is_ready']);
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

test('reports an unresolved consent wall and propagates user cancellation', async () => {
  const f = fixture(() => ({ ...sample, contentEvidence: false, consentText: 'Cookie settings' }));
  assert.equal((await waitForReadableContent(f.page, url, service(async () => response('consent_wall')), undefined, f.now)).blocked, 'consent_wall');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(waitForReadableContent(f.page, url, undefined, controller.signal, f.now), /cancelled/);
});
