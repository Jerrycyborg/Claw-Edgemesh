import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane } from "./control-plane.js";

async function registerAndHeartbeat(app: ReturnType<typeof buildControlPlane>, nodeId: string) {
  const reg = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId,
      capabilities: { tags: ["linux"], maxConcurrentTasks: 2 },
    },
  });
  assert.equal(reg.statusCode, 200);
  const token = reg.json().token as string;

  await app.inject({
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
  return token;
}

test("GET /metrics returns 200 with Prometheus text content-type", async () => {
  const app = buildControlPlane();
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers["content-type"]?.includes("text/plain"));

  await app.close();
});

test("GET /metrics contains required metric names", async () => {
  const app = buildControlPlane();
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/metrics" });
  const body = res.body;

  const requiredMetrics = [
    "edgemesh_http_requests_total",
    "edgemesh_tasks_enqueued_total",
    "edgemesh_tasks_claimed_total",
    "edgemesh_tasks_done_total",
    "edgemesh_tasks_failed_total",
    "edgemesh_nodes_registered_total",
    "edgemesh_queue_depth",
    "edgemesh_running_tasks",
    "edgemesh_nodes_healthy",
    "edgemesh_nodes_degraded",
    "edgemesh_nodes_offline",
  ];

  for (const name of requiredMetrics) {
    assert.ok(body.includes(name), `Missing metric: ${name}`);
  }

  await app.close();
});

test("GET /metrics counters increment after activity", async () => {
  const app = buildControlPlane();
  await app.ready();

  await registerAndHeartbeat(app, "metrics-node-1");

  // Issue job token + enqueue a task
  const jobTokenRes = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    headers: { "x-admin-token": "admin-dev" },
    payload: { jobId: "metrics-task-1", requiredTags: ["linux"], ttlMs: 60_000 },
  });
  const jobToken = jobTokenRes.json().token as string;

  await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${jobToken}` },
    payload: { taskId: "metrics-task-1", kind: "echo", payload: {}, requiredTags: ["linux"] },
  });

  const res = await app.inject({ method: "GET", url: "/metrics" });
  const body = res.body;

  // After one register + one enqueue: counters must be >= 1
  const registered = extractMetric(body, "edgemesh_nodes_registered_total");
  const enqueued = extractMetric(body, "edgemesh_tasks_enqueued_total");
  assert.ok(registered >= 1, `nodes_registered_total should be >= 1, got ${registered}`);
  assert.ok(enqueued >= 1, `tasks_enqueued_total should be >= 1, got ${enqueued}`);

  await app.close();
});

test("GET /metrics gauges reflect live state", async () => {
  const app = buildControlPlane();
  await app.ready();

  const token = await registerAndHeartbeat(app, "metrics-node-2");

  // Initially: 0 queued, 0 running, 1 healthy node
  const before = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(extractMetric(before.body, "edgemesh_queue_depth"), 0);
  assert.equal(extractMetric(before.body, "edgemesh_running_tasks"), 0);
  assert.equal(extractMetric(before.body, "edgemesh_nodes_healthy"), 1);

  // Enqueue a task
  const jobTokenRes = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    headers: { "x-admin-token": "admin-dev" },
    payload: { jobId: "metrics-task-2", requiredTags: ["linux"], ttlMs: 60_000 },
  });
  await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${jobToken(jobTokenRes)}` },
    payload: { taskId: "metrics-task-2", kind: "echo", payload: {}, requiredTags: ["linux"] },
  });

  // Queued task should show up
  const after = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(extractMetric(after.body, "edgemesh_queue_depth"), 1);

  // Claim it → running_tasks should become 1
  await app.inject({
    method: "POST",
    url: "/v1/nodes/metrics-node-2/tasks/claim",
    headers: { authorization: `Bearer ${token}` },
  });
  const claimed = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(extractMetric(claimed.body, "edgemesh_queue_depth"), 0);
  assert.equal(extractMetric(claimed.body, "edgemesh_running_tasks"), 1);

  await app.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────

function extractMetric(body: string, name: string): number {
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.startsWith(name + " ") || line.startsWith(name + "{")) {
      const parts = line.split(" ");
      const val = parseFloat(parts[parts.length - 1]);
      return isNaN(val) ? 0 : val;
    }
  }
  return 0;
}

function jobToken(res: { json(): { token: string } }): string {
  return res.json().token;
}
