import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const ALLOWED_COMMANDS = new Set(["node", "npm", "echo"]);
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
    return deniedResult("denied_command", command, args, commandCheck.error);
  }

  const cwdCheck = validateCwd(options.cwd || process.cwd());
  if (!cwdCheck.ok) {
    return deniedResult("denied_workdir", command, args, cwdCheck.error);
  }

  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return deniedResult("invalid_args", command, args, "args_must_be_string_array");
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
  const gateTimeout = boundedTimeoutMs(timeoutMs);

  const checks = [["run", "aahp:check"], ["test"], ["run", "typecheck"]];

  for (const stepArgs of checks) {
    const result = await runWithCapture("npm", stepArgs, { cwd, timeoutMs: gateTimeout });
    if (!result.ok) return result;
  }

  return {
    ok: true,
    code: "ok",
    command: "npm",
    args: ["run", "aahp:check", "&&", "test", "&&", "run", "typecheck"],
    timeoutMs: gateTimeout,
    stdout: "security_gate_passed",
    stderr: "",
    error: "",
    exitCode: 0,
  };
}

async function runShell(payload) {
  if (!payload.binary) {
    return invalidPayload("shell payload requires binary");
  }

  const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
  return runWithCapture(String(payload.binary), args, {
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

  if (!payload.binary) {
    return {
      ...invalidPayload("orchestrator-run payload requires binary"),
      securityGate,
    };
  }

  const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
  const run = await runWithCapture(String(payload.binary), args, {
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
    return invalidPayload("hook-dispatch payload requires eventJsonPath");
  }

  return runWithCapture("node", ["src/cli.js", "hook", "--event-file", payload.eventJsonPath], {
    cwd: payload.cwd,
    timeoutMs: payload.timeoutMs,
  });
}

function deniedResult(code, command, args, error) {
  return {
    ok: false,
    code,
    command,
    args,
    timeoutMs: null,
    stdout: "",
    stderr: "",
    error,
    exitCode: null,
    signal: null,
  };
}

function invalidPayload(message) {
  return {
    ok: false,
    code: "invalid_payload",
    stdout: "",
    stderr: "",
    error: message,
  };
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
