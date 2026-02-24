# Extending EdgeMesh

This project is intentionally small; extensions are straightforward.

## 1) Add a new task kind

Primary executor path: `src/node-agent/executor.ts`

Steps:

1. Add new kind to `RealTaskKind`.
2. Define payload type + validation.
3. Implement execution function with bounded timeout.
4. Return normalized output (`ok`, `errorCode`, `error`, `output`).
5. Add tests in `src/phase2b.test.ts`.

## 2) Add/replace plugins

Plugin contracts live in:

- `src/plugins/types.ts`

Control-plane wiring:

- `src/control-plane.ts` (default plugin registration)

Steps:

1. Create plugin implementing `EdgeMeshPlugin`.
2. Register route/hooks in `register(app, ctx)`.
3. Emit events via `ctx.emit(...)`.
4. Add tests for endpoint/events.

## 3) Replace in-memory persistence

Current store: `src/persistence.ts` (`InMemoryControlPlaneStore`).

Steps:

1. Implement `ControlPlaneStore` with Redis/Postgres.
2. Preserve API behavior and task state transitions.
3. Keep freshness and claim semantics equivalent.
4. Run full tests and add adapter-specific tests.

## 4) Change scheduling policy

Current claim policy is store-driven and conservative.

When changing:

- keep freshness gating explicit
- preserve `maxConcurrentTasks`
- avoid starvation where possible
- add regression tests for stale nodes and capacity edges

## Safe extension checklist

- [ ] New behavior has tests
- [ ] Build passes (`npm run build`)
- [ ] Runtime checks pass (`npm test`)
- [ ] README/docs updated
