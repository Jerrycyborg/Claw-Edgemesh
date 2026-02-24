import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;

type RunOptions = {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
};

type CaptureResult = {
  ok: boolean;
  code: string;
  command: string;
  args: string[];
  timeoutMs: number;
  stdout: string;
  stderr: string;
  error: string;
  exitCode?: number | null;
  signal?: string | null;
};

type NodeRef = { nodeId: string };

type JobRef = {
  jobId: string;
  taskType: string;
  payload?: Record<string, unknown>;
};

export async function executeOnNode(node: NodeRef, job: JobRef) {
  const startedAt = new Date().toISOString();

  try {
    let execution: Record<string, unknown>;

    switch (job.taskType) {
      case "shell":
        execution = await runShell(job.payload ?? {});
        break;
      case "orchestrator-run":
        execution = await runOrchestratorWithSecurityGate(job.payload ?? {});
        break;
      case "hook-dispatch":
        execution = await runHookDispatch(job.payload ?? {});
        break;
      default:
        execution = {
          ok: false,
          code: "unsupported_task_type",
          stdout: "",
          stderr: `Unsupported taskType: ${job.taskType}`,
          error: `Unsupported taskType: ${job.taskType}`,
        };
    }

    const ok = Boolean((execution as { ok?: boolean }).ok);

    return {
      nodeId: node.nodeId,
      jobId: job.jobId,
      taskType: job.taskType,
      status: ok ? "completed" : "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      execution,
    };
  } catch (err) {
    return {
      nodeId: node.nodeId,
      jobId: job.jobId,
      taskType: job.taskType,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      execution: {
        ok: false,
        code: "executor_exception",
        stdout: "",
        stderr: "",
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function runWithCapture(
  command: string,
  args: string[] = [],
  options: RunOptions = {}
): Promise<CaptureResult> {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const cwd = options.cwd || process.cwd();

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) },
    });

    return {
      ok: true,
      code: "ok",
      command,
      args,
      timeoutMs,
      stdout: trim(stdout),
      stderr: trim(stderr),
      error: "",
      exitCode: 0,
    };
  } catch (err: any) {
    return {
      ok: false,
      code: classifyExecError(err),
      command,
      args,
      timeoutMs,
      stdout: trim(err?.stdout),
      stderr: trim(err?.stderr),
      error: String(err?.message ?? err),
      exitCode: typeof err?.code === "number" ? err.code : null,
      signal: err?.signal || null,
    };
  }
}

export async function runSecurityGate({
  cwd,
  timeoutMs = 90_000,
}: { cwd?: string; timeoutMs?: number } = {}) {
  return runWithCapture("bash", ["-lc", "npm run aahp:check && npm test && npm run typecheck"], {
    cwd,
    timeoutMs,
  });
}

async function runShell(payload: Record<string, unknown>) {
  if (!payload.command) {
    return {
      ok: false,
      code: "invalid_payload",
      stdout: "",
      stderr: "",
      error: "shell payload requires command",
    };
  }
  return runWithCapture("bash", ["-lc", String(payload.command)], {
    cwd: payload.cwd as string | undefined,
    timeoutMs: payload.timeoutMs as number | undefined,
  });
}

async function runOrchestratorWithSecurityGate(payload: Record<string, unknown>) {
  const cwd = (payload.cwd as string | undefined) || process.cwd();
  const securityGate = await runSecurityGate({
    cwd,
    timeoutMs: payload.securityTimeoutMs as number | undefined,
  });

  if (!securityGate.ok) {
    return {
      ok: false,
      code: "security_gate_failed",
      stdout: "",
      stderr: securityGate.stderr,
      error: "mandatory security gate failed",
      securityGate,
    };
  }

  if (!payload.command) {
    return {
      ok: false,
      code: "invalid_payload",
      stdout: "",
      stderr: "",
      error: "orchestrator-run payload requires command",
      securityGate,
    };
  }

  const run = await runWithCapture("bash", ["-lc", String(payload.command)], {
    cwd,
    timeoutMs: payload.timeoutMs as number | undefined,
  });

  return { ...run, securityGate };
}

async function runHookDispatch(payload: Record<string, unknown>) {
  if (!payload.eventJsonPath) {
    return {
      ok: false,
      code: "invalid_payload",
      stdout: "",
      stderr: "",
      error: "hook-dispatch payload requires eventJsonPath",
    };
  }
  return runWithCapture(
    "node",
    ["src/cli.js", "hook", "--event-file", String(payload.eventJsonPath)],
    {
      cwd: payload.cwd as string | undefined,
      timeoutMs: payload.timeoutMs as number | undefined,
    }
  );
}

function classifyExecError(err: any) {
  if (err?.killed || err?.signal === "SIGTERM") return "timeout";
  if (typeof err?.code === "number") return "nonzero_exit";
  return "exec_error";
}

function trim(v: unknown) {
  if (!v) return "";
  return String(v).slice(0, 8000);
}
