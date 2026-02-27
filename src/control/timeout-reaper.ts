import type { ControlPlaneStore } from "../persistence.js";
import type { DlqEntry, TaskResult } from "../contracts.js";
import type { EdgeMeshPluginContext } from "../plugins/types.js";
import { computeRetryDecision } from "./retry-policy.js";

export function startTimeoutReaper(
  store: ControlPlaneStore,
  ctx: EdgeMeshPluginContext,
  intervalMs = 5_000
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    const now = Date.now();
    const [claimed, running] = await Promise.all([
      store.listTasks("claimed"),
      store.listTasks("running"),
    ]);

    for (const task of [...claimed, ...running]) {
      if (!task.timeoutMs || !task.claimedAt) continue;
      if (now - task.claimedAt <= task.timeoutMs) continue;

      const retry = computeRetryDecision({
        attempt: task.attempt ?? 1,
        maxAttempts: task.maxAttempts ?? 3,
      });

      if (retry.retry) {
        await store.requeueForRetry(task.taskId, now + retry.delayMs);
        ctx.emit({
          type: "task.failed",
          at: now,
          taskId: task.taskId,
          detail: {
            reason: "timeout",
            retrying: true,
            attempt: task.attempt,
            delayMs: retry.delayMs,
          },
        });
      } else {
        const syntheticResult: TaskResult = {
          schemaVersion: "1.0",
          taskId: task.taskId,
          nodeId: task.assignedNodeId ?? "unknown",
          ok: false,
          error: "task_timeout",
          finishedAt: now,
        };
        const dlqEntry: DlqEntry = {
          schemaVersion: "1.0",
          taskId: task.taskId,
          task,
          lastResult: syntheticResult,
          reason: "timeout",
          enqueuedAt: now,
        };
        await store.setTaskStatus(task.taskId, "failed");
        await store.setTaskResult(syntheticResult);
        await store.enqueueDlq(dlqEntry);
        ctx.emit({
          type: "task.failed",
          at: now,
          taskId: task.taskId,
          detail: { reason: "timeout", retrying: false, toDlq: true },
        });
      }
    }
  }, intervalMs);
}
