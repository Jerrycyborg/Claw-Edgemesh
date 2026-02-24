import test from "node:test";
import assert from "node:assert/strict";
import { runWithCapture, runSecurityGate, executeOnNode } from "./node-agent/agent.js";
import { reviewExecution } from "./control/reviewer.js";

test("runWithCapture returns structured stdout/stderr", async () => {
  const ok = await runWithCapture("node", ["-e", "console.log('hello'); console.error('warn')"], {
    timeoutMs: 2000,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, "ok");
  assert.match(ok.stdout, /hello/);
  assert.match(ok.stderr, /warn/);
});

test("runWithCapture enforces timeout", async () => {
  const out = await runWithCapture("node", ["-e", "setTimeout(() => {}, 2000)"], { timeoutMs: 50 });
  assert.equal(out.ok, false);
  assert.equal(out.code, "timeout");
});

test("runWithCapture applies timeout ceiling", async () => {
  const out = await runWithCapture("echo", ["ok"], { timeoutMs: 9999999 });
  assert.equal(out.ok, true);
  assert.equal(out.timeoutMs, 120000);
});

test("runWithCapture denies non-allowlisted command", async () => {
  const denied = await runWithCapture("python3", ["-V"], { timeoutMs: 1000 });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "denied_command");
  assert.match(denied.error, /command_not_allowlisted/);
});

test("runWithCapture denies disallowed working directory", async () => {
  const denied = await runWithCapture("echo", ["ok"], { cwd: "/etc", timeoutMs: 1000 });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "denied_workdir");
  assert.match(denied.error, /workdir_not_allowed/);
});

test("runWithCapture has no shell expansion path", async () => {
  const out = await runWithCapture(
    "node",
    ["-e", "console.log(process.argv[1])", "$(echo injected)"],
    {
      timeoutMs: 2000,
    }
  );
  assert.equal(out.ok, true);
  assert.match(out.stdout, /\$\(echo injected\)/);
  assert.doesNotMatch(out.stdout, /^injected\s*$/m);
});

test("runShell path requires binary/args and does not accept command strings", async () => {
  const result = await executeOnNode(
    { nodeId: "node-shell" },
    {
      jobId: "job-shell-invalid",
      taskType: "shell",
      payload: {
        command: "echo unsafe",
      },
    }
  );

  assert.equal(result.status, "failed");
  assert.equal((result.execution as any).code, "invalid_payload");
});

test("argv execution treats metacharacters as literal arguments", async () => {
  const result = await runWithCapture("echo", ["hello;uname", "$(whoami)"]);
  assert.equal(result.ok, true);
  assert.match(result.stdout, /hello;uname/);
  assert.match(result.stdout, /\$\(whoami\)/);
});

test("orchestrator-run enforces mandatory security gate", async () => {
  const result = await executeOnNode(
    { nodeId: "node-x" },
    {
      jobId: "job-gate-fail",
      taskType: "orchestrator-run",
      payload: {
        cwd: "/tmp",
        binary: "echo",
        args: ["should-not-run"],
        securityTimeoutMs: 5000,
      },
    }
  );

  assert.equal(result.status, "failed");
  assert.equal((result.execution as any).code, "security_gate_failed");
  assert.equal(Boolean((result.execution as any).securityGate), true);
});

test("reviewer emits explicit code+security go/no-go", async () => {
  const go = reviewExecution({ status: "completed", execution: { ok: true } });
  assert.equal(go.goNoGo, "GO");
  assert.equal(go.decision, "go");
  assert.equal(go.code, "pass");
  assert.equal(go.security, "pass");
  assert.equal(go.codeCriticalFindings, 0);
  assert.equal(go.securityCriticalFindings, 0);

  const noGo = reviewExecution({
    status: "failed",
    execution: { ok: false, securityGate: { ok: false } },
  });
  assert.equal(noGo.goNoGo, "NO_GO");
  assert.equal(noGo.decision, "no-go");
  assert.equal(noGo.code, "fail");
  assert.equal(noGo.security, "fail");
  assert.equal(noGo.codeCriticalFindings, 1);
  assert.equal(noGo.securityCriticalFindings, 1);
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
