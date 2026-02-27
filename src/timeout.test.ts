import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane } from "./control-plane.js";

// Reaper fires every 50ms in these tests so we only need to wait ~200ms.
const REAPER_MS = 50;
const TASK_TIMEOUT_MS = 100;
const WAIT_MS = 300;

// ── Helpers ────────────────────────────────────────────────────────────────

async function bootstrapNode(
  app: ReturnType<typeof buildControlPlane>,
  nodeId: string
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId,
      capabilities: { tags: ["linux"], maxConcurrentTasks: 2 },
    },
  });
  const nodeToken = res.json().token as string;
  await app.inject({
    method: "POST",
    url: `/v1/nodes/${nodeId}/heartbeat`,
    headers: { authorization: `Bearer ${nodeToken}` },
    payload: {
      schemaVersion: "1.0",
      nodeId,
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });
  return nodeToken;
}

async function enqueueTask(
  app: ReturnType<typeof buildControlPlane>,
  taskId: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const jtRes = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    headers: { "x-admin-token": "admin-dev" },
    payload: { jobId: taskId, requiredTags: ["linux"], ttlMs: 60_000 },
  });
  await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${jtRes.json().token as string}` },
    payload: { taskId, kind: "echo", payload: {}, requiredTags: ["linux"], ...extra },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("timed-out claimed task is requeued when attempts remain", async () => {
  const app = buildControlPlane(undefined, { reaperIntervalMs: REAPER_MS });
  const nodeToken = await bootstrapNode(app, "to-node-1");
  await enqueueTask(app, "to-task-1", { timeoutMs: TASK_TIMEOUT_MS });

  const claimRes = await app.inject({
    method: "POST",
    url: "/v1/nodes/to-node-1/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });
  assert.equal(claimRes.json().task?.taskId, "to-task-1");

  // Wait for reaper to detect the timeout and requeue
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const taskRes = await app.inject({ method: "GET", url: "/v1/tasks/to-task-1" });
  assert.equal(taskRes.json().task.status, "queued", "task should be requeued after timeout");

  await app.close();
});

test("timed-out task goes to DLQ when maxAttempts exhausted", async () => {
  const app = buildControlPlane(undefined, { reaperIntervalMs: REAPER_MS });
  const nodeToken = await bootstrapNode(app, "to-node-2");
  await enqueueTask(app, "to-task-2", { timeoutMs: TASK_TIMEOUT_MS, maxAttempts: 1 });

  await app.inject({
    method: "POST",
    url: "/v1/nodes/to-node-2/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });

  await new Promise((r) => setTimeout(r, WAIT_MS));

  const taskRes = await app.inject({ method: "GET", url: "/v1/tasks/to-task-2" });
  assert.equal(taskRes.json().task.status, "failed");

  const dlqRes = await app.inject({ method: "GET", url: "/v1/dlq/to-task-2" });
  assert.equal(dlqRes.statusCode, 200);
  assert.equal(dlqRes.json().entry.reason, "timeout");

  await app.close();
});

test("task without timeoutMs is not affected by reaper", async () => {
  const app = buildControlPlane(undefined, { reaperIntervalMs: REAPER_MS });
  const nodeToken = await bootstrapNode(app, "to-node-3");
  // No timeoutMs — should stay claimed indefinitely
  await enqueueTask(app, "to-task-3");

  await app.inject({
    method: "POST",
    url: "/v1/nodes/to-node-3/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });

  await new Promise((r) => setTimeout(r, WAIT_MS));

  const taskRes = await app.inject({ method: "GET", url: "/v1/tasks/to-task-3" });
  assert.equal(taskRes.json().task.status, "claimed", "task without timeoutMs stays claimed");

  await app.close();
});
