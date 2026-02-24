export interface CapturedExecResult {
  ok: boolean;
  code: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  stdout: string;
  stderr: string;
  error: string;
  exitCode?: number | null;
  signal?: string | null;
  securityGate?: CapturedExecResult;
}

export interface NodeExecutionResult {
  nodeId: string;
  jobId: string;
  taskType: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  execution: CapturedExecResult;
}

export function executeOnNode(node: { nodeId: string }, job: any): Promise<NodeExecutionResult>;
export function runWithCapture(
  command: string,
  args?: string[],
  options?: any
): Promise<CapturedExecResult>;
export function runSecurityGate(options?: {
  cwd?: string;
  timeoutMs?: number;
}): Promise<CapturedExecResult>;
