# OpenClaw EdgeMesh — Architecture (Phase-2 snapshot)

## Control-plane modules

1. **Contracts** (`src/contracts.ts`)
   - typed request/response payloads
   - node freshness + task lifecycle types
2. **Store** (`src/persistence.ts`)
   - in-memory node/task/result state
   - heartbeat freshness evaluation (`healthy`/`degraded`/`offline`)
   - claim lease timeout requeue
3. **API** (`src/control-plane.ts`)
   - node registration + heartbeat ingestion
   - task enqueue/claim/ack/result
   - visibility endpoints for queued/running tasks
4. **Plugin Runtime** (`src/plugins/*`)
   - pluggable control-plane plugin contract
   - built-in telemetry plugin (events + request counters)
   - telemetry endpoint: `GET /v1/plugins/telemetry`
5. **Node Agent / Executor** (`src/node-agent/agent.js`, `src/edge-node.ts`)
   - register + periodic heartbeat
   - task claim + execute handlers + result publish
   - real task executors with bounded timeouts + structured capture
   - mandatory security gate for orchestrator-run tasks
6. **Reviewer** (`src/control/reviewer.js`)
   - explicit `GO` / `NO_GO` decision using code + security outcomes

## Scheduling behavior (current)

- Claims are allowed only when node freshness is `healthy`.
- Nodes with stale heartbeats (`degraded`/`offline`) are skipped.
- Per-node `maxConcurrentTasks` is enforced against claimed/running tasks.
- Expired claims are re-queued via claim TTL.

## Visibility endpoints

- `GET /v1/tasks/queue` → queued tasks
- `GET /v1/tasks/running` → claimed + running tasks
- `GET /v1/nodes` → node list including computed `freshnessState`

## Current tradeoffs

- In-memory state (non-durable)
- Pull-based scheduler (simple NAT model, higher claim latency)
- Single control-plane instance (no HA)

## Next hardening steps

- Durable queue + persistence adapter
- Authn/authz for node and task submitter identity
- Retry/backoff/DLQ policies
- Metrics/tracing and SLO alerting
