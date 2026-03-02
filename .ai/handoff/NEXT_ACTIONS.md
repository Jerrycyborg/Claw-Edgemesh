# Next Actions

Priority order: top to bottom. Each task is self-contained -- start without asking questions.

---

## Phase 3: Production Readiness & Scaling (v0.2-alpha → v0.3)

| ID    | Task                                                    | Priority | Est   |
| ----- | ------------------------------------------------------- | -------- | ----- |
| T-004 | Implement Redis atomic task claiming (Lua script)       | HIGH     | 1 day |
| T-005 | Add soak test framework (2-3 nodes, 100+ tasks)         | HIGH     | 1 day |
| T-006 | Multi-instance control-plane load balancing tests       | MEDIUM   | 1 day |
| T-007 | Add Grafana dashboard templates for /metrics            | MEDIUM   | 1 day |
| T-008 | Kubernetes deployment manifests + Helm chart            | MEDIUM   | 2 day |
| T-009 | Add comprehensive E2E test suite                        | MEDIUM   | 1 day |
| T-010 | Performance benchmarks (task throughput, claim latency) | LOW      | 1 day |

---

## Recently Completed

| ID  | Task                                        | Commit  |
| --- | ------------------------------------------- | ------- |
| -   | Production hardening (Issues #1,3,5,6)      | 6f6c171 |
| -   | Node JWT authn (all node endpoints guarded) | ad6c5f6 |
| -   | Redis durable store adapter                 | a6c9798 |
| -   | Dead Letter Queue + replay                  | c25dd27 |
