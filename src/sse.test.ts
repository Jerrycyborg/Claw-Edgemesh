import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildControlPlane } from "./control-plane.js";

// ── Helpers ────────────────────────────────────────────────────────────────

async function listenOnRandomPort(app: ReturnType<typeof buildControlPlane>): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return (app.server.address() as AddressInfo).port;
}

/** Force-close all connections then shut down the Fastify app. */
async function closeApp(app: ReturnType<typeof buildControlPlane>): Promise<void> {
  // closeAllConnections() is Node 18.2+ — it terminates all keep-alive / SSE sockets
  // so server.close() doesn't hang waiting for them.
  (app.server as http.Server & { closeAllConnections(): void }).closeAllConnections();
  await app.close();
}

/**
 * Opens an SSE connection to `port`, collects data events until `limit` events
 * are received or `timeoutMs` elapses, then destroys the socket.
 * Returns `{ headers, dataLines }`.
 */
function openSse(
  port: number,
  limit = 1,
  timeoutMs = 1000
): Promise<{ headers: http.IncomingHttpHeaders; dataLines: string[] }> {
  return new Promise((resolve, reject) => {
    const dataLines: string[] = [];
    let capturedHeaders: http.IncomingHttpHeaders = {};
    let done = false;

    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        req.destroy();
        resolve({ headers: capturedHeaders, dataLines });
      }
    };

    const req = http.get(`http://127.0.0.1:${port}/v1/events`, (res) => {
      capturedHeaders = res.headers; // capture before any timeout fires

      res.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6).trim());
            if (dataLines.length >= limit) finish();
          }
        }
      });
      res.on("end", finish);
      res.on("error", finish);
    });

    req.on("error", (err) => {
      if (done) return; // expected ECONNRESET after destroy
      reject(err);
    });

    const timer = setTimeout(finish, timeoutMs);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("GET /v1/events returns 200 with text/event-stream content-type", async () => {
  const app = buildControlPlane();
  const port = await listenOnRandomPort(app);

  // Wait until headers arrive (the server writes `: connected\n\n` immediately,
  // so headers are sent right away; we just need the connection to open).
  const { headers } = await openSse(port, 0, 200);

  assert.ok(
    headers["content-type"]?.includes("text/event-stream"),
    `Expected text/event-stream, got: ${headers["content-type"]}`
  );
  assert.equal(headers["cache-control"], "no-cache");

  await closeApp(app);
});

test("GET /v1/events streams node.registered event to subscriber", async () => {
  const app = buildControlPlane();
  const port = await listenOnRandomPort(app);

  // Start collecting — wait for at least 1 data event
  const ssePromise = openSse(port, 1, 1000);

  // Give the SSE connection time to establish
  await new Promise((r) => setTimeout(r, 50));

  // Register a node via inject — this emits node.registered through ctx.emit
  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "sse-node-1",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });

  const { dataLines } = await ssePromise;
  assert.ok(dataLines.length >= 1, "Expected at least one SSE data event");
  const parsed = JSON.parse(dataLines[0]);
  assert.equal(parsed.type, "node.registered");
  assert.equal(parsed.nodeId, "sse-node-1");

  await closeApp(app);
});

test("GET /v1/events streams task.enqueued event to subscriber", async () => {
  const app = buildControlPlane();
  const port = await listenOnRandomPort(app);

  // Register a node first (we need a job token to enqueue)
  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "sse-node-2",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });

  // Open SSE — wait for 1 data event (the task.enqueued one)
  const ssePromise = openSse(port, 1, 1000);
  await new Promise((r) => setTimeout(r, 50));

  // Issue job token + enqueue task
  const jtRes = await app.inject({
    method: "POST",
    url: "/v1/auth/job-token",
    headers: { "x-admin-token": "admin-dev" },
    payload: { jobId: "sse-task-1", requiredTags: ["linux"], ttlMs: 60_000 },
  });
  await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { authorization: `Bearer ${jtRes.json().token as string}` },
    payload: { taskId: "sse-task-1", kind: "echo", payload: {}, requiredTags: ["linux"] },
  });

  const { dataLines } = await ssePromise;
  assert.ok(dataLines.length >= 1, "Expected at least one SSE data event");
  const parsed = JSON.parse(dataLines[0]);
  assert.equal(parsed.type, "task.enqueued");
  assert.equal(parsed.taskId, "sse-task-1");

  await closeApp(app);
});
