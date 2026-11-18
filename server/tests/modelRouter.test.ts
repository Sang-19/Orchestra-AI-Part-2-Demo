import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT_MODEL_ROUTING,
  getModelCandidates,
  isModelFallbackWorthy,
  normalizeModelRouting,
  runWithModelRouting,
} from '../ai/modelRouter';

test('default routing assigns quality-first models to the key agents', () => {
  assert.equal(DEFAULT_AGENT_MODEL_ROUTING.planner, 'gemini-4-hydrogen');
  assert.equal(DEFAULT_AGENT_MODEL_ROUTING.writer, 'gemini-3.8-flash');
  assert.equal(DEFAULT_AGENT_MODEL_ROUTING.summarizer, 'gemini-3.1-flash-lite');
});

test('agent overrides are scoped to the active workflow context', () => {
  const candidates = runWithModelRouting(
    { writer: 'gemini-2.5-flash' },
    () => getModelCandidates('writer')
  );
  assert.equal(candidates[0], 'gemini-2.5-flash');
  assert.ok(candidates.includes('gemini-3.6-flash'));
  assert.equal(getModelCandidates('writer')[0], DEFAULT_AGENT_MODEL_ROUTING.writer);
});

test('model routing ignores unsupported model IDs and preserves safe defaults', () => {
  const routing = normalizeModelRouting({
    planner: 'not-a-real-model',
    writer: 'gemini-2.5-flash',
  });
  assert.equal(routing.planner, DEFAULT_AGENT_MODEL_ROUTING.planner);
  assert.equal(routing.writer, 'gemini-2.5-flash');
});

test('quota and rate-limit errors trigger model fallback', () => {
  assert.equal(isModelFallbackWorthy({ status: 429, message: 'quota exceeded' }), true);
  assert.equal(isModelFallbackWorthy({ status: 503, message: 'temporarily unavailable' }), true);
  assert.equal(isModelFallbackWorthy({ status: 400, message: 'invalid schema' }), false);
});
