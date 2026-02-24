import test from "node:test";
import assert from "node:assert/strict";
import { executeRealTask } from "./node-agent/executor.js";
import { runOrchestratorFlow } from "./orchestrator/flow.js";
import type { Task } from "./contracts.js";

function task(overrides: Partial<Task>): Task {
  return {
    schemaVersion: "1.0",
    taskId: "t-1",
    kind: "shell",
    payload: {},
    status: "queued",
    createdAt: Date.now(),
    ...overrides,
  };
}

test("executor shell captures stdout/stderr with bounded timeout", async () => {
  const result = await executeRealTask(
    task({
      kind: "shell",
      payload: { command: "node", args: ["-e", "console.log('ok'); console.error('warn')"], timeoutMs: 2000 },
    })
  );

  assert.equal(result.ok, true);
  assert.match(String(result.output?.stdout), /ok/);
  assert.match(String(result.output?.stderr), /warn/);
});

test("executor shell times out and returns structured error", async () => {
  const result = await executeRealTask(
    task({
      kind: "shell",
      payload: { command: "node", args: ["-e", "setTimeout(() => {}, 2000)"], timeoutMs: 50 },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "TIMEOUT");
  assert.match(String(result.error), /timeout_exceeded/);
});

test("orchestrator-run enforces mandatory security gate", async () => {
  const blocked = await executeRealTask(
    task({
      kind: "orchestrator-run",
      payload: { flowId: "phase-2b", requireSecurityTests: true, security: { passed: false, findings: 2 } },
    })
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, "SECURITY_GATE_FAILED");

  const allowed = await executeRealTask(
    task({
      kind: "orchestrator-run",
      payload: { flowId: "phase-2b", requireSecurityTests: true, security: { passed: true } },
    })
  );
  assert.equal(allowed.ok, true);
});

test("final reviewer must include critical code+security findings with explicit go/no-go", () => {
  const noGo = runOrchestratorFlow({
    securityPassed: true,
    implementationPassed: true,
    reviewer: { codeCriticalFindings: 1, securityCriticalFindings: 0 },
  });
  assert.equal(noGo.finalReview.decision, "no-go");
  assert.equal(noGo.completed, false);

  const go = runOrchestratorFlow({
    securityPassed: true,
    implementationPassed: true,
    reviewer: { codeCriticalFindings: 0, securityCriticalFindings: 0 },
  });
  assert.equal(go.finalReview.decision, "go");
  assert.equal(go.completed, true);
});
