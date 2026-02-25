import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane } from "./control-plane.js";
import { InMemoryControlPlaneStore } from "./persistence.js";

async function issueJobToken(
  app: ReturnType<typeof buildControlPlane>,
  input: { taskId: string; requiredTags?: string[]; targetNodeId?: string }
) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    headers: { "x-admin-token": "admin-dev" },
    payload: {
      jobId: input.taskId,
      requiredTags: input.requiredTags,
      targetNodeId: input.targetNodeId,
      ttlMs: 60_000,
    },
  });
  assert.equal(res.statusCode, 200);
  return res.json().token as string;
}

async function enqueueTask(
  app: ReturnType<typeof buildControlPlane>,
  task: {
    taskId: string;
    kind: string;
    payload: Record<string, unknown>;
    requiredTags?: string[];
    targetNodeId?: string;
  }
) {
  const token = await issueJobToken(app, {
    taskId: task.taskId,
    requiredTags: task.requiredTags,
    targetNodeId: task.targetNodeId,
  });

  return app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${token}` },
    payload: task,
  });
}

test("node lifecycle + task lifecycle", async () => {
  const app = buildControlPlane();
  await app.ready();

  const register = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-a",
      capabilities: { tags: ["linux", "default"], maxConcurrentTasks: 1 },
    },
  });
  assert.equal(register.statusCode, 200);

  const hb = await app.inject({
    method: "POST",
    url: "/v1/nodes/node-a/heartbeat",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-a",
      ts: Date.now(),
      status: "healthy",
      load: 0.1,
      runningTasks: 0,
    },
  });
  assert.equal(hb.statusCode, 200);

  const createTask = await enqueueTask(app, {
    taskId: "task-1",
    kind: "ping",
    payload: { hello: "world" },
    requiredTags: ["linux"],
  });
  assert.equal(createTask.statusCode, 200);

  const claim = await app.inject({ method: "POST", url: "/v1/nodes/node-a/tasks/claim" });
  assert.equal(claim.statusCode, 200);
  const claimBody = claim.json();
  assert.equal(claimBody.ok, true);
  assert.equal(claimBody.task.taskId, "task-1");
  assert.equal(claimBody.task.status, "claimed");

  const ack = await app.inject({ method: "POST", url: "/v1/tasks/task-1/ack" });
  assert.equal(ack.statusCode, 200);

  const result = await app.inject({
    method: "POST",
    url: "/v1/tasks/task-1/result",
    payload: {
      schemaVersion: "1.0",
      taskId: "task-1",
      nodeId: "node-a",
      ok: true,
      output: { pong: true },
      finishedAt: Date.now(),
    },
  });
  assert.equal(result.statusCode, 200);

  const getTask = await app.inject({ method: "GET", url: "/v1/tasks/task-1" });
  assert.equal(getTask.statusCode, 200);
  const taskBody = getTask.json();
  assert.equal(taskBody.task.status, "done");
  assert.equal(taskBody.result.ok, true);

  await app.close();
});

test("task selector respects required tags", async () => {
  const app = buildControlPlane();
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-b",
      capabilities: { tags: ["gpu"], maxConcurrentTasks: 1 },
    },
  });

  await enqueueTask(app, {
    taskId: "task-2",
    kind: "echo",
    payload: { x: 1 },
    requiredTags: ["linux"],
  });

  const claim = await app.inject({ method: "POST", url: "/v1/nodes/node-b/tasks/claim" });
  const body = claim.json();
  assert.equal(body.ok, true);
  assert.equal(body.task, null);

  await app.close();
});

test("expired claims are re-queued", async () => {
  const store = new InMemoryControlPlaneStore({ claimTtlMs: 5 });
  const app = buildControlPlane(store);
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-c",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });

  await app.inject({
    method: "POST",
    url: "/v1/nodes/node-c/heartbeat",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-c",
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });

  await enqueueTask(app, {
    taskId: "task-3",
    kind: "echo",
    payload: { hello: "ttl" },
    requiredTags: ["linux"],
  });

  const firstClaim = await app.inject({ method: "POST", url: "/v1/nodes/node-c/tasks/claim" });
  assert.equal(firstClaim.statusCode, 200);
  assert.equal(firstClaim.json().task.taskId, "task-3");

  await new Promise((r) => setTimeout(r, 12));

  await app.inject({
    method: "POST",
    url: "/v1/nodes/node-c/heartbeat",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-c",
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });

  const secondClaim = await app.inject({ method: "POST", url: "/v1/nodes/node-c/tasks/claim" });
  assert.equal(secondClaim.statusCode, 200);
  const body = secondClaim.json();
  assert.equal(body.task.taskId, "task-3");
  assert.equal(body.task.attempt, 2);

  await app.close();
});

test("freshness state transitions and stale nodes are skipped for claim", async () => {
  const store = new InMemoryControlPlaneStore({ heartbeatHealthyMs: 10, heartbeatDegradedMs: 25 });
  const app = buildControlPlane(store);
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-d",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });

  await enqueueTask(app, {
    taskId: "task-4",
    kind: "echo",
    payload: { p: 1 },
    requiredTags: ["linux"],
  });

  const claimWithoutHeartbeat = await app.inject({
    method: "POST",
    url: "/v1/nodes/node-d/tasks/claim",
  });
  assert.equal(claimWithoutHeartbeat.json().task, null);

  await app.inject({
    method: "POST",
    url: "/v1/nodes/node-d/heartbeat",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-d",
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });

  const claimHealthy = await app.inject({ method: "POST", url: "/v1/nodes/node-d/tasks/claim" });
  assert.equal(claimHealthy.json().task.taskId, "task-4");

  await app.inject({
    method: "POST",
    url: "/v1/tasks/task-4/result",
    payload: {
      schemaVersion: "1.0",
      taskId: "task-4",
      nodeId: "node-d",
      ok: true,
      finishedAt: Date.now(),
    },
  });

  await enqueueTask(app, {
    taskId: "task-5",
    kind: "echo",
    payload: { p: 2 },
    requiredTags: ["linux"],
  });

  await new Promise((r) => setTimeout(r, 14));
  const nodesDegraded = await app.inject({ method: "GET", url: "/v1/nodes" });
  assert.equal(nodesDegraded.json().nodes[0].freshnessState, "degraded");

  const claimDegraded = await app.inject({ method: "POST", url: "/v1/nodes/node-d/tasks/claim" });
  assert.equal(claimDegraded.json().task, null);

  await new Promise((r) => setTimeout(r, 14));
  const nodesOffline = await app.inject({ method: "GET", url: "/v1/nodes" });
  assert.equal(nodesOffline.json().nodes[0].freshnessState, "offline");

  await app.close();
});

test("maxConcurrentTasks and queue/running visibility endpoints", async () => {
  const app = buildControlPlane();
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-e",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });

  await app.inject({
    method: "POST",
    url: "/v1/nodes/node-e/heartbeat",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-e",
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });

  for (const id of ["task-6", "task-7"]) {
    await enqueueTask(app, {
      taskId: id,
      kind: "echo",
      payload: { id },
      requiredTags: ["linux"],
    });
  }

  const claim1 = await app.inject({ method: "POST", url: "/v1/nodes/node-e/tasks/claim" });
  assert.equal(claim1.json().task.taskId, "task-6");

  const claim2 = await app.inject({ method: "POST", url: "/v1/nodes/node-e/tasks/claim" });
  assert.equal(claim2.json().task, null);

  const queued = await app.inject({ method: "GET", url: "/v1/tasks/queue" });
  assert.equal(queued.json().tasks.length, 1);
  assert.equal(queued.json().tasks[0].taskId, "task-7");

  const running = await app.inject({ method: "GET", url: "/v1/tasks/running" });
  assert.equal(running.json().tasks.length, 1);
  assert.equal(running.json().tasks[0].taskId, "task-6");

  await app.close();
});

test("telemetry plugin endpoint exposes counters and events", async () => {
  const app = buildControlPlane();
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-t",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });

  const telem = await app.inject({ method: "GET", url: "/v1/plugins/telemetry" });
  assert.equal(telem.statusCode, 200);

  const body = telem.json();
  assert.equal(body.ok, true);
  assert.equal(body.plugin, "telemetry");
  assert.ok(body.counters["http.requests.total"] >= 1);
  assert.ok(body.counters["event.node.registered"] >= 1);
  assert.ok(Array.isArray(body.events));
  assert.ok(body.events.some((e: { type: string }) => e.type === "node.registered"));

  await app.close();
});

test("tasks list filter and runs summary endpoints", async () => {
  const app = buildControlPlane();
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-z",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 2 },
    },
  });

  await app.inject({
    method: "POST",
    url: "/v1/nodes/node-z/heartbeat",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-z",
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });

  for (const id of ["sum-1", "sum-2"]) {
    await enqueueTask(app, {
      taskId: id,
      kind: "echo",
      payload: { id },
      requiredTags: ["linux"],
    });
  }

  const claim = await app.inject({ method: "POST", url: "/v1/nodes/node-z/tasks/claim" });
  const claimedTaskId = claim.json().task.taskId;
  await app.inject({ method: "POST", url: `/v1/tasks/${claimedTaskId}/ack` });

  const queuedOnly = await app.inject({ method: "GET", url: "/v1/tasks?status=queued" });
  assert.equal(queuedOnly.statusCode, 200);
  assert.equal(queuedOnly.json().tasks.length, 1);

  const summary = await app.inject({ method: "GET", url: "/v1/runs/summary" });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().totals.running, 1);
  assert.equal(summary.json().totals.queued, 1);
  assert.equal(summary.json().metrics.queueDepth, 1);
  assert.equal(summary.json().metrics.successRatio, null);
  assert.ok(
    summary.json().metrics.avgClaimLatencyMs === null ||
      summary.json().metrics.avgClaimLatencyMs >= 0
  );

  await app.close();
});
