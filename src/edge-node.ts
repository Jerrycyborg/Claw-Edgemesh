import type { HeartbeatRequest, RegisterNodeRequest, Task, TaskResult } from "./contracts.js";
import { executeRealTask } from "./node-agent/executor.js";

const SCHEMA_VERSION = "1.0" as const;
const baseUrl = process.env.EDGEMESH_URL ?? "http://localhost:8787";
const nodeId = process.env.EDGEMESH_NODE_ID ?? `node-${Math.random().toString(36).slice(2, 8)}`;
const bootstrapToken = process.env.EDGEMESH_BOOTSTRAP_TOKEN ?? "bootstrap-dev";
const heartbeatMs = Number(process.env.EDGEMESH_HEARTBEAT_MS ?? 3000);
const pollMs = Number(process.env.EDGEMESH_POLL_MS ?? 1500);

let nodeJwt: string | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

function authHeaders(): Record<string, string> {
  return nodeJwt ? { authorization: `Bearer ${nodeJwt}` } : {};
}

async function registerNode() {
  const body: RegisterNodeRequest = {
    schemaVersion: SCHEMA_VERSION,
    nodeId,
    region: process.env.EDGEMESH_REGION ?? "local",
    capabilities: {
      tags: ["default", "demo"],
      maxConcurrentTasks: 1,
    },
  };

  const res = await httpJson<{ token: string; exp: number }>(`${baseUrl}/v1/nodes/register`, {
    method: "POST",
    headers: { "x-bootstrap-token": bootstrapToken },
    body: JSON.stringify(body),
  });

  nodeJwt = res.token;
  console.log(`[edge-node:${nodeId}] registered`);
}

async function refreshToken() {
  const res = await httpJson<{ token: string; exp: number }>(`${baseUrl}/v1/nodes/refresh-token`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  nodeJwt = res.token;
  console.log(`[edge-node:${nodeId}] token refreshed`);
}

// Re-authenticate: try refresh first; fall back to full re-register.
async function reAuth() {
  try {
    await refreshToken();
  } catch {
    console.warn(`[edge-node:${nodeId}] refresh failed, re-registering`);
    await registerNode();
  }
}

async function sendHeartbeat() {
  const hb: HeartbeatRequest = {
    schemaVersion: SCHEMA_VERSION,
    nodeId,
    ts: Date.now(),
    status: "healthy",
    load: 0,
    runningTasks: 0,
  };

  await httpJson(`${baseUrl}/v1/nodes/${nodeId}/heartbeat`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(hb),
  });
}

async function claimTask(): Promise<Task | null> {
  const claimed = await httpJson<{ ok: boolean; task: Task | null }>(
    `${baseUrl}/v1/nodes/${nodeId}/tasks/claim`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    }
  );
  return claimed.task;
}

async function ackTask(taskId: string) {
  await httpJson(`${baseUrl}/v1/tasks/${taskId}/ack`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
}

async function executeTask(task: Task): Promise<TaskResult> {
  if (task.kind === "echo") {
    return {
      schemaVersion: SCHEMA_VERSION,
      taskId: task.taskId,
      nodeId,
      ok: true,
      output: { echoed: task.payload },
      finishedAt: Date.now(),
    };
  }

  const execution = await executeRealTask(task);
  return {
    schemaVersion: SCHEMA_VERSION,
    taskId: task.taskId,
    nodeId,
    ok: execution.ok,
    output: execution.output,
    error: execution.ok
      ? undefined
      : `${execution.errorCode ?? "EXECUTION_ERROR"}:${execution.error ?? "unknown"}`,
    finishedAt: Date.now(),
  };
}

async function submitResult(result: TaskResult) {
  await httpJson(`${baseUrl}/v1/tasks/${result.taskId}/result`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(result),
  });
}

async function main() {
  await registerNode();

  setInterval(() => {
    sendHeartbeat().catch((err) => {
      if (String(err).includes("HTTP 401")) {
        reAuth().catch((e) => console.error(`[edge-node:${nodeId}] re-auth failed`, e));
      } else {
        console.error(`[edge-node:${nodeId}] heartbeat failed`, err);
      }
    });
  }, heartbeatMs);

  while (true) {
    try {
      const task = await claimTask();
      if (!task) {
        await sleep(pollMs);
        continue;
      }

      await ackTask(task.taskId);
      const result = await executeTask(task);
      await submitResult(result);
      console.log(`[edge-node:${nodeId}] task completed`, task.taskId, result.ok ? "ok" : "failed");
    } catch (err) {
      if (String(err).includes("HTTP 401")) {
        console.warn(`[edge-node:${nodeId}] 401 on task loop, re-authenticating`);
        await reAuth().catch((e) => console.error(`[edge-node:${nodeId}] re-auth failed`, e));
      } else {
        console.error(`[edge-node:${nodeId}] loop error`, err);
      }
      await sleep(pollMs);
    }
  }
}

main().catch((err) => {
  console.error(`[edge-node:${nodeId}] fatal`, err);
  process.exit(1);
});
