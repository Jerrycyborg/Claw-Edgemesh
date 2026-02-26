import test from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
// ioredis-mock is CJS; cast to ioredis Redis type so tsc is satisfied
import RedisMockDefault from "ioredis-mock";
const RedisMock = RedisMockDefault as unknown as typeof Redis;
import { RedisControlPlaneStore } from "./persistence/redis-adapter.js";

async function makeStore(options?: { claimTtlMs?: number; heartbeatHealthyMs?: number }) {
  const mock = new RedisMock();
  await mock.flushall(); // ioredis-mock shares state across instances; flush each time
  return new RedisControlPlaneStore(mock, options);
}

const BASE_NODE = {
  schemaVersion: "1.0" as const,
  nodeId: "node-r1",
  capabilities: { tags: ["linux"], maxConcurrentTasks: 2 },
};

const BASE_TASK = {
  schemaVersion: "1.0" as const,
  taskId: "task-r1",
  kind: "echo",
  payload: {},
  status: "queued" as const,
  createdAt: Date.now(),
};

async function registerHealthyNode(store: RedisControlPlaneStore, nodeId = BASE_NODE.nodeId) {
  await store.upsertNode({ ...BASE_NODE, nodeId });
  await store.setNodeTrust(nodeId, { trusted: true, revoked: false });
  await store.setHeartbeat(nodeId, {
    schemaVersion: "1.0",
    nodeId,
    ts: Date.now(),
    status: "healthy",
    load: 0,
    runningTasks: 0,
  });
}

// ── Node operations ───────────────────────────────────────────────────────

test("redis: upsertNode + getNode round-trips correctly", async () => {
  const store = await makeStore();
  await store.upsertNode(BASE_NODE);
  await store.setNodeTrust(BASE_NODE.nodeId, { trusted: true, revoked: false });

  const node = await store.getNode(BASE_NODE.nodeId);
  assert.ok(node);
  assert.equal(node.nodeId, BASE_NODE.nodeId);
  assert.equal(node.trusted, true);
  assert.equal(node.revoked, false);
  assert.deepEqual(node.capabilities.tags, ["linux"]);
});

test("redis: listNodes returns all registered nodes", async () => {
  const store = await makeStore();
  await store.upsertNode({ ...BASE_NODE, nodeId: "node-list-1" });
  await store.upsertNode({ ...BASE_NODE, nodeId: "node-list-2" });

  const nodes = await store.listNodes();
  const ids = nodes.map((n) => n.nodeId).sort();
  assert.ok(ids.includes("node-list-1"));
  assert.ok(ids.includes("node-list-2"));
});

test("redis: setHeartbeat updates freshness state", async () => {
  const store = await makeStore();
  await store.upsertNode(BASE_NODE);
  await store.setNodeTrust(BASE_NODE.nodeId, { trusted: true, revoked: false });

  let node = await store.getNode(BASE_NODE.nodeId);
  assert.equal(node?.freshnessState, "offline"); // no heartbeat yet

  await store.setHeartbeat(BASE_NODE.nodeId, {
    schemaVersion: "1.0",
    nodeId: BASE_NODE.nodeId,
    ts: Date.now(),
    status: "healthy",
    load: 0,
    runningTasks: 0,
  });

  node = await store.getNode(BASE_NODE.nodeId);
  assert.equal(node?.freshnessState, "healthy");
});

test("redis: setNodeTrust revokes a node", async () => {
  const store = await makeStore();
  await store.upsertNode(BASE_NODE);
  await store.setNodeTrust(BASE_NODE.nodeId, { trusted: true, revoked: false });
  await store.setNodeTrust(BASE_NODE.nodeId, { trusted: false, revoked: true });

  const node = await store.getNode(BASE_NODE.nodeId);
  assert.equal(node?.revoked, true);
  assert.equal(node?.trusted, false);
});

// ── Task lifecycle ────────────────────────────────────────────────────────

test("redis: enqueueTask + getTask round-trips correctly", async () => {
  const store = await makeStore();
  await store.enqueueTask(BASE_TASK);

  const task = await store.getTask(BASE_TASK.taskId);
  assert.ok(task);
  assert.equal(task.taskId, BASE_TASK.taskId);
  assert.equal(task.status, "queued");
});

test("redis: claimTask returns eligible task and marks it claimed", async () => {
  const store = await makeStore();
  await registerHealthyNode(store);
  await store.enqueueTask(BASE_TASK);

  const claimed = await store.claimTask(BASE_NODE.nodeId);
  assert.ok(claimed);
  assert.equal(claimed.taskId, BASE_TASK.taskId);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.assignedNodeId, BASE_NODE.nodeId);
  assert.equal(claimed.attempt, 1);
});

test("redis: claimTask returns null for unknown node", async () => {
  const store = await makeStore();
  await store.enqueueTask(BASE_TASK);
  const result = await store.claimTask("ghost-node");
  assert.equal(result, null);
});

test("redis: claimTask returns null for revoked node", async () => {
  const store = await makeStore();
  await registerHealthyNode(store);
  await store.setNodeTrust(BASE_NODE.nodeId, { trusted: false, revoked: true });
  await store.enqueueTask(BASE_TASK);

  const result = await store.claimTask(BASE_NODE.nodeId);
  assert.equal(result, null);
});

test("redis: claimTask respects maxConcurrentTasks", async () => {
  const store = await makeStore();
  await store.upsertNode({
    ...BASE_NODE,
    nodeId: "node-cap",
    capabilities: { tags: [], maxConcurrentTasks: 1 },
  });
  await store.setNodeTrust("node-cap", { trusted: true, revoked: false });
  await store.setHeartbeat("node-cap", {
    schemaVersion: "1.0",
    nodeId: "node-cap",
    ts: Date.now(),
    status: "healthy",
    load: 0,
    runningTasks: 0,
  });

  await store.enqueueTask({ ...BASE_TASK, taskId: "t-cap-1" });
  await store.enqueueTask({ ...BASE_TASK, taskId: "t-cap-2" });

  const first = await store.claimTask("node-cap");
  assert.ok(first);

  const second = await store.claimTask("node-cap");
  assert.equal(second, null); // at capacity
});

test("redis: claimTask skips tasks with pending retryAfter", async () => {
  const store = await makeStore();
  await registerHealthyNode(store);
  await store.enqueueTask({
    ...BASE_TASK,
    taskId: "t-retry-delay",
    retryAfter: Date.now() + 60_000,
  });

  const result = await store.claimTask(BASE_NODE.nodeId);
  assert.equal(result, null);
});

test("redis: setTaskStatus transitions work correctly", async () => {
  const store = await makeStore();
  await store.enqueueTask(BASE_TASK);

  const running = await store.setTaskStatus(BASE_TASK.taskId, "running");
  assert.equal(running?.status, "running");

  const done = await store.setTaskStatus(BASE_TASK.taskId, "done");
  assert.equal(done?.status, "done");
});

test("redis: listTasks filters by status", async () => {
  const store = await makeStore();
  await store.enqueueTask({ ...BASE_TASK, taskId: "t-list-1" });
  await store.enqueueTask({ ...BASE_TASK, taskId: "t-list-2" });
  await store.setTaskStatus("t-list-1", "done");

  const queued = await store.listTasks("queued");
  const done = await store.listTasks("done");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].taskId, "t-list-2");
  assert.equal(done.length, 1);
  assert.equal(done[0].taskId, "t-list-1");
});

test("redis: listQueuedTasks and listRunningTasks", async () => {
  const store = await makeStore();
  await store.enqueueTask({ ...BASE_TASK, taskId: "t-q1" });
  await store.enqueueTask({ ...BASE_TASK, taskId: "t-r1" });
  await store.setTaskStatus("t-r1", "running");

  const queued = await store.listQueuedTasks();
  const running = await store.listRunningTasks();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].taskId, "t-q1");
  assert.equal(running.length, 1);
  assert.equal(running[0].taskId, "t-r1");
});

// ── Results ───────────────────────────────────────────────────────────────

test("redis: setTaskResult + getTaskResult round-trips", async () => {
  const store = await makeStore();
  await store.enqueueTask(BASE_TASK);
  const result = {
    schemaVersion: "1.0" as const,
    taskId: BASE_TASK.taskId,
    nodeId: BASE_NODE.nodeId,
    ok: true,
    output: { stdout: "hello" },
    finishedAt: Date.now(),
  };
  await store.setTaskResult(result);

  const fetched = await store.getTaskResult(BASE_TASK.taskId);
  assert.ok(fetched);
  assert.equal(fetched.ok, true);
  assert.deepEqual(fetched.output, { stdout: "hello" });
});

test("redis: getTaskResult returns undefined for unknown task", async () => {
  const store = await makeStore();
  assert.equal(await store.getTaskResult("no-such-task"), undefined);
});

// ── Retry ─────────────────────────────────────────────────────────────────

test("redis: requeueForRetry puts task back with delay", async () => {
  const store = await makeStore();
  await registerHealthyNode(store);
  await store.enqueueTask(BASE_TASK);
  await store.claimTask(BASE_NODE.nodeId);

  const retryAfter = Date.now() + 60_000;
  const ok = await store.requeueForRetry(BASE_TASK.taskId, retryAfter);
  assert.equal(ok, true);

  const task = await store.getTask(BASE_TASK.taskId);
  assert.equal(task?.status, "queued");
  assert.equal(task?.retryAfter, retryAfter);

  // Cannot claim while retryAfter is in the future
  const result = await store.claimTask(BASE_NODE.nodeId);
  assert.equal(result, null);
});

// ── DLQ ───────────────────────────────────────────────────────────────────

test("redis: enqueueDlq + listDlq + getDlqEntry", async () => {
  const store = await makeStore();
  await store.enqueueTask(BASE_TASK);
  const entry: Parameters<typeof store.enqueueDlq>[0] = {
    schemaVersion: "1.0",
    taskId: BASE_TASK.taskId,
    task: BASE_TASK,
    lastResult: {
      schemaVersion: "1.0",
      taskId: BASE_TASK.taskId,
      nodeId: BASE_NODE.nodeId,
      ok: false,
      error: "boom",
      finishedAt: Date.now(),
    },
    reason: "max_attempts_exhausted",
    enqueuedAt: Date.now(),
  };

  await store.enqueueDlq(entry);

  const list = await store.listDlq();
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, BASE_TASK.taskId);

  const fetched = await store.getDlqEntry(BASE_TASK.taskId);
  assert.ok(fetched);
  assert.equal(fetched.reason, "max_attempts_exhausted");
});

test("redis: requeueFromDlq restores task to queue", async () => {
  const store = await makeStore();
  await registerHealthyNode(store);
  await store.enqueueTask(BASE_TASK);
  await store.setTaskStatus(BASE_TASK.taskId, "failed");

  const entry = {
    schemaVersion: "1.0" as const,
    taskId: BASE_TASK.taskId,
    task: BASE_TASK,
    lastResult: {
      schemaVersion: "1.0" as const,
      taskId: BASE_TASK.taskId,
      nodeId: BASE_NODE.nodeId,
      ok: false as const,
      finishedAt: Date.now(),
    },
    reason: "max_attempts_exhausted",
    enqueuedAt: Date.now(),
  };
  await store.enqueueDlq(entry);

  const ok = await store.requeueFromDlq(BASE_TASK.taskId);
  assert.equal(ok, true);

  // DLQ is now empty
  assert.equal((await store.listDlq()).length, 0);
  assert.equal(await store.getDlqEntry(BASE_TASK.taskId), undefined);

  // Task is back in queue with reset attempt
  const task = await store.getTask(BASE_TASK.taskId);
  assert.equal(task?.status, "queued");
  assert.equal(task?.attempt, 0);

  // Node can claim it again
  const claimed = await store.claimTask(BASE_NODE.nodeId);
  assert.ok(claimed);
  assert.equal(claimed.taskId, BASE_TASK.taskId);
});

test("redis: requeueFromDlq returns false for unknown task", async () => {
  const store = await makeStore();
  assert.equal(await store.requeueFromDlq("no-such-task"), false);
});

// ── Expired claim requeue ─────────────────────────────────────────────────

test("redis: expired claimed task is requeued on next claimTask call", async () => {
  const store = await makeStore({ claimTtlMs: 1 }); // 1 ms TTL
  await registerHealthyNode(store, "node-exp");

  await store.enqueueTask({ ...BASE_TASK, taskId: "t-exp" });
  await store.claimTask("node-exp");

  const claimed = await store.getTask("t-exp");
  assert.equal(claimed?.status, "claimed");

  // Wait for claim TTL to expire
  await new Promise((r) => setTimeout(r, 5));

  // Next claimTask call triggers requeueExpiredClaims internally
  const reclaimed = await store.claimTask("node-exp");
  assert.ok(reclaimed);
  assert.equal(reclaimed.taskId, "t-exp");
  assert.equal(reclaimed.attempt, 2); // second attempt
});
