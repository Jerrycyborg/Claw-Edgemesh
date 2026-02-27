import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane } from "./control-plane.js";

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
  assert.equal(res.statusCode, 200);
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
  taskId: string
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
    payload: { taskId, kind: "echo", payload: {}, requiredTags: ["linux"] },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("POST /v1/tasks/:taskId/cancel cancels a queued task", async () => {
  const app = buildControlPlane();
  await enqueueTask(app, "cancel-queued-1");

  const res = await app.inject({
    method: "POST",
    url: "/v1/tasks/cancel-queued-1/cancel",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);

  const taskRes = await app.inject({ method: "GET", url: "/v1/tasks/cancel-queued-1" });
  assert.equal(taskRes.json().task.status, "cancelled");

  await app.close();
});

test("cancelled task is not claimable", async () => {
  const app = buildControlPlane();
  const nodeToken = await bootstrapNode(app, "cancel-node-1");
  await enqueueTask(app, "cancel-queued-2");

  await app.inject({
    method: "POST",
    url: "/v1/tasks/cancel-queued-2/cancel",
    headers: { "x-admin-token": "admin-dev" },
  });

  const claimRes = await app.inject({
    method: "POST",
    url: "/v1/nodes/cancel-node-1/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });
  assert.equal(claimRes.statusCode, 200);
  assert.equal(claimRes.json().task, null);

  await app.close();
});

test("POST /v1/tasks/:taskId/cancel cancels a running task", async () => {
  const app = buildControlPlane();
  const nodeToken = await bootstrapNode(app, "cancel-node-2");
  await enqueueTask(app, "cancel-running-1");

  const claimRes = await app.inject({
    method: "POST",
    url: "/v1/nodes/cancel-node-2/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });
  assert.equal(claimRes.json().task?.taskId, "cancel-running-1");

  // Ack to set status to running
  await app.inject({
    method: "POST",
    url: "/v1/tasks/cancel-running-1/ack",
    headers: { authorization: `Bearer ${nodeToken}` },
  });

  const cancelRes = await app.inject({
    method: "POST",
    url: "/v1/tasks/cancel-running-1/cancel",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(cancelRes.statusCode, 200);

  const taskRes = await app.inject({ method: "GET", url: "/v1/tasks/cancel-running-1" });
  assert.equal(taskRes.json().task.status, "cancelled");

  await app.close();
});

test("POST /v1/tasks/:taskId/cancel returns 409 for a completed task", async () => {
  const app = buildControlPlane();
  const nodeToken = await bootstrapNode(app, "cancel-node-3");
  await enqueueTask(app, "cancel-done-1");

  const claimRes = await app.inject({
    method: "POST",
    url: "/v1/nodes/cancel-node-3/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });
  assert.equal(claimRes.json().task?.taskId, "cancel-done-1");

  await app.inject({
    method: "POST",
    url: "/v1/tasks/cancel-done-1/result",
    headers: { authorization: `Bearer ${nodeToken}` },
    payload: {
      schemaVersion: "1.0",
      taskId: "cancel-done-1",
      nodeId: "cancel-node-3",
      ok: true,
      finishedAt: Date.now(),
    },
  });

  const cancelRes = await app.inject({
    method: "POST",
    url: "/v1/tasks/cancel-done-1/cancel",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(cancelRes.statusCode, 409);
  assert.equal(cancelRes.json().error, "task_already_terminal");

  await app.close();
});

test("POST /v1/tasks/:taskId/cancel returns 404 for unknown task", async () => {
  const app = buildControlPlane();

  const res = await app.inject({
    method: "POST",
    url: "/v1/tasks/no-such-task/cancel",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "task_not_found");

  await app.close();
});

test("POST /v1/tasks/:taskId/cancel returns 401 without admin token", async () => {
  const app = buildControlPlane();
  await enqueueTask(app, "cancel-unauth-1");

  const res = await app.inject({
    method: "POST",
    url: "/v1/tasks/cancel-unauth-1/cancel",
  });
  assert.equal(res.statusCode, 401);

  await app.close();
});

test("GET /v1/tasks?status=cancelled lists cancelled tasks", async () => {
  const app = buildControlPlane();
  await enqueueTask(app, "cancel-list-1");
  await enqueueTask(app, "cancel-list-2");

  await app.inject({
    method: "POST",
    url: "/v1/tasks/cancel-list-1/cancel",
    headers: { "x-admin-token": "admin-dev" },
  });

  const res = await app.inject({ method: "GET", url: "/v1/tasks?status=cancelled" });
  assert.equal(res.statusCode, 200);
  const tasks = res.json().tasks as { taskId: string }[];
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, "cancel-list-1");

  await app.close();
});
