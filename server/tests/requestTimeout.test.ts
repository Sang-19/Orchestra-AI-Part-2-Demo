import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationTimeoutError, withTimeout } from '../ai/requestTimeout';

test('withTimeout returns a result when the operation completes in budget', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 100, 'test operation'), 'ok');
});

test('withTimeout rejects with a typed timeout error when the budget expires', async () => {
  await assert.rejects(
    withTimeout(new Promise<string>(() => {}), 10, 'test operation'),
    (error: unknown) => error instanceof OperationTimeoutError && /test operation/.test(error.message)
  );
});
