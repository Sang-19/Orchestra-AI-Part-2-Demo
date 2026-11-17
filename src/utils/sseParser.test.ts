import test from 'node:test';
import assert from 'node:assert/strict';
import { SseStreamParser } from './sseParser';

test('SseStreamParser handles fragmented chunks split mid-JSON and mid-delimiter', () => {
  const parser = new SseStreamParser();

  const part1 = 'id: 1\nevent: agent_started\ndata: {"seq":1,"mess';
  const part2 = 'age":"Planner running"}\n\nid: 2\n';
  const part3 = 'event: agent_completed\ndata: {"seq":2,"message":"Done"}\n\n';

  const out1 = parser.push(part1);
  assert.equal(out1.length, 0);

  const out2 = parser.push(part2);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].id, '1');
  assert.equal(out2[0].event, 'agent_started');
  assert.deepEqual(JSON.parse(out2[0].data), { seq: 1, message: 'Planner running' });

  const out3 = parser.push(part3);
  assert.equal(out3.length, 1);
  assert.equal(out3[0].id, '2');
  assert.equal(out3[0].event, 'agent_completed');
  assert.deepEqual(JSON.parse(out3[0].data), { seq: 2, message: 'Done' });
});
