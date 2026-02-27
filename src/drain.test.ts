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

test("drained node cannot claim new tasks", async () => {
  const app = buildControlPlane();
  const nodeToken = await bootstrapNode(app, "dn-node-1");
  await enqueueTask(app, "dn-task-1");

  // Drain the node
  const drainRes = await app.inject({
    method: "POST",
    url: "/v1/nodes/dn-node-1/drain",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(drainRes.statusCode, 200);
  assert.equal(drainRes.json().ok, true);

  // Attempt to claim — should return no task
  const claimRes = await app.inject({
    method: "POST",
    url: "/v1/nodes/dn-node-1/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });
  assert.equal(claimRes.statusCode, 200);
  assert.equal(claimRes.json().task, null, "draining node must not claim tasks");

  await app.close();
});

test("NodeView reflects draining state", async () => {
  const app = buildControlPlane();
  await bootstrapNode(app, "dn-node-2");

  // Before drain
  const before = await app.inject({ method: "GET", url: "/v1/nodes" });
  const nodeBefore = before.json().nodes.find((n: { nodeId: string }) => n.nodeId === "dn-node-2");
  assert.equal(nodeBefore.draining, false);

  await app.inject({
    method: "POST",
    url: "/v1/nodes/dn-node-2/drain",
    headers: { "x-admin-token": "admin-dev" },
  });

  // After drain
  const after = await app.inject({ method: "GET", url: "/v1/nodes" });
  const nodeAfter = after.json().nodes.find((n: { nodeId: string }) => n.nodeId === "dn-node-2");
  assert.equal(nodeAfter.draining, true);

  await app.close();
});

test("undrain restores claim eligibility", async () => {
  const app = buildControlPlane();
  const nodeToken = await bootstrapNode(app, "dn-node-3");
  await enqueueTask(app, "dn-task-3");

  await app.inject({
    method: "POST",
    url: "/v1/nodes/dn-node-3/drain",
    headers: { "x-admin-token": "admin-dev" },
  });

  // Confirm drained — no claim
  const claimDrained = await app.inject({
    method: "POST",
    url: "/v1/nodes/dn-node-3/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });
  assert.equal(claimDrained.json().task, null);

  // Undrain
  const undrainRes = await app.inject({
    method: "POST",
    url: "/v1/nodes/dn-node-3/undrain",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(undrainRes.statusCode, 200);

  // Now claim should succeed
  const claimAfter = await app.inject({
    method: "POST",
    url: "/v1/nodes/dn-node-3/tasks/claim",
    headers: { authorization: `Bearer ${nodeToken}` },
  });
  assert.equal(claimAfter.json().task?.taskId, "dn-task-3", "undrained node can claim again");

  await app.close();
});

test("drain unknown node returns 404", async () => {
  const app = buildControlPlane();
  const res = await app.inject({
    method: "POST",
    url: "/v1/nodes/nonexistent/drain",
    headers: { "x-admin-token": "admin-dev" },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "node_not_found");
  await app.close();
});

test("drain without admin token returns 401", async () => {
  const app = buildControlPlane();
  await bootstrapNode(app, "dn-node-5");
  const res = await app.inject({
    method: "POST",
    url: "/v1/nodes/dn-node-5/drain",
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
