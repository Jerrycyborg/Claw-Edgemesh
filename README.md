# OpenClaw EdgeMesh

First-level TypeScript control-plane + edge-node starter for distributed task execution.

## What is implemented now

- Versioned contracts (`src/contracts.ts`)
- In-memory control plane (`src/control-plane.ts`, `src/persistence.ts`)
- Edge node polling/execute loop (`src/edge-node.ts`)
- Phase-2 scheduler basics:
  - heartbeat freshness states (`healthy`/`degraded`/`offline`)
  - claim-time filtering for stale/offline nodes
  - `maxConcurrentTasks` enforcement per node
  - queue/running visibility endpoints
- Phase-2B/2C execution + orchestration gates:
  - real executor task kinds (`shell`, `orchestrator-run`, `hook-dispatch`)
  - bounded task timeouts with structured stdout/stderr/error capture
  - shell hardening: command allowlist + working-directory restrictions + timeout ceiling
  - mandatory security gate in orchestrator flow before completion
  - final reviewer function with explicit critical code+security go/no-go decision
- Plugin system + telemetry plugin (`src/plugins/*`)
- Tests (`src/test.ts`, `src/phase2b.test.ts`)

## API surface (current)

- `POST /v1/nodes/register`
- `POST /v1/nodes/:nodeId/heartbeat`
- `GET /v1/nodes`
- `POST /v1/tasks`
- `POST /v1/nodes/:nodeId/tasks/claim`
- `POST /v1/tasks/:taskId/ack`
- `POST /v1/tasks/:taskId/result`
- `GET /v1/tasks/:taskId`
- `GET /v1/tasks/queue`
- `GET /v1/tasks/running`
- `GET /v1/plugins/telemetry`

## Quick validation

```bash
cd /home/barboza/.openclaw/workspace/openclaw-edgemesh
npm run lint
npm run format:check
npm test
npm run build
```

## Developer experience

- ESLint (flat config): `npm run lint`
- Prettier: `npm run format` / `npm run format:check`
- Pre-commit hooks (Husky + lint-staged) run on staged files automatically
- Contribution guide: see `CONTRIBUTING.md`

## Next milestones

1. Durable store adapter (Redis/Postgres)
2. Retries/backoff + DLQ
3. Node authn/authz (mTLS/JWT)
4. Multi-node scheduling strategy and observability
