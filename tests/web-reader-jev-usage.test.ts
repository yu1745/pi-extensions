import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import webReader from '../extensions/web-reader/index.ts';
import { SAMPLE_SCRIPT, DISMISS_CONSENT_SCRIPT } from '../extensions/web-reader/page.ts';
import type { ClassifierContext, Usage } from '@earendil-works/pi-ai';

// No browser, network, credentials or model API: exercise the actual tool result path.
test('web_reader sums native CF/readiness usage per execution, including fallbacks and extraction errors', async () => {
  const originalLaunch = chromium.launch;
  const oldNoXvfb = process.env.PI_WEBREADER_NO_XVFB;
  const oldCf = process.env.PI_WEBREADER_CF;
  process.env.PI_WEBREADER_NO_XVFB = '1';
  delete process.env.PI_WEBREADER_CF;
  let tool: any;
  let shutdown: (() => Promise<void>) | undefined;
  let extractionFails = false;
  const page = {
    async goto() { return { status: () => 200, headers: () => ({ 'cf-mitigated': 'challenge' }) }; },
    async waitForLoadState() {}, async waitForTimeout() {}, async close() {},
    async title() { return 'Article'; }, url() { return 'https://fixture.invalid/article'; },
    async ariaSnapshot() { if (extractionFails) throw new Error('fixture extraction failure'); return '- paragraph: Native classifier fixture'; },
    async evaluate(script: unknown) {
      if (script === DISMISS_CONSENT_SCRIPT) return false;
      if (script === SAMPLE_SCRIPT) return { title: 'Article', text: 'Readable article.', textLength: 3000, contentEvidence: true, pendingContent: false, consentText: '' };
      return { url: page.url(), title: 'Article', text: 'Article', textLength: 3000, hasChallengeFrame: false };
    },
  };
  chromium.launch = (async () => ({ async newContext() { return { async newPage() { return page; } }; }, async close() {} })) as any;
  const usage: Usage = { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
  let failReadiness = false;
  let omitUsage = false;
  let calls = 0;
  const ctx = { modelRegistry: {
    findOfType(...args: string[]) { assert.deepEqual(args, ['classifier', 'typesafe', 'jev-latest']); return { id: 'jev-latest' }; },
    async classify(_model: unknown, request: ClassifierContext, options: any) {
      assert.equal(options.maxRetries, 0); calls++;
      const readiness = !!request.questions.is_ready;
      const choice = (value: string) => ({ type: 'choice', choice: value, confidence: 1, probabilities: { [value]: 1 } });
      return { api: 'typesafe-system-one', provider: 'typesafe', model: 'jev-latest', timestamp: 0,
        stopReason: readiness && failReadiness ? 'error' : 'stop', errorMessage: failReadiness ? 'fixture failure' : undefined,
        usage: omitUsage ? undefined : usage,
        answers: readiness ? { page_kind: choice('content'), is_ready: { type: 'bool', probability: 0.97 } } : { state: choice('content'), action: choice('wait') },
      };
    },
  } };
  try {
    webReader({ on(name: string, handler: any) { if (name === 'session_shutdown') shutdown = handler; }, registerTool(definition: unknown) { tool = definition; } } as any);
    const execute = () => tool.execute('fixture', { url: page.url(), autoSelector: false, extraWaitMs: 0 }, undefined, undefined, ctx);
    const success = await execute();
    assert.equal(calls, 2);
    assert.equal(success.details.pageKind, 'content');
    assert.equal(success.usage.totalTokens, 44);
    assert.equal(success.usage.cost.total, 0.006);
    failReadiness = true;
    const fallback = await execute();
    assert.equal(fallback.details.decisionFallback, true);
    assert.equal(fallback.usage.totalTokens, 44, 'usage is local to each call and includes failed classifiers');
    extractionFails = true;
    const failure = await execute();
    assert.equal(failure.isError, true);
    assert.equal(failure.usage.totalTokens, 44);
    extractionFails = false; failReadiness = false; omitUsage = true;
    assert.equal((await execute()).usage, undefined, 'missing native usage is not fabricated');
  } finally {
    await shutdown?.();
    chromium.launch = originalLaunch;
    if (oldNoXvfb === undefined) delete process.env.PI_WEBREADER_NO_XVFB; else process.env.PI_WEBREADER_NO_XVFB = oldNoXvfb;
    if (oldCf === undefined) delete process.env.PI_WEBREADER_CF; else process.env.PI_WEBREADER_CF = oldCf;
  }
});
