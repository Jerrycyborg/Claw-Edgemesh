export type RetryDecision = {
  retry: boolean;
  delayMs: number;
  toDlq: boolean;
};

export function computeRetryDecision(input: {
  attempt: number;
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}): RetryDecision {
  const base = Math.max(1, input.baseDelayMs ?? 250);
  const maxDelay = Math.max(base, input.maxDelayMs ?? 10_000);
  const jitterRatio = Math.max(0, Math.min(0.5, input.jitterRatio ?? 0.1));

  if (input.attempt >= input.maxAttempts) {
    return { retry: false, delayMs: 0, toDlq: true };
  }

  const exp = Math.min(maxDelay, base * 2 ** Math.max(0, input.attempt - 1));
  const jitter = Math.round(exp * jitterRatio);
  const delayMs = exp + jitter;

  return { retry: true, delayMs, toDlq: false };
}
