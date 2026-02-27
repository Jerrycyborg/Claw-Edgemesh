# OpenClaw EdgeMesh -- Agent Conventions

## Non-Negotiable Rules

- Do no damage. Human approval required for: git push, destructive ops, schema changes.
- Never push directly to main -- all changes go through the normal commit flow.
- Never add dependencies without documenting the reason in the commit message.
- Never store secrets in source files (use env vars: EDGEMESH_JWT_SECRET, EDGEMESH_ADMIN_SECRET, EDGEMESH_REDIS_URL).
- Never delete existing tests. Only add.
- No em dashes (use -- instead of --). No Unicode fancy quotes.
- All deps must be MIT or similarly permissive -- no paid external services.

## Language and Toolchain

- **Runtime:** Node.js 22, ESM (`"type": "module"` in package.json)
- **Language:** TypeScript strict mode (`tsconfig.json` -- `strict: true`, `exactOptionalPropertyTypes: true`)
- **Formatter:** Prettier (runs via lint-staged on commit)
- **Linter:** ESLint (runs via lint-staged on commit)
- **Test runner:** Node.js built-in `node:test` + `node:assert/strict` -- no Jest/Vitest
- **Test command:** `npm test` (runs `tsx --test src/**/*.test.ts`)
- **Build command:** `npm run build` (runs `tsc -p tsconfig.json`, output to `dist/`)

## Commit Style

```
type(scope): short description

Body optional. Keep subject <= 72 chars.
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Types: feat, fix, refactor, test, docs, chore

## Architecture Invariants

- `ControlPlaneStore` interface is fully async (`Promise<T>` for all methods).
- In-memory store is the default. Redis is opt-in via `EDGEMESH_STORE=redis`.
- All node-facing endpoints require a valid JWT (`Authorization: Bearer <token>`).
- Admin endpoints require `x-admin-token` header matching `EDGEMESH_ADMIN_SECRET`.
- Bootstrap token for node registration: `x-bootstrap-token` header (`EDGEMESH_BOOTSTRAP_TOKEN` env, default `bootstrap-dev`).
- Task priority: higher number = more urgent (0 = default). FIFO tiebreak by `createdAt`.
- JWT uses Node.js built-in `crypto` -- no jwt library.
- `ctx.emit()` is the single fan-out point: telemetry plugin + SSE stream + events array all subscribe to it.

## Key File Map

| File                               | Purpose                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `src/control-plane.ts`             | Fastify app, all HTTP routes                            |
| `src/contracts.ts`                 | Shared TypeScript types (Task, Node, DlqEntry, etc.)    |
| `src/persistence.ts`               | ControlPlaneStore interface + InMemoryControlPlaneStore |
| `src/persistence/redis-adapter.ts` | RedisControlPlaneStore (ioredis)                        |
| `src/security.ts`                  | NodeJwtManager, JobTokenManager, NodeTrustManager       |
| `src/edge-node.ts`                 | Edge node client (registers, heartbeats, claims tasks)  |
| `src/plugins/types.ts`             | EdgeMeshPlugin, EdgeMeshEvent, EdgeMeshPluginContext    |
| `src/plugins/telemetry-plugin.ts`  | TelemetryPlugin with snapshot()                         |
| `src/control/retry-policy.ts`      | computeRetryDecision (exponential backoff)              |

## Testing Patterns

- Use `buildControlPlane()` with default in-memory store for most tests.
- Use `app.inject()` for HTTP calls -- no real server needed except for SSE tests.
- SSE tests use a real server on port 0 (`app.listen({ port: 0 })`) + Node's `http` module.
- Call `app.server.closeAllConnections()` before `app.close()` in SSE tests to avoid hanging.
- For JWT in tests: `bootstrapNode(app, nodeId)` helper returns the JWT string.
- Expired JWT: use `ttlMs: -2000` (negative) -- JWT uses second-level precision.
- Terminal task failure (DLQ): requires `maxAttempts: 1` or all attempts exhausted.
