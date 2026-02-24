import test from "node:test";
import assert from "node:assert/strict";
import { computeRetryDecision } from "./control/retry-policy.js";

test("retry policy increases backoff and routes to DLQ on exhaustion", () => {
  const first = computeRetryDecision({
    attempt: 1,
    maxAttempts: 3,
    baseDelayMs: 100,
    jitterRatio: 0,
  });
  const second = computeRetryDecision({
    attempt: 2,
    maxAttempts: 3,
    baseDelayMs: 100,
    jitterRatio: 0,
  });
  const exhausted = computeRetryDecision({
    attempt: 3,
    maxAttempts: 3,
    baseDelayMs: 100,
    jitterRatio: 0,
  });

  assert.equal(first.retry, true);
  assert.equal(second.retry, true);
  assert.ok(second.delayMs > first.delayMs);

  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.toDlq, true);
});
