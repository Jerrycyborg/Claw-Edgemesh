export type SchemaVersion = "1.0";

export interface NodeCapabilities {
  tags: string[];
  maxConcurrentTasks: number;
}

export interface RegisterNodeRequest {
  schemaVersion: SchemaVersion;
  nodeId: string;
  region?: string;
  capabilities: NodeCapabilities;
}

export interface HeartbeatRequest {
  schemaVersion: SchemaVersion;
  nodeId: string;
  ts: number;
  status: "healthy" | "degraded";
  load: number; // 0..1
  runningTasks: number;
}

export type NodeFreshnessState = "healthy" | "degraded" | "offline";

export interface NodeView extends RegisterNodeRequest {
  lastHeartbeat?: HeartbeatRequest;
  freshnessState: NodeFreshnessState;
  trusted?: boolean;
  revoked?: boolean;
}

export interface Task {
  schemaVersion: SchemaVersion;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  targetNodeId?: string;
  requiredTags?: string[];
  maxAttempts?: number;
  /** Higher number = higher urgency. Default 0. Tiebreak is FIFO (createdAt asc). */
  priority?: number;
  status: "queued" | "claimed" | "running" | "done" | "failed";
  createdAt: number;
  claimedAt?: number;
  retryAfter?: number;
  attempt?: number;
  assignedNodeId?: string;
}

export interface TaskResult {
  schemaVersion: SchemaVersion;
  taskId: string;
  nodeId: string;
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  finishedAt: number;
}

export interface DlqEntry {
  schemaVersion: SchemaVersion;
  taskId: string;
  task: Task;
  lastResult: TaskResult;
  reason: string;
  enqueuedAt: number;
}
