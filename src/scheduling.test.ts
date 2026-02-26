import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane } from "./control-plane.js";
import { NodeJwtManager } from "./security.js";

// Short-lived JWT so tests don't depend on global secret
const jwtMgr = new NodeJwtManager("sched-test-secret");

async function registerNode(
  app: ReturnType<typeof buildControlPlane>,
  nodeId: string,
  tags: string[] = ["linux"],
  maxConcurrentTasks = 4
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId,
      capabilities: { tags, maxConcurrentTasks },
    },
  });
  assert.equal(res.statusCode, 200);
  return res.json().token as string;
}

async function heartbeat(app: ReturnType<typeof buildControlPlane>, nodeId: string, token: string) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/nodes/${nodeId}/heartbeat`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      schemaVersion: "1.0",
      nodeId,
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });
  assert.equal(res.statusCode, 200);
}

async function enqueueTask(
  app: ReturnType<typeof buildControlPlane>,
  taskId: string,
  options: { priority?: number; requiredTags?: string[]; maxAttempts?: number } = {}
) {
  const tokenRes = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    headers: { "x-admin-token": "admin-dev" },
    payload: { jobId: taskId, requiredTags: options.requiredTags, ttlMs: 60_000 },
  });
  assert.equal(tokenRes.statusCode, 200);
  const jobToken = tokenRes.json().token as string;

  const res = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${jobToken}` },
    payload: {
      taskId,
      kind: "echo",
      payload: {},
      requiredTags: options.requiredTags ?? ["linux"],
      priority: options.priority,
      maxAttempts: options.maxAttempts,
    },
  });
  assert.equal(res.statusCode, 200);
}

async function claimTask(
  app: ReturnType<typeof buildControlPlane>,
  nodeId: string,
  token: string
): Promise<string | null> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/nodes/${nodeId}/tasks/claim`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().task?.taskId ?? null;
}

// ── Priority scheduling ────────────────────────────────────────────────────

test("higher-priority task is claimed before lower-priority task", async () => {
  const app = buildControlPlane(undefined, { nodeJwtManager: jwtMgr });
  await app.ready();

  const token = await registerNode(app, "sched-node-1");
  await heartbeat(app, "sched-node-1", token);

  // Enqueue low-priority first, then high-priority
  await enqueueTask(app, "low-task", { priority: 1 });
  await enqueueTask(app, "high-task", { priority: 10 });

  const claimed = await claimTask(app, "sched-node-1", token);
  assert.equal(claimed, "high-task");

  await app.close();
});

test("equal-priority tasks are claimed in FIFO order", async () => {
  const app = buildControlPlane(undefined, { nodeJwtManager: jwtMgr });
  await app.ready();

  const token = await registerNode(app, "sched-node-2");
  await heartbeat(app, "sched-node-2", token);

  await enqueueTask(app, "fifo-1", { priority: 5 });
  await enqueueTask(app, "fifo-2", { priority: 5 });
  await enqueueTask(app, "fifo-3", { priority: 5 });

  assert.equal(await claimTask(app, "sched-node-2", token), "fifo-1");
  assert.equal(await claimTask(app, "sched-node-2", token), "fifo-2");
  assert.equal(await claimTask(app, "sched-node-2", token), "fifo-3");

  await app.close();
});

test("zero/unset priority treated as lowest", async () => {
  const app = buildControlPlane(undefined, { nodeJwtManager: jwtMgr });
  await app.ready();

  const token = await registerNode(app, "sched-node-3");
  await heartbeat(app, "sched-node-3", token);

  await enqueueTask(app, "no-prio"); // no priority set
  await enqueueTask(app, "prio-5", { priority: 5 });

  const first = await claimTask(app, "sched-node-3", token);
  assert.equal(first, "prio-5");

  await app.close();
});

test("priority is mixed with tag filtering — highest eligible wins", async () => {
  const app = buildControlPlane(undefined, { nodeJwtManager: jwtMgr });
  await app.ready();

  // Node only has "linux" tag
  const token = await registerNode(app, "sched-node-4", ["linux"]);
  await heartbeat(app, "sched-node-4", token);

  // High priority but requires "gpu" — ineligible for this node
  await enqueueTask(app, "gpu-high", { priority: 99, requiredTags: ["gpu"] });
  // Low priority but requires only "linux" — eligible
  await enqueueTask(app, "linux-low", { priority: 1, requiredTags: ["linux"] });

  const claimed = await claimTask(app, "sched-node-4", token);
  assert.equal(claimed, "linux-low"); // gpu-high skipped

  await app.close();
});

// ── Per-node stats ─────────────────────────────────────────────────────────

test("GET /v1/nodes/:nodeId/stats returns 404 for unknown node", async () => {
  const app = buildControlPlane(undefined, { nodeJwtManager: jwtMgr });
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/v1/nodes/ghost-node/stats" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "node_not_found");

  await app.close();
});

test("GET /v1/nodes/:nodeId/stats tracks completed/failed/running counts", async () => {
  const app = buildControlPlane(undefined, { nodeJwtManager: jwtMgr });
  await app.ready();

  const token = await registerNode(app, "stats-node", ["linux"], 4);
  await heartbeat(app, "stats-node", token);

  // Enqueue 3 tasks (stat-t2 uses maxAttempts:1 so a failure is terminal, not retried)
  await enqueueTask(app, "stat-t1");
  await enqueueTask(app, "stat-t2", { maxAttempts: 1 });
  await enqueueTask(app, "stat-t3");

  // Claim and complete t1
  await claimTask(app, "stats-node", token);
  await app.inject({
    method: "POST",
    url: "/v1/tasks/stat-t1/ack",
    headers: { authorization: `Bearer ${token}` },
  });
  await app.inject({
    method: "POST",
    url: "/v1/tasks/stat-t1/result",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      schemaVersion: "1.0",
      taskId: "stat-t1",
      nodeId: "stats-node",
      ok: true,
      finishedAt: Date.now(),
    },
  });

  // Claim and fail t2
  await claimTask(app, "stats-node", token);
  await app.inject({
    method: "POST",
    url: "/v1/tasks/stat-t2/ack",
    headers: { authorization: `Bearer ${token}` },
  });
  await app.inject({
    method: "POST",
    url: "/v1/tasks/stat-t2/result",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      schemaVersion: "1.0",
      taskId: "stat-t2",
      nodeId: "stats-node",
      ok: false,
      error: "oops",
      finishedAt: Date.now(),
    },
  });

  // Claim t3 (leave it running, don't ack)
  await claimTask(app, "stats-node", token);

  const stats = await app.inject({ method: "GET", url: "/v1/nodes/stats-node/stats" });
  assert.equal(stats.statusCode, 200);
  const body = stats.json();
  assert.equal(body.tasksCompleted, 1);
  assert.equal(body.tasksFailed, 1);
  assert.equal(body.tasksRunning, 1);
  assert.equal(body.tasksTotal, 3);
  assert.equal(body.successRatio, 0.5); // 1 done / (1 done + 1 failed)

  await app.close();
});

test("GET /v1/nodes/:nodeId/stats successRatio is null when no terminal tasks", async () => {
  const app = buildControlPlane(undefined, { nodeJwtManager: jwtMgr });
  await app.ready();

  await registerNode(app, "fresh-node");

  const stats = await app.inject({ method: "GET", url: "/v1/nodes/fresh-node/stats" });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.json().successRatio, null);
  assert.equal(stats.json().tasksTotal, 0);

  await app.close();
});
