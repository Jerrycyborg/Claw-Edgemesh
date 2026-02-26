import test from "node:test";
import assert from "node:assert/strict";
import { NodeJwtManager } from "./security.js";
import { buildControlPlane } from "./control-plane.js";

// ── NodeJwtManager unit tests ─────────────────────────────────────────────

test("NodeJwtManager: issue + verify round-trip", () => {
  const mgr = new NodeJwtManager("test-secret");
  const { token } = mgr.issue("node-x");
  const result = mgr.verify(token);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.nodeId, "node-x");
});

test("NodeJwtManager: tampered signature is rejected", () => {
  const mgr = new NodeJwtManager("test-secret");
  const { token } = mgr.issue("node-x");
  const parts = token.split(".");
  parts[2] = "invalidsignature";
  const result = mgr.verify(parts.join("."));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "token_signature_invalid");
});

test("NodeJwtManager: tampered payload is rejected", () => {
  const mgr = new NodeJwtManager("test-secret");
  const { token } = mgr.issue("node-x");
  const parts = token.split(".");
  // Replace payload with a different node ID — signature will no longer match
  const fakePay = Buffer.from(
    JSON.stringify({ sub: "evil-node", iat: 0, exp: 9999999999 })
  ).toString("base64url");
  parts[1] = fakePay;
  const result = mgr.verify(parts.join("."));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "token_signature_invalid");
});

test("NodeJwtManager: expired token is rejected", () => {
  // Negative TTL forces exp to a past second so the token is already expired.
  const mgr = new NodeJwtManager("test-secret", -2000);
  const { token } = mgr.issue("node-x");
  const result = mgr.verify(token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "token_expired");
});

test("NodeJwtManager: malformed token (wrong segment count) is rejected", () => {
  const mgr = new NodeJwtManager("test-secret");
  const result = mgr.verify("only.two");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "token_malformed");
});

test("NodeJwtManager: wrong secret rejects token", () => {
  const issuer = new NodeJwtManager("secret-a");
  const verifier = new NodeJwtManager("secret-b");
  const { token } = issuer.issue("node-x");
  const result = verifier.verify(token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "token_signature_invalid");
});

// ── HTTP integration tests ─────────────────────────────────────────────────

test("register returns node JWT", async () => {
  const app = buildControlPlane();
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-1",
      capabilities: { tags: ["linux"], maxConcurrentTasks: 1 },
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.token === "string" && body.token.length > 0);
  assert.ok(typeof body.exp === "number" && body.exp > Date.now());

  await app.close();
});

test("heartbeat without JWT returns 401", async () => {
  const app = buildControlPlane();
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-2",
      capabilities: { tags: [], maxConcurrentTasks: 1 },
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/v1/nodes/node-jwt-2/heartbeat",
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-2",
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });
  assert.equal(res.statusCode, 401);

  await app.close();
});

test("heartbeat with wrong-node JWT returns 403", async () => {
  const app = buildControlPlane();
  await app.ready();

  // Register two nodes
  const r1 = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-3a",
      capabilities: { tags: [], maxConcurrentTasks: 1 },
    },
  });
  assert.equal(r1.statusCode, 200);
  const tokenA = r1.json().token as string;

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-3b",
      capabilities: { tags: [], maxConcurrentTasks: 1 },
    },
  });

  // Use node-jwt-3a's token on node-jwt-3b's endpoint
  const res = await app.inject({
    method: "POST",
    url: "/v1/nodes/node-jwt-3b/heartbeat",
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-3b",
      ts: Date.now(),
      status: "healthy",
      load: 0,
      runningTasks: 0,
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "token_node_mismatch");

  await app.close();
});

test("claim without JWT returns 401", async () => {
  const app = buildControlPlane();
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-4",
      capabilities: { tags: [], maxConcurrentTasks: 1 },
    },
  });

  const res = await app.inject({ method: "POST", url: "/v1/nodes/node-jwt-4/tasks/claim" });
  assert.equal(res.statusCode, 401);

  await app.close();
});

test("refresh-token returns new JWT", async () => {
  const app = buildControlPlane();
  await app.ready();

  const reg = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-5",
      capabilities: { tags: [], maxConcurrentTasks: 1 },
    },
  });
  assert.equal(reg.statusCode, 200);
  const oldToken = reg.json().token as string;

  const refresh = await app.inject({
    method: "POST",
    url: "/v1/nodes/refresh-token",
    headers: { authorization: `Bearer ${oldToken}` },
  });
  assert.equal(refresh.statusCode, 200);
  const body = refresh.json();
  assert.ok(typeof body.token === "string" && body.token.length > 0);
  assert.ok(typeof body.exp === "number" && body.exp > Date.now());

  await app.close();
});

test("refresh-token for revoked node returns 403", async () => {
  const app = buildControlPlane();
  await app.ready();

  const reg = await app.inject({
    method: "POST",
    url: "/v1/nodes/register",
    headers: { "x-bootstrap-token": "bootstrap-dev" },
    payload: {
      schemaVersion: "1.0",
      nodeId: "node-jwt-6",
      capabilities: { tags: [], maxConcurrentTasks: 1 },
    },
  });
  const token = reg.json().token as string;

  await app.inject({
    method: "POST",
    url: "/v1/nodes/node-jwt-6/revoke",
    headers: { "x-admin-token": "admin-dev" },
  });

  const refresh = await app.inject({
    method: "POST",
    url: "/v1/nodes/refresh-token",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(refresh.statusCode, 403);
  assert.equal(refresh.json().error, "node_revoked");

  await app.close();
});
