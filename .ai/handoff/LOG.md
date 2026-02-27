# Agent Log (last 10 entries, append-only, newest first)

---

## 2026-02-27 -- Session: Task cancellation T-001 (2ae475a)

**Agent:** claude-sonnet-4-6
**Phase:** implementation
**Commits:** 2ae475a

**Work done:**

- Added `"cancelled"` to `Task["status"]` union in `contracts.ts`.
- Added `cancelTask(taskId): Promise<boolean>` to `ControlPlaneStore` interface.
- Implemented in `InMemoryControlPlaneStore`: removes from queue if queued, sets status to cancelled. Returns false if already terminal.
- Implemented in `RedisControlPlaneStore`: same logic, uses `lrem` to remove from queue.
- Added `POST /v1/tasks/:taskId/cancel` route (admin-token required): 404 if not found, 409 if already terminal, emits `task.cancelled`.
- Added `"cancelled"` to GET /v1/tasks querystring schema enum.
- Wrote `src/cancellation.test.ts` (7 tests): queued cancel, not-claimable after cancel, running cancel, 409 for done, 404 unknown, 401 no token, list filter.
- 81/81 tests pass, build clean.

---

## 2026-02-27 -- Session: AAHP setup + SSE milestone

**Agent:** claude-sonnet-4-6
**Phase:** implementation
**Commits:** c2d93e9

**Work done:**

- Pushed all prior commits to GitHub (Jerrycyborg/Claw-Edgemesh, `5eaa3aa`).
- Implemented `GET /v1/events` SSE endpoint:
  - `PassThrough` stream per connection; `ctx.emit` wraps to fan-out to all active subscribers.
  - `req.raw.on("close", cleanup)` removes subscriber and ends stream on disconnect.
  - Headers: `text/event-stream; charset=utf-8`, `cache-control: no-cache`, `x-accel-buffering: no`.
- Wrote `src/sse.test.ts` (3 tests) using a real server (`port: 0`) + Node's `http` module.
  - `closeAllConnections()` before `app.close()` prevents hang on SSE connections.
- 74/74 tests pass, build clean. Committed `c2d93e9`, pushed to GitHub.
- Initialized AAHP v3 handoff protocol for the project.

**Decisions:**

- `PassThrough` stream + `reply.send(stream)` chosen over `reply.hijack()` for Fastify compatibility.
- SSE tests use real TCP server, not inject, because inject does not stream.

---

## 2026-02-27 -- Session: Prometheus metrics + Docker (5eaa3aa)

**Agent:** claude-sonnet-4-6
**Phase:** implementation
**Commits:** 5eaa3aa

**Work done:**

- Added `TelemetryPlugin` type with `snapshot()` method to `plugins/telemetry-plugin.ts`.
- Added `GET /metrics` Prometheus text-format endpoint (counters from telemetry + live gauges from store).
- Created `src/metrics.test.ts` (4 tests).
- Created multi-stage `Dockerfile` (node:22-alpine builder + runtime).
- Created `docker-compose.yml` (control-plane + Redis 7, healthchecks, named volume).
- Created `.dockerignore`.
- 71/71 tests, build clean.

---

## 2026-02-27 -- Session: Task priority scheduling + per-node stats (1fe4f75)

**Agent:** claude-sonnet-4-6
**Phase:** implementation
**Commits:** 1fe4f75

**Work done:**

- Added `priority?: number` to Task in `contracts.ts`.
- Updated `InMemoryControlPlaneStore.claimTask` to sort eligible tasks by priority desc, FIFO tiebreak.
- Updated `RedisControlPlaneStore.claimTask` same way (parallel fetch + sort).
- Added `priority` to POST /v1/tasks schema.
- Added `GET /v1/nodes/:nodeId/stats` endpoint.
- Created `src/scheduling.test.ts` (7 tests).
- Fix: stats test needed `maxAttempts: 1` for terminal failure (default 3 retries).
- 67/67 tests, build clean.

---

## 2026-02-27 -- Session: Node JWT authn (ad6c5f6)

**Agent:** claude-sonnet-4-6
**Phase:** implementation
**Commits:** ad6c5f6

**Work done:**

- Added `NodeJwtManager` to `security.ts` (HS256, Node.js built-in crypto, no external deps).
- Guarded heartbeat, claim, ack, result endpoints with JWT verification.
- Added `POST /v1/nodes/refresh-token` endpoint.
- Updated `edge-node.ts` to store and send JWT; `reAuth()` on 401.
- Updated test helpers (`bootstrapNode` returns JWT).
- Created `src/auth.test.ts` (12 tests).
- Fix: expired token test needs `ttlMs: -2000` (negative) due to second-level JWT precision.
- Fix: error name is `token_node_mismatch` not `node_id_mismatch`.
- 60/60 tests, build clean.
