import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClassifierContext, ClassifierResult, Usage } from '@earendil-works/pi-ai';
import { createJevClassifier, createJevUsageAccumulator, type JevContext } from '../extensions/shared/jev/runtime.ts';

const request: ClassifierContext = { state: { text: 'article' }, questions: {
  ready: { type: 'bool', instructions: 'Ready?', criteria: { true: 'Readable', false: 'Loading' } },
  kind: { type: 'choice', instructions: 'Kind?', criteria: { content: 'Article', shell: 'Loading' } },
} };
const usage: Usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function result(): ClassifierResult {
  return { api: 'typesafe-system-one', provider: 'typesafe', model: 'jev-latest', timestamp: 0, stopReason: 'stop', usage,
    answers: { ready: { type: 'bool', probability: 0.97 }, kind: { type: 'choice', choice: 'content', confidence: 0.9, probabilities: { content: 0.9, shell: 0.1 } } } };
}
function context(classify: JevContext['modelRegistry']['classify'] = async () => result()): JevContext {
  return { modelRegistry: {
    findOfType: ((...args: string[]) => { assert.deepEqual(args, ['classifier', 'typesafe', 'jev-latest']); return { id: 'jev-latest', provider: 'typesafe' }; }) as JevContext['modelRegistry']['findOfType'],
    classify,
  } };
}

test('uses current native registry, native bool unchanged, explicit no retries and exact usage', async () => {
  const totals = createJevUsageAccumulator();
  const ctx = context(async (model, input, options) => {
    assert.equal(model.id, 'jev-latest');
    assert.equal(input, request);
    assert.equal(options?.maxRetries, 0);
    assert.ok(options?.signal);
    assert.equal('onPayload' in options!, false);
    return result();
  });
  const response = await createJevClassifier(ctx, totals.add).evaluate(request);
  assert.deepEqual(response.answers.ready, { type: 'bool', probability: 0.97 });
  assert.deepEqual(totals.usage, usage);
  await createJevClassifier(ctx, totals.add).evaluate(request);
  assert.equal(totals.usage?.totalTokens, 30);
  assert.equal(totals.usage?.cost.total, 0);
  assert.equal(usage.totalTokens, 15);
});

test('each classifier binds its own context rather than a global session', async () => {
  const first = createJevClassifier(context());
  const second = createJevClassifier(context(async () => ({ ...result(), answers: { ...result().answers, ready: { type: 'bool', probability: 0.2 } } })));
  assert.equal((await first.evaluate(request)).answers.ready.type, 'bool');
  assert.deepEqual((await second.evaluate(request)).answers.ready, { type: 'bool', probability: 0.2 });
  assert.deepEqual((await first.evaluate(request)).answers.ready, { type: 'bool', probability: 0.97 });
});

for (const reason of ['error', 'aborted'] as const) test(`rejects native ${reason}, keeping reported usage`, async () => {
  const totals = createJevUsageAccumulator();
  const jev = createJevClassifier(context(async () => ({ ...result(), stopReason: reason, errorMessage: 'provider failure' })), totals.add);
  await assert.rejects(jev.evaluate(request), reason === 'error' ? /provider failure/ : /aborted/);
  assert.deepEqual(totals.usage, usage);
});

test('missing model and missing authentication fail safely without own credential access', async () => {
  const ctx = context(async () => { throw new Error('must not call'); });
  ctx.modelRegistry.findOfType = () => undefined;
  await assert.rejects(createJevClassifier(ctx).evaluate(request), /unavailable/);
  const unauthenticated = context(async () => ({ ...result(), stopReason: 'error', errorMessage: 'No credentials for typesafe' }));
  await assert.rejects(createJevClassifier(unauthenticated).evaluate(request), /No credentials/);
});

test('usage is optional, not fabricated', async () => {
  const totals = createJevUsageAccumulator();
  const response = await createJevClassifier(context(async () => ({ ...result(), usage: undefined })), totals.add).evaluate(request);
  assert.equal(response.usage, undefined);
  assert.equal(totals.usage, undefined);
});

const malformed: [string, (r: ClassifierResult) => void][] = [
  ['missing answer', r => { delete r.answers.ready; }],
  ['wrong type', r => { r.answers.ready = r.answers.kind; }],
  ['illegal choice', r => { (r.answers.kind as any).choice = 'other'; }],
  ['prototype choice', r => { (r.answers.kind as any).choice = 'toString'; }],
  ['missing probabilities', r => { delete (r.answers.kind as any).probabilities; }],
  ['missing chosen probability', r => { (r.answers.kind as any).probabilities = {}; }],
  ['unknown probability label', r => { (r.answers.kind as any).probabilities.other = 0.2; }],
  ...[NaN, Infinity, -0.1, 1.1].flatMap(value => [
    [`bool ${value}`, (r: ClassifierResult) => { (r.answers.ready as any).probability = value; }],
    [`confidence ${value}`, (r: ClassifierResult) => { (r.answers.kind as any).confidence = value; }],
    [`probability ${value}`, (r: ClassifierResult) => { (r.answers.kind as any).probabilities.content = value; }],
  ] as [string, (r: ClassifierResult) => void][]),
];
for (const [name, mutate] of malformed) test(`rejects ${name}`, async () => {
  const invalid = result(); mutate(invalid);
  await assert.rejects(createJevClassifier(context(async () => invalid)).evaluate(request), /Jev/);
});

test('pre-aborted context never calls runtime', async () => {
  const ctx = context(async () => { throw new Error('should not call'); });
  ctx.signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(createJevClassifier(ctx).evaluate(request), /cancelled/);
});

test('propagates cancellation while runtime is pending', async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const jev = createJevClassifier(context(async (_m, _r, options) => { received = options?.signal; return new Promise(() => {}); }));
  const pending = jev.evaluate(request, { signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(received?.aborted, true);
});

test('deadline bounds even a runtime that ignores abort; no hidden retries', async () => {
  let calls = 0;
  let received: AbortSignal | undefined;
  const jev = createJevClassifier(context(async (_m, _r, options) => { calls++; received = options?.signal; return new Promise(() => {}); }));
  await assert.rejects(jev.evaluate(request, { timeoutMs: 10 }), /timed out/);
  assert.equal(received?.aborted, true);
  assert.equal(calls, 1);
});

test('native thrown failures propagate and usage costs/splits sum without estimation', async () => {
  await assert.rejects(createJevClassifier(context(async () => { throw new Error('network down'); })).evaluate(request), /network down/);
  const totals = createJevUsageAccumulator();
  const paid = { ...usage, reasoning: 2, cacheWrite1h: 1, cost: { ...usage.cost, input: 0.01, total: 0.01 } };
  totals.add(paid); totals.add(paid);
  assert.equal(totals.usage?.cost.total, 0.02);
  assert.equal(totals.usage?.reasoning, 4);
  assert.equal(totals.usage?.cacheWrite1h, 2);
});
