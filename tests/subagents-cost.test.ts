import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { collectSubagents } from '../extensions/subagents-cost.ts';

function collect(rows: { details?: unknown; text?: string; cost?: number; tokens?: number }[]) {
  const branch = rows.map((row, index) => ({ type: 'message', message: {
    role: 'toolResult', toolCallId: `call-${index}`, toolName: 'Agent',
    details: row.details, content: [{ type: 'text', text: row.text ?? '' }],
    usage: { totalTokens: row.tokens ?? 10, cost: { total: row.cost ?? 1 } },
  } }));
  return collectSubagents({ cwd: '/fixture', sessionManager: {
    getBranch: () => branch, getSessionId: () => 'nonexistent-unit-test-session',
  } } as unknown as ExtensionContext);
}

test('subagent cost ignores non-object JSON details and preserves text fallback billing', () => {
  for (const details of [undefined, null, false, true, 0, 42, 'text', [], [{ agentId: 'abc' }]]) {
    const result = collect([{ details, text: 'Agent: abc\nDescription: Fixture\nType: Explore\nTool uses: 3\nDuration: 2s' }]);
    assert.equal(result.totalCny, 7);
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], {
      id: 'abc', spawnIndex: 1, type: 'Explore', model: 'default', description: 'Fixture',
      turnCount: 1, toolUses: 3, tokens: 10, costCny: 7, durationSec: 2, steerCount: 0, status: 'completed',
    });
  }
});

test('subagent cost preserves valid details and aggregation sum/max/steer semantics', () => {
  const result = collect([
    { details: { agentId: 'abc', description: 'Fixture', displayName: 'Explore', modelName: 'provider/model', toolUses: 4, turnCount: 2, durationMs: 1000, status: 'running' }, cost: 0.5, tokens: 20 },
    { details: { agentId: 'abc', toolUses: 2, turnCount: 3, durationFormatted: '2s' }, text: 'Steering message sent to agent abc', cost: 0.25, tokens: 30 },
  ]);
  assert.equal(result.totalCny, 5.25);
  assert.deepEqual(result.items, [{ id: 'abc', spawnIndex: 1, type: 'Explore', model: 'model', description: 'Fixture', turnCount: 3, toolUses: 4, tokens: 50, costCny: 5.25, durationSec: 2, steerCount: 1, status: 'running' }]);
});

test('subagent cost narrows malformed object fields without coercion or dropping usage', () => {
  const result = collect([{ details: { agentId: [], description: 9, subagentType: false, modelName: {}, toolUses: '4', turnCount: {}, durationFormatted: 1, durationMs: '2000', status: [] } }]);
  assert.equal(result.totalCny, 7);
  assert.deepEqual(result.items, [{ id: 'call-0', spawnIndex: 1, type: 'Agent', model: 'default', description: 'Subagent execution', turnCount: 1, toolUses: 0, tokens: 10, costCny: 7, durationSec: 0, steerCount: 0, status: 'completed' }]);
});
