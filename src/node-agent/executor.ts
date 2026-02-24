import { spawn } from "node:child_process";
import type { Task } from "../contracts.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

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

function boundedTimeout(input?: number): number {
  const candidate = Number(input ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(candidate, MAX_TIMEOUT_MS);
}

function truncateCapture(value: string): string {
  if (Buffer.byteLength(value) <= MAX_CAPTURE_BYTES) return value;
  const buf = Buffer.from(value);
  return `${buf.subarray(0, MAX_CAPTURE_BYTES).toString("utf8")}\n...[truncated]`;
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

  const timeoutMs = boundedTimeout(payload.timeoutMs);

  return await new Promise<ExecutorResult>((resolve) => {
    const child = spawn(payload.command, payload.args ?? [], {
      cwd: payload.cwd,
      env: { ...process.env, ...(payload.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        errorCode: "SPAWN_ERROR",
        error: err.message,
        output: {
          timeoutMs,
          stdout: truncateCapture(stdout),
          stderr: truncateCapture(stderr),
        },
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = {
        timeoutMs,
        stdout: truncateCapture(stdout),
        stderr: truncateCapture(stderr),
        exitCode: code,
        signal,
      };

      if (timedOut) {
        resolve({ ok: false, errorCode: "TIMEOUT", error: `timeout_exceeded:${timeoutMs}`, output });
        return;
      }

      if (code === 0) {
        resolve({ ok: true, output });
        return;
      }

      resolve({ ok: false, errorCode: "NON_ZERO_EXIT", error: `process_exit:${code ?? "null"}`, output });
    });
  });
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
    return { ok: false, errorCode: "UNSUPPORTED_KIND", error: `unsupported_task_kind:${task.kind}` };
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
