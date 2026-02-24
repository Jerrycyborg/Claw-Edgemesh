import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const ALLOWED_COMMANDS = new Set(["node", "npm", "echo", "true", "false"]);
const ALLOWED_WORKDIRS = [process.cwd(), "/tmp"];

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
  timeoutMs: number | null;
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
  const commandCheck = validateCommand(command);
  if (!commandCheck.ok) {
    return {
      ok: false,
      code: "denied_command",
      command,
      args,
      timeoutMs: null,
      stdout: "",
      stderr: "",
      error: String(commandCheck.error),
      exitCode: null,
      signal: null,
    };
  }

  const cwdCheck = validateCwd(options.cwd || process.cwd());
  if (!cwdCheck.ok) {
    return {
      ok: false,
      code: "denied_workdir",
      command,
      args,
      timeoutMs: null,
      stdout: "",
      stderr: "",
      error: String(cwdCheck.error),
      exitCode: null,
      signal: null,
    };
  }

  const timeoutMs = boundedTimeoutMs(options.timeoutMs);

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: cwdCheck.cwd,
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
  const first = await runWithCapture("npm", ["run", "aahp:check"], { cwd, timeoutMs });
  if (!first.ok) return first;

  const second = await runWithCapture("npm", ["test"], { cwd, timeoutMs });
  if (!second.ok) return second;

  return runWithCapture("npm", ["run", "typecheck"], { cwd, timeoutMs });
}

async function runShell(payload: Record<string, unknown>) {
  const binary = typeof payload.binary === "string" ? payload.binary : undefined;
  const args = Array.isArray(payload.args) ? payload.args.map((v) => String(v)) : [];

  if (!binary) {
    return {
      ok: false,
      code: "invalid_payload",
      stdout: "",
      stderr: "",
      error: "shell payload requires binary",
    };
  }

  return runWithCapture(binary, args, {
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

  const binary = typeof payload.binary === "string" ? payload.binary : undefined;
  const args = Array.isArray(payload.args) ? payload.args.map((v) => String(v)) : [];

  if (!binary) {
    return {
      ok: false,
      code: "invalid_payload",
      stdout: "",
      stderr: "",
      error: "orchestrator-run payload requires binary",
      securityGate,
    };
  }

  const run = await runWithCapture(binary, args, {
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

function boundedTimeoutMs(input?: number) {
  const candidate = Number(input ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(candidate, MAX_TIMEOUT_MS);
}

function validateCommand(command: string) {
  if (!command) return { ok: false, error: "command_required" };
  if (!ALLOWED_COMMANDS.has(command)) {
    return { ok: false, error: `command_not_allowlisted:${command}` };
  }
  return { ok: true };
}

function validateCwd(inputCwd: string) {
  const cwd = path.resolve(inputCwd);
  const allowed = ALLOWED_WORKDIRS.some((base) => {
    const normalizedBase = path.resolve(base);
    return cwd === normalizedBase || cwd.startsWith(`${normalizedBase}${path.sep}`);
  });

  if (!allowed) {
    return { ok: false, error: `workdir_not_allowed:${cwd}` };
  }

  return { ok: true, cwd };
}
