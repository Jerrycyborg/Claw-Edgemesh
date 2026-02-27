# Next Actions

Priority order: top to bottom. Each task is self-contained -- start without asking questions.

---

## T-001: Add task cancellation endpoint

**Goal:** Admin can cancel a queued task (remove from queue) or a running task (mark cancelled, emit event).

**Context:**
Currently tasks can only terminate by succeeding, failing, or exhausting retries. There is no way to
cancel a task that is stuck in the queue or taking too long. This is the most common missing feature
in production task queues.

**What to do:**

1. Add `"cancelled"` to the `Task["status"]` union in `src/contracts.ts`.
2. Add `cancelTask(taskId: string): Promise<boolean>` to `ControlPlaneStore` interface in `src/persistence.ts`.
3. Implement in `InMemoryControlPlaneStore`:
   - If status is `queued`: remove from `taskQueue`, set status to `cancelled`, return true.
   - If status is `claimed` or `running`: set status to `cancelled`, return true.
   - If status is `done`, `failed`, or `cancelled`: return false (already terminal).
4. Implement in `RedisControlPlaneStore` in `src/persistence/redis-adapter.ts` (same logic, use Redis).
5. Add `POST /v1/tasks/:taskId/cancel` route to `src/control-plane.ts`:
   - Requires `x-admin-token` header.
   - Returns `{ ok: true }` on success, 404 if not found, 409 if already terminal.
   - Emits `{ type: "task.cancelled", at: Date.now(), taskId }` via `ctx.emit`.
6. Update `listTasks` filter options to include `cancelled` status.
7. Write `src/cancellation.test.ts`:
   - Cancel a queued task -- verify status becomes cancelled, not claimable.
   - Cancel a running task -- verify status becomes cancelled.
   - Cancel an already-done task -- expect 409.
   - Cancel unknown task -- expect 404.
   - Verify task.cancelled event appears in SSE.

**Files:**

- `src/contracts.ts` -- add "cancelled" to Task status union
- `src/persistence.ts` -- interface + InMemoryControlPlaneStore
- `src/persistence/redis-adapter.ts` -- RedisControlPlaneStore
- `src/control-plane.ts` -- route
- `src/cancellation.test.ts` -- new test file

**Definition of done:**

- [ ] All new tests pass
- [ ] Existing 74 tests still pass
- [ ] `npm run build` clean
- [ ] `task.cancelled` event visible in SSE stream

---

## T-002: Add task timeout (auto-fail stale claimed/running tasks)

**Goal:** Tasks with a `timeoutMs` field auto-fail if not completed within that window after being claimed.

**Context:**
A node can claim a task and then crash or hang, leaving the task in `claimed` status forever. The
existing heartbeat staleness check handles node-level health but does not automatically requeue or
fail hung tasks. `timeoutMs` on the Task gives operators per-task control.

**What to do:**

1. Add `timeoutMs?: number` and `claimedAt?: number` fields to `Task` in `src/contracts.ts`.
2. In `InMemoryControlPlaneStore.claimTask`: record `claimedAt: Date.now()` when setting status to `claimed`.
3. In `RedisControlPlaneStore.tryClaimTask`: same -- record `claimedAt`.
4. Add a `startTimeoutReaper(store, ctx, intervalMs?)` function in a new file `src/control/timeout-reaper.ts`:
   - Runs on a `setInterval` (default 5000ms).
   - Calls `store.listTasks("claimed")` + `store.listTasks("running")`.
   - For each task where `timeoutMs` is set and `Date.now() - claimedAt > timeoutMs`:
     - Calls `computeRetryDecision` to decide retry vs DLQ (same as result endpoint).
     - Emits `task.failed` with `detail: { reason: "timeout" }`.
   - Returns the interval handle so tests can clear it.
5. Call `startTimeoutReaper(store, ctx)` inside `buildControlPlane` after routes are registered.
6. Expose it in tests via the returned `app` (or pass the interval handle separately for cleanup).
7. Write `src/timeout.test.ts`:
   - Enqueue a task with `timeoutMs: 100`, claim it, wait 200ms -- verify it is re-queued (retry).
   - Same with `maxAttempts: 1` -- verify it goes to DLQ.
   - Tasks without `timeoutMs` are not affected.

**Files:**

- `src/contracts.ts` -- add timeoutMs, claimedAt fields
- `src/persistence.ts` -- record claimedAt on claim
- `src/persistence/redis-adapter.ts` -- same
- `src/control/timeout-reaper.ts` -- new file
- `src/control-plane.ts` -- call startTimeoutReaper
- `src/timeout.test.ts` -- new test file

**Definition of done:**

- [ ] All new tests pass
- [ ] Existing 74 + T-001 tests still pass
- [ ] `npm run build` clean
- [ ] Reaper interval is cleared in test cleanup (no open handles)

---

## Recently Completed

| ID  | Task                                        | Commit  |
| --- | ------------------------------------------- | ------- |
| -   | SSE GET /v1/events streaming                | c2d93e9 |
| -   | Prometheus /metrics + Docker packaging      | 5eaa3aa |
| -   | Task priority queue + per-node stats        | 1fe4f75 |
| -   | Node JWT authn (all node endpoints guarded) | ad6c5f6 |
| -   | Redis durable store adapter                 | a6c9798 |
| -   | Dead Letter Queue + replay                  | c25dd27 |
