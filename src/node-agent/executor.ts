import type { Task } from "../contracts.js";
import { runWithCapture } from "./agent.js";

export type RealTaskKind = "shell" | "orchestrator-run" | "hook-dispatch";

type ShellPayload = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

type OrchestratorPayload = {
  flowId: string;
  requireSecurityTests?: boolean;
  security?: {
    passed: boolean;
    findings?: number;
    summary?: string;
  };
  timeoutMs?: number;
};

type HookDispatchPayload = {
  hook: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
};

export interface ExecutorResult {
  ok: boolean;
  errorCode?: string;
  error?: string;
  output?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRealTaskKind(kind: string): kind is RealTaskKind {
  return kind === "shell" || kind === "orchestrator-run" || kind === "hook-dispatch";
}

async function executeShell(payload: ShellPayload): Promise<ExecutorResult> {
  if (!payload.command || typeof payload.command !== "string") {
    return { ok: false, errorCode: "INVALID_PAYLOAD", error: "shell.command_required" };
  }

  const result = await runWithCapture(payload.command, payload.args ?? [], {
    cwd: payload.cwd,
    env: payload.env,
    timeoutMs: payload.timeoutMs,
  });

  const output = {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timeoutMs: result.timeoutMs,
  };

  if (result.ok) {
    return { ok: true, output };
  }

  return {
    ok: false,
    errorCode: result.code.toUpperCase(),
    error: result.error,
    output,
  };
}

function executeOrchestratorRun(payload: OrchestratorPayload): ExecutorResult {
  if (!payload.flowId) {
    return { ok: false, errorCode: "INVALID_PAYLOAD", error: "orchestrator.flowId_required" };
  }

  const gateEnabled = payload.requireSecurityTests ?? true;
  if (gateEnabled && !payload.security?.passed) {
    return {
      ok: false,
      errorCode: "SECURITY_GATE_FAILED",
      error: "mandatory_security_tests_not_passed",
      output: {
        flowId: payload.flowId,
        gate: "security-tests",
        findings: payload.security?.findings ?? null,
        summary: payload.security?.summary ?? null,
      },
    };
  }

  return {
    ok: true,
    output: {
      flowId: payload.flowId,
      gate: "security-tests",
      securityPassed: true,
    },
  };
}

function executeHookDispatch(payload: HookDispatchPayload): ExecutorResult {
  if (!payload.hook) {
    return { ok: false, errorCode: "INVALID_PAYLOAD", error: "hook_dispatch.hook_required" };
  }

  return {
    ok: true,
    output: {
      hook: payload.hook,
      delivered: true,
      body: payload.body ?? {},
    },
  };
}

export async function executeRealTask(task: Task): Promise<ExecutorResult> {
  if (!isRealTaskKind(task.kind)) {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_KIND",
      error: `unsupported_task_kind:${task.kind}`,
    };
  }

  const payload = isRecord(task.payload) ? task.payload : {};

  if (task.kind === "shell") {
    return await executeShell(payload as unknown as ShellPayload);
  }

  if (task.kind === "orchestrator-run") {
    return executeOrchestratorRun(payload as unknown as OrchestratorPayload);
  }

  return executeHookDispatch(payload as unknown as HookDispatchPayload);
}
