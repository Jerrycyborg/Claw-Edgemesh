import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const ALLOWED_COMMANDS = new Set(["bash", "node", "npm", "echo"]);
const ALLOWED_WORKDIRS = [process.cwd(), "/tmp"];

export async function executeOnNode(node, job) {
  const startedAt = new Date().toISOString();

  try {
    let execution;

    switch (job.taskType) {
      case "shell":
        execution = await runShell(job.payload || {});
        break;
      case "orchestrator-run":
        execution = await runOrchestratorWithSecurityGate(job.payload || {});
        break;
      case "hook-dispatch":
        execution = await runHookDispatch(job.payload || {});
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

    return {
      nodeId: node.nodeId,
      jobId: job.jobId,
      taskType: job.taskType,
      status: execution.ok ? "completed" : "failed",
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

export async function runWithCapture(command, args = [], options = {}) {
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
      error: commandCheck.error,
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
      error: cwdCheck.error,
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
  } catch (err) {
    return {
      ok: false,
      code: classifyExecError(err),
      command,
      args,
      timeoutMs,
      stdout: trim(err.stdout),
      stderr: trim(err.stderr),
      error: err.message,
      exitCode: typeof err.code === "number" ? err.code : null,
      signal: err.signal || null,
    };
  }
}

export async function runSecurityGate({ cwd, timeoutMs = 90_000 } = {}) {
  return runWithCapture("bash", ["-lc", "npm run aahp:check && npm test && npm run typecheck"], {
    cwd,
    timeoutMs,
  });
}

async function runShell(payload) {
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
    cwd: payload.cwd,
    timeoutMs: payload.timeoutMs,
  });
}

async function runOrchestratorWithSecurityGate(payload) {
  const cwd = payload.cwd || process.cwd();
  const securityGate = await runSecurityGate({ cwd, timeoutMs: payload.securityTimeoutMs });

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
    timeoutMs: payload.timeoutMs,
  });

  return {
    ...run,
    securityGate,
  };
}

async function runHookDispatch(payload) {
  if (!payload.eventJsonPath) {
    return {
      ok: false,
      code: "invalid_payload",
      stdout: "",
      stderr: "",
      error: "hook-dispatch payload requires eventJsonPath",
    };
  }

  return runWithCapture("node", ["src/cli.js", "hook", "--event-file", payload.eventJsonPath], {
    cwd: payload.cwd,
    timeoutMs: payload.timeoutMs,
  });
}

function classifyExecError(err) {
  if (err?.killed || err?.signal === "SIGTERM") return "timeout";
  if (typeof err?.code === "number") return "nonzero_exit";
  return "exec_error";
}

function trim(v) {
  if (!v) return "";
  return String(v).slice(0, 8000);
}

function boundedTimeoutMs(input) {
  const candidate = Number(input ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(candidate, MAX_TIMEOUT_MS);
}

function validateCommand(command) {
  if (!command || typeof command !== "string") {
    return { ok: false, error: "command_required" };
  }
  if (!ALLOWED_COMMANDS.has(command)) {
    return { ok: false, error: `command_not_allowlisted:${command}` };
  }
  return { ok: true };
}

function validateCwd(inputCwd) {
  const cwd = path.resolve(String(inputCwd || process.cwd()));
  const allowed = ALLOWED_WORKDIRS.some((base) => {
    const normalizedBase = path.resolve(base);
    return cwd === normalizedBase || cwd.startsWith(`${normalizedBase}${path.sep}`);
  });

  if (!allowed) {
    return { ok: false, error: `workdir_not_allowed:${cwd}` };
  }

  return { ok: true, cwd };
}
