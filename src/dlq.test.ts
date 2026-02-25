import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane } from "./control-plane.js";

async function bootstrapNode(app: ReturnType<typeof buildControlPlane>, nodeId: string) {
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

  const hb = await app.inject({
    method: "POST",
    url: `/v1/nodes/${nodeId}/heartbeat`,
    payload: {
      schemaVersion: "1.0",
      nodeId,
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });
  assert.equal(hb.statusCode, 200);
}

async function issueToken(app: ReturnType<typeof buildControlPlane>, jobId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    headers: { "x-admin-token": "admin-dev" },
    payload: { jobId, ttlMs: 60_000 },
  });
  assert.equal(res.statusCode, 200);
  return res.json().token as string;
}

test("exhausted task lands in DLQ after max attempts", async () => {
  const app = buildControlPlane();
  await app.ready();

  await bootstrapNode(app, "node-dlq-1");

  const token = await issueToken(app, "task-dlq-1");

  await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      taskId: "task-dlq-1",
      kind: "echo",
      payload: {},
      maxAttempts: 1,
    },
  });

  // Claim → fail (maxAttempts: 1 means no retry)
  await app.inject({ method: "POST", url: "/v1/nodes/node-dlq-1/tasks/claim" });
  await app.inject({ method: "POST", url: "/v1/tasks/task-dlq-1/ack" });

  const result = await app.inject({
    method: "POST",
    url: "/v1/tasks/task-dlq-1/result",
    payload: {
      schemaVersion: "1.0",
      taskId: "task-dlq-1",
      nodeId: "node-dlq-1",
      ok: false,
      error: "something_failed",
      finishedAt: Date.now(),
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().retrying, false);
  assert.equal(result.json().toDlq, true);

  // Task should appear in DLQ list
  const list = await app.inject({ method: "GET", url: "/v1/dlq" });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().entries.length, 1);
  assert.equal(list.json().entries[0].taskId, "task-dlq-1");
  assert.equal(list.json().entries[0].reason, "max_attempts_exhausted");

  // Individual DLQ entry endpoint
  const entry = await app.inject({ method: "GET", url: "/v1/dlq/task-dlq-1" });
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.json().entry.lastResult.error, "something_failed");

  await app.close();
});

test("GET /v1/dlq/:taskId returns 404 for unknown task", async () => {
  const app = buildControlPlane();
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/v1/dlq/no-such-task" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "dlq_entry_not_found");

  await app.close();
});

test("replay requeues task and removes it from DLQ", async () => {
  const app = buildControlPlane();
  await app.ready();

  await bootstrapNode(app, "node-dlq-2");

  const token = await issueToken(app, "task-dlq-2");

  await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      taskId: "task-dlq-2",
      kind: "echo",
      payload: {},
      maxAttempts: 1,
    },
  });

  await app.inject({ method: "POST", url: "/v1/nodes/node-dlq-2/tasks/claim" });
  await app.inject({ method: "POST", url: "/v1/tasks/task-dlq-2/ack" });
  await app.inject({
    method: "POST",
    url: "/v1/tasks/task-dlq-2/result",
    payload: {
      schemaVersion: "1.0",
      taskId: "task-dlq-2",
      nodeId: "node-dlq-2",
      ok: false,
      error: "failed",
      finishedAt: Date.now(),
    },
  });

  // Confirm it's in DLQ
  const before = await app.inject({ method: "GET", url: "/v1/dlq" });
  assert.equal(before.json().entries.length, 1);

  // Replay requires admin token
  const noAuth = await app.inject({
    method: "POST",
    url: "/v1/dlq/task-dlq-2/replay",
  });
  assert.equal(noAuth.statusCode, 401);

  const replay = await app.inject({
    method: "POST",
    url: "/v1/dlq/task-dlq-2/replay",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().taskId, "task-dlq-2");

  // DLQ should be empty now
  const after = await app.inject({ method: "GET", url: "/v1/dlq" });
  assert.equal(after.json().entries.length, 0);

  // Task should be back in queue with reset attempt count
  const task = await app.inject({ method: "GET", url: "/v1/tasks/task-dlq-2" });
  assert.equal(task.json().task.status, "queued");
  assert.equal(task.json().task.attempt, 0);

  await app.close();
});

test("replay returns 404 for task not in DLQ", async () => {
  const app = buildControlPlane();
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/v1/dlq/ghost-task/replay",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "dlq_entry_not_found");

  await app.close();
});
