# EdgeMesh Phase-2 Roadmap (2 Weeks)

## Goal

Turn the current scaffold into a reliable multi-node execution alpha for real OpenClaw workloads.

## Week 1 — Reliability Core

### Day 1-2: Task lifecycle hardening

- Claim lease timeout + automatic requeue (implemented)
- Attempt counters on tasks (implemented)
- Add endpoints for queue/running visibility

### Day 3-4: Node health + scheduling constraints

- Heartbeat freshness checks (healthy/degraded/offline)
- Scheduler skips stale/offline nodes
- Respect targetNodeId + requiredTags + maxConcurrentTasks

### Day 5: Validation

- Add regression tests for claim expiry, stale heartbeats, and scheduling fairness
- Update QUICK_RUN_VERIFICATION with new checks

## Week 2 — Real Execution Path

### Day 6-7: Job payload contracts

- Introduce typed job kinds (shell, orchestrator-run, hook-dispatch)
- Add signed job token stub + verification hook

### Day 8-9: Node agent executor ✅

- [x] Execute real task kinds safely with bounded timeouts (`shell`, `orchestrator-run`, `hook-dispatch`)
- [x] Capture structured stdout/stderr and normalized error codes
- [x] Enforce mandatory security test gate in orchestrator-run flow
- [x] Add final reviewer stage with explicit code+security GO/NO_GO output

### Day 10: Control-plane observability

- Add /v1/tasks (list/filter), /v1/runs summary endpoints
- Add basic metrics: queue depth, claim latency, success ratio

### Day 11-12: Integration pass

- Wire one real OpenClaw orchestration flow through EdgeMesh
- Validate end-to-end dispatch: enqueue -> claim -> run -> result

### Day 13-14: Stabilization + release candidate

- Soak tests with 2-3 nodes
- Failure drills (node crash, long task, bad payload)
- [x] Phase-2C shell hardening (allowlist, cwd policy, timeout ceiling, denied-command tests)
- Freeze v0.2-alpha checklist

## Exit Criteria (v0.2-alpha)

- Multi-node task dispatch works end-to-end
- Expired claims auto-recover
- Heartbeat-aware scheduling in place
- Tests cover critical failure paths
- One OpenClaw real workflow runs through EdgeMesh successfully
