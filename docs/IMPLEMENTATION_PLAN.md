# OpenClaw EdgeMesh — Implementation Plan (v1)

## Technical approach

- Build a **control-plane first** MVP with a simple edge node pull loop.
- Keep contracts explicit and versioned (`schemaVersion=1.0`).
- Prioritize end-to-end flow over production hardening in v1.

## Decomposition

1. Contracts (`src/contracts.ts`)
2. Control Plane (`src/control-plane.ts`)
3. Edge Node Agent (`src/edge-node.ts`)
4. Smoke verification (local quick run)
5. v2 hardening backlog (durability, auth, observability)

## Interfaces/contracts

- Register: `POST /v1/nodes/register`
- Heartbeat: `POST /v1/nodes/:nodeId/heartbeat`
- Submit task: `POST /v1/tasks`
- Claim task: `POST /v1/nodes/:nodeId/tasks/claim`
- Ack task: `POST /v1/tasks/:taskId/ack`
- Result: `POST /v1/tasks/:taskId/result`
- Inspect task: `GET /v1/tasks/:taskId`

## Implementation steps

1. Bootstrap TS package and scripts. ✅
2. Implement contracts and API routes. ✅
3. Implement edge node runner and task handlers. ✅
4. Verify quick local flow. ✅ (see `docs/QUICK_RUN_VERIFICATION.md`)
5. Capture findings and open v2 issues. 🔄 ongoing

## Tradeoffs

- In-memory state gives speed but no durability.
- Poll/claim model avoids inbound networking issues but adds poll latency.
- Minimal auth in v1 accelerates delivery but is not production-safe.
