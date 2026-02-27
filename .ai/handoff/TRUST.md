# Trust Register

## Verified (tested in CI / confirmed by passing test suite)

| Claim                                              | Evidence                      | TTL       |
| -------------------------------------------------- | ----------------------------- | --------- |
| 74/74 tests pass                                   | `npm test` output, 2026-02-27 | 1 session |
| `npm run build` is clean                           | tsc output, 2026-02-27        | 1 session |
| Node JWT HS256 implementation correct              | auth.test.ts (12 tests)       | stable    |
| Redis adapter functionally equivalent to in-memory | redis.test.ts (16 tests)      | stable    |
| Task priority + FIFO tiebreak works                | scheduling.test.ts (7 tests)  | stable    |
| SSE fan-out delivers events to subscribers         | sse.test.ts (3 tests)         | stable    |
| DLQ captures terminal failures, replay works       | dlq.test.ts (4 tests)         | stable    |
| Prometheus metrics format valid                    | metrics.test.ts (4 tests)     | stable    |

## Assumed (from code review, not integration-tested end-to-end)

| Claim                                                  | Basis                                               | Risk   |
| ------------------------------------------------------ | --------------------------------------------------- | ------ |
| Docker build produces working image                    | Dockerfile reviewed, not run                        | low    |
| docker-compose.yml starts cleanly                      | Reviewed, not run                                   | low    |
| Redis adapter is safe under single-process concurrency | No WATCH/MULTI -- Redlock needed for multi-instance | medium |
| edge-node.ts JWT refresh handles all 401 cases         | Unit tests only, no chaos testing                   | low    |

## Unknown / Not Investigated

| Area                         | Notes                                                           |
| ---------------------------- | --------------------------------------------------------------- |
| Multi-instance SSE fan-out   | sseSubscribers is in-process; needs Redis pub/sub for multi-pod |
| Graceful shutdown under load | app.close() + closeAllConnections() tested in SSE tests only    |
| Redis reconnect behavior     | ioredis has built-in reconnect; not stress-tested               |
