import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionCycle, mergeCompletedAgentsReducer } from '../orchestrator/graphState';

test('completion reducer unions concurrent branch deltas within a cycle', () => {
  assert.deepEqual(
    mergeCompletedAgentsReducer(['research_coordinator'], ['researcher']),
    ['research_coordinator', 'researcher']
  );
  assert.deepEqual(
    mergeCompletedAgentsReducer(['researcher'], ['researcher']),
    ['researcher']
  );
});

test('new adaptive research cycle starts with no inherited completion indicators', () => {
  const first = createExecutionCycle(1, 'quality_evaluator', 'running', [
    'planner', 'research_coordinator', 'researcher', 'writer'
  ]);
  const retry = createExecutionCycle(first.cycleNumber + 1, 'research_coordinator', 'running');
  assert.equal(retry.cycleNumber, 2);
  assert.deepEqual(retry.completedAgents, []);
  assert.deepEqual(retry.failedAgents, []);
  assert.equal(retry.activeAgent, 'research_coordinator');
});
