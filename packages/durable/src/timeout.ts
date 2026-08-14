// Y1 — external call timeout (opt-in). Used by durable-model (step) and durable-tool (execute).

/** Timeout: the throwing side (model step / tool) goes through the existing error paths —
 *  The model claim is marked 'failed', the tool writes 'failed' (H9 recovery ladder applies). */
export class StepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly detail: { label: string; timeoutMs: number },
  ) {
    super(message);
    this.name = 'StepTimeoutError';
  }
}

/** Rejects with StepTimeoutError if `p` doesn't finish within `ms`; the timer is cleared on either path.
 * Accepts PromiseLike — the AI SDK middleware's doGenerate/doStream returns are thenables, not Promises. */
export async function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StepTimeoutError(`@gnldev/durable: '${label}' timed out after ${ms}ms`, { label, timeoutMs: ms })),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
