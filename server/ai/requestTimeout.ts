export class OperationTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded its ${Math.round(timeoutMs / 1000)}s time budget.`);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * Bounds how long a workflow waits for an operation. The underlying SDK call may
 * continue in the background if its transport does not expose cancellation.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
