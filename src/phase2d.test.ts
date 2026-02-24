import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane } from "./control-plane.js";
import { executeRealTask } from "./node-agent/executor.js";
import { JobTokenManager } from "./security.js";
import type { Task } from "./contracts.js";

async function bootstrapNode(app: ReturnType<typeof buildControlPlane>, nodeId: string) {
  const register = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId,
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });
  assert.equal(register.statusCode, 200);

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

test("signed job token issuance + replay rejection", async () => {
  const app = buildControlPlane();
  await app.ready();

  await bootstrapNode(app, "node-auth");

  const tokenResp = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    payload: { jobId: "task-auth-1", requiredTags: ["linux"], ttlMs: 60_000 },
  });
  assert.equal(tokenResp.statusCode, 200);
  const token = tokenResp.json().token;

  const create1 = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      taskId: "task-auth-1",
      kind: "echo",
      payload: { ok: true },
      requiredTags: ["linux"],
    },
  });
  assert.equal(create1.statusCode, 200);

  const createReplay = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      taskId: "task-auth-1",
      kind: "echo",
      payload: { ok: true },
      requiredTags: ["linux"],
    },
  });
  assert.equal(createReplay.statusCode, 401);
  assert.equal(createReplay.json().error, "token_replay");

  await app.close();
});

test("node trust bootstrap + revocation blocks heartbeat", async () => {
  const app = buildControlPlane();
  await app.ready();

  const denied = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-denied",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });
  assert.equal(denied.statusCode, 401);

  await bootstrapNode(app, "node-revoke");

  const revoke = await app.inject({ method: "POST", url: "/v1/nodes/node-revoke/revoke" });
  assert.equal(revoke.statusCode, 200);

  const hbAfter = await app.inject({
    method: "POST",
    url: "/v1/nodes/node-revoke/heartbeat",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-revoke",
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });
  assert.equal(hbAfter.statusCode, 403);
  assert.equal(hbAfter.json().error, "node_revoked");

  const timeline = await app.inject({
    method: "GET",
    url: "/v1/observability/node-health-timeline",
  });
  assert.equal(timeline.statusCode, 200);
  assert.ok(timeline.json().timeline.some((e: { type: string }) => e.type === "node.revoked"));

  await app.close();
});

test("observability endpoints expose queue depth/latency/success ratio", async () => {
  const app = buildControlPlane();
  await app.ready();

  await bootstrapNode(app, "node-obs");

  const tokenResp = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    payload: { jobId: "task-obs-1", requiredTags: ["linux"] },
  });
  const token = tokenResp.json().token;

  await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      taskId: "task-obs-1",
      kind: "echo",
      payload: {},
      requiredTags: ["linux"],
    },
  });

  const q = await app.inject({ method: "GET", url: "/v1/observability/queue-depth" });
  assert.equal(q.statusCode, 200);
  assert.equal(q.json().queueDepth, 1);

  await app.inject({ method: "POST", url: "/v1/nodes/node-obs/tasks/claim" });
  await app.inject({
    method: "POST",
    url: "/v1/tasks/task-obs-1/result",
    payload: {
      schemaVersion: "1.0",
      taskId: "task-obs-1",
      nodeId: "node-obs",
      ok: true,
      finishedAt: Date.now(),
    },
  });

  const summary = await app.inject({ method: "GET", url: "/v1/runs/summary" });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().metrics.queueDepth, 0);
  assert.equal(summary.json().metrics.successRatio, 1);
  assert.ok(
    summary.json().metrics.avgClaimLatencyMs === null ||
      summary.json().metrics.avgClaimLatencyMs >= 0
  );

  await app.close();
});

test("job token manager prunes replay cache after expiration", async () => {
  const mgr = new JobTokenManager("test-secret");
  const token = mgr.issue({ jobId: "job-ttl", exp: Date.now() + 30 });

  const first = mgr.verify(token, { jobId: "job-ttl" });
  assert.equal(first.ok, true);
  assert.equal(mgr.replayCacheSize(), 1);

  await new Promise((r) => setTimeout(r, 40));

  // Cache entry should be pruned once expired.
  assert.equal(mgr.replayCacheSize(), 0);

  const second = mgr.verify(token, { jobId: "job-ttl" });
  assert.equal(second.ok, false);
  assert.equal(second.error, "token_expired");
});

test("failure drills: invalid payload + timeout + crash", async () => {
  const invalid = await executeRealTask({
    schemaVersion: "1.0",
    taskId: "drill-invalid",
    kind: "shell",
    payload: {},
    status: "queued",
    createdAt: Date.now(),
  } as Task);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errorCode, "INVALID_PAYLOAD");

  const timeout = await executeRealTask({
    schemaVersion: "1.0",
    taskId: "drill-timeout",
    kind: "shell",
    payload: { command: "node", args: ["-e", "setTimeout(() => {}, 2000)"], timeoutMs: 30 },
    status: "queued",
    createdAt: Date.now(),
  } as Task);
  assert.equal(timeout.ok, false);
  assert.equal(timeout.errorCode, "TIMEOUT");

  const crash = await executeRealTask({
    schemaVersion: "1.0",
    taskId: "drill-crash",
    kind: "shell",
    payload: { command: "node", args: ["-e", "process.exit(7)"] },
    status: "queued",
    createdAt: Date.now(),
  } as Task);
  assert.equal(crash.ok, false);
  assert.equal(crash.errorCode, "NON_ZERO_EXIT");
});
