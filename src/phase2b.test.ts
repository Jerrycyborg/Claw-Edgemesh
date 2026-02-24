import test from "node:test";
import assert from "node:assert/strict";
import { runWithCapture, runSecurityGate, executeOnNode } from "./node-agent/agent.js";
import { reviewExecution } from "./control/reviewer.js";

test("runWithCapture returns structured stdout/stderr", async () => {
  const ok = await runWithCapture("bash", ["-lc", "echo hello && echo warn 1>&2"], {
    timeoutMs: 2000,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, "ok");
  assert.match(ok.stdout, /hello/);
  assert.match(ok.stderr, /warn/);
});

test("runWithCapture enforces timeout", async () => {
  const out = await runWithCapture("bash", ["-lc", "sleep 2"], { timeoutMs: 50 });
  assert.equal(out.ok, false);
  assert.equal(out.code, "timeout");
});

test("orchestrator-run enforces mandatory security gate", async () => {
  const result = await executeOnNode(
    { nodeId: "node-x" },
    {
      jobId: "job-gate-fail",
      taskType: "orchestrator-run",
      payload: {
        cwd: "/tmp",
        command: "echo should-not-run",
        securityTimeoutMs: 5000,
      },
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.execution.code, "security_gate_failed");
  assert.equal(Boolean(result.execution.securityGate), true);
});

test("reviewer emits explicit go/no-go", async () => {
  const go = reviewExecution({ status: "completed", execution: { ok: true } });
  assert.equal(go.goNoGo, "GO");
  assert.equal(go.code, "pass");
  assert.equal(go.security, "pass");

  const noGo = reviewExecution({
    status: "failed",
    execution: { ok: false, securityGate: { ok: false } },
  });
  assert.equal(noGo.goNoGo, "NO_GO");
  assert.equal(noGo.code, "fail");
  assert.equal(noGo.security, "fail");
  assert.ok(noGo.blockers.includes("execution_failed"));
  assert.ok(noGo.blockers.includes("security_gate_failed"));
});

test("runSecurityGate returns structured object", async () => {
  const gate = await runSecurityGate({ cwd: "/tmp", timeoutMs: 2000 });
  assert.equal(typeof gate.ok, "boolean");
  assert.equal(typeof gate.code, "string");
  assert.equal(typeof gate.stdout, "string");
  assert.equal(typeof gate.stderr, "string");
});
