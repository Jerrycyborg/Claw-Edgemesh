# OpenClaw EdgeMesh — Architecture (Concise)

## System shape

EdgeMesh has two runtime sides:

1. **Control Plane** (API + scheduler + state)
2. **Edge Node Agent** (heartbeat + claim + execute + result)

## Control plane modules

- **Contracts** (`src/contracts.ts`)
  - typed payloads for nodes, tasks, results
- **Store** (`src/persistence.ts`)
  - node/task/result state
  - freshness derivation: `healthy | degraded | offline`
  - claim lease requeue (TTL)
- **API** (`src/control-plane.ts`)
  - nodes: register/heartbeat/list
  - tasks: enqueue/claim/ack/result/get
  - visibility: queue/running
- **Plugin runtime** (`src/plugins/*`)
  - pluggable hooks + telemetry endpoint

## Execution path

1. Node registers
2. Node heartbeats periodically
3. Tasks are enqueued
4. Node claims eligible task
5. Node acknowledges running
6. Node executes and posts result

## Scheduling contracts (current)

- Claim only when node is `healthy`
- Skip stale/offline nodes
- Enforce `maxConcurrentTasks`
- Honor `targetNodeId` and `requiredTags`

## Reliability posture

- ✅ claim TTL + requeue
- ✅ queue/running visibility endpoints
- ✅ bounded execution timeouts
- ✅ structured stdout/stderr/error capture
- ⚠️ in-memory state only (no durability yet)
- ⚠️ single control-plane instance (no HA)

## Security posture (current)

- Mandatory security gate for `orchestrator-run`
- Explicit final reviewer go/no-go path
- Shell execution path exists; production hardening should keep strict allowlist/sandbox

## Next architecture moves

1. Durable store adapter (Redis/Postgres)
2. Retry/backoff + DLQ
3. Node/task authn-authz (mTLS/JWT)
4. Metrics/tracing + SLO alerting
