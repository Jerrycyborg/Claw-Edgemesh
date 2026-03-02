# Next Actions

Priority order: top to bottom. Each task is self-contained -- start without asking questions.

---

## Phase 3: Production Readiness & Scaling (v0.2-alpha → v0.3)

| ID    | Task                                                    | Priority | Status      | Notes                                          |
| ----- | ------------------------------------------------------- | -------- | ----------- | ---------------------------------------------- |
| T-004 | Investigate test flakiness                              | HIGH     | NOT_STARTED | Loop tests fail, single runs pass              |
| T-005 | Complete Redis atomic task claiming (Redlock)           | HIGH     | IN_PROGRESS | Basic impl works; needs Redlock for multi-inst |
| T-006 | Add soak test framework (2-3 nodes, 100+ tasks)         | HIGH     | NOT_STARTED |                                                |
| T-007 | Multi-instance control-plane load balancing tests       | MEDIUM   | NOT_STARTED | Depends on T-005 completion                    |
| T-008 | Add Grafana dashboard templates for /metrics            | MEDIUM   | NOT_STARTED |                                                |
| T-009 | Kubernetes deployment manifests + Helm chart            | MEDIUM   | NOT_STARTED |                                                |
| T-010 | Add comprehensive E2E test suite                        | MEDIUM   | NOT_STARTED |                                                |
| T-011 | Performance benchmarks (task throughput, claim latency) | LOW      | NOT_STARTED |                                                |

---

## Recently Completed

| ID  | Task                                        | Commit  |
| --- | ------------------------------------------- | ------- |
| -   | Production hardening (Issues #1,3,5,6)      | 6f6c171 |
| -   | Node JWT authn (all node endpoints guarded) | ad6c5f6 |
| -   | Redis durable store adapter                 | a6c9798 |
| -   | Dead Letter Queue + replay                  | c25dd27 |
