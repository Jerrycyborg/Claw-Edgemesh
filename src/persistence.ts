import type {
  DlqEntry,
  HeartbeatRequest,
  NodeFreshnessState,
  NodeView,
  RegisterNodeRequest,
  Task,
  TaskResult,
} from "./contracts.js";

type NodeRecord = RegisterNodeRequest & {
  lastHeartbeat?: HeartbeatRequest;
  trusted?: boolean;
  revoked?: boolean;
};

export interface ControlPlaneStore {
  upsertNode(node: RegisterNodeRequest): void;
  getNode(nodeId: string): NodeView | undefined;
  listNodes(): NodeView[];
  setHeartbeat(nodeId: string, heartbeat: HeartbeatRequest): boolean;
  setNodeTrust(nodeId: string, trust: { trusted?: boolean; revoked?: boolean }): boolean;

  enqueueTask(task: Task): void;
  claimTask(nodeId: string): Task | null;
  setTaskStatus(taskId: string, status: Task["status"]): Task | null;
  getTask(taskId: string): Task | undefined;
  listQueuedTasks(): Task[];
  listRunningTasks(): Task[];
  listTasks(status?: Task["status"]): Task[];

  requeueForRetry(taskId: string, retryAfter: number): boolean;

  setTaskResult(result: TaskResult): void;
  getTaskResult(taskId: string): TaskResult | undefined;

  enqueueDlq(entry: DlqEntry): void;
  listDlq(): DlqEntry[];
  getDlqEntry(taskId: string): DlqEntry | undefined;
  requeueFromDlq(taskId: string): boolean;
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private nodes = new Map<string, NodeRecord>();
  private tasks = new Map<string, Task>();
  private taskQueue: string[] = [];
  private results = new Map<string, TaskResult>();
  private dlq = new Map<string, DlqEntry>();
  private readonly claimTtlMs: number;
  private readonly heartbeatHealthyMs: number;
  private readonly heartbeatDegradedMs: number;

  constructor(
    options: { claimTtlMs?: number; heartbeatHealthyMs?: number; heartbeatDegradedMs?: number } = {}
  ) {
    this.claimTtlMs = options.claimTtlMs ?? 30_000;
    this.heartbeatHealthyMs = options.heartbeatHealthyMs ?? 10_000;
    this.heartbeatDegradedMs = options.heartbeatDegradedMs ?? 30_000;
  }

  upsertNode(node: RegisterNodeRequest): void {
    const existing = this.nodes.get(node.nodeId);
    this.nodes.set(node.nodeId, { ...node, lastHeartbeat: existing?.lastHeartbeat });
  }

  getNode(nodeId: string): NodeView | undefined {
    const node = this.nodes.get(nodeId);
    if (!node) return undefined;
    return this.toNodeView(node);
  }

  listNodes(): NodeView[] {
    return [...this.nodes.values()].map((n) => this.toNodeView(n));
  }

  setHeartbeat(nodeId: string, heartbeat: HeartbeatRequest): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.lastHeartbeat = heartbeat;
    this.nodes.set(nodeId, node);
    return true;
  }

  setNodeTrust(nodeId: string, trust: { trusted?: boolean; revoked?: boolean }): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.trusted = trust.trusted ?? node.trusted;
    node.revoked = trust.revoked ?? node.revoked;
    this.nodes.set(nodeId, node);
    return true;
  }

  enqueueTask(task: Task): void {
    this.tasks.set(task.taskId, task);
    this.taskQueue.push(task.taskId);
  }

  claimTask(nodeId: string): Task | null {
    this.requeueExpiredClaims();

    const node = this.nodes.get(nodeId);
    if (!node) return null;
    if (node.revoked || !node.trusted) return null;
    if (this.getFreshnessState(node) !== "healthy") return null;

    const activeOnNode = this.countActiveTasksForNode(nodeId);
    if (activeOnNode >= node.capabilities.maxConcurrentTasks) return null;

    const now = Date.now();
    const candidateId = this.taskQueue.find((taskId) => {
      const t = this.tasks.get(taskId);
      if (!t || t.status !== "queued") return false;
      if (t.retryAfter && t.retryAfter > now) return false;
      if (t.targetNodeId && t.targetNodeId !== nodeId) return false;
      if (t.requiredTags?.length) {
        const tags = new Set(node.capabilities.tags);
        return t.requiredTags.every((tag) => tags.has(tag));
      }
      return true;
    });

    if (!candidateId) return null;

    const task = this.tasks.get(candidateId)!;
    task.status = "claimed";
    task.claimedAt = Date.now();
    task.attempt = (task.attempt ?? 0) + 1;
    task.assignedNodeId = nodeId;
    this.tasks.set(task.taskId, task);

    const idx = this.taskQueue.indexOf(candidateId);
    if (idx >= 0) this.taskQueue.splice(idx, 1);

    return task;
  }

  setTaskStatus(taskId: string, status: Task["status"]): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = status;

    if (status === "running" || status === "done" || status === "failed") {
      task.claimedAt = undefined;
    }
    this.tasks.set(taskId, task);
    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  listQueuedTasks(): Task[] {
    return [...this.tasks.values()].filter((task) => task.status === "queued");
  }

  listRunningTasks(): Task[] {
    return [...this.tasks.values()].filter(
      (task) => task.status === "claimed" || task.status === "running"
    );
  }

  listTasks(status?: Task["status"]): Task[] {
    if (!status) return [...this.tasks.values()];
    return [...this.tasks.values()].filter((task) => task.status === status);
  }

  requeueForRetry(taskId: string, retryAfter: number): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = "queued";
    task.claimedAt = undefined;
    task.assignedNodeId = undefined;
    task.retryAfter = retryAfter;
    this.tasks.set(taskId, task);

    if (!this.taskQueue.includes(taskId)) {
      this.taskQueue.push(taskId);
    }
    return true;
  }

  setTaskResult(result: TaskResult): void {
    this.results.set(result.taskId, result);
  }

  getTaskResult(taskId: string): TaskResult | undefined {
    return this.results.get(taskId);
  }

  enqueueDlq(entry: DlqEntry): void {
    this.dlq.set(entry.taskId, entry);
  }

  listDlq(): DlqEntry[] {
    return [...this.dlq.values()];
  }

  getDlqEntry(taskId: string): DlqEntry | undefined {
    return this.dlq.get(taskId);
  }

  requeueFromDlq(taskId: string): boolean {
    const entry = this.dlq.get(taskId);
    if (!entry) return false;

    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = "queued";
    task.attempt = 0;
    task.retryAfter = undefined;
    task.claimedAt = undefined;
    task.assignedNodeId = undefined;
    this.tasks.set(taskId, task);

    if (!this.taskQueue.includes(taskId)) this.taskQueue.push(taskId);
    this.dlq.delete(taskId);
    return true;
  }

  private getFreshnessState(node: NodeRecord): NodeFreshnessState {
    const hb = node.lastHeartbeat;
    if (!hb) return "offline";

    const ageMs = Date.now() - hb.ts;
    if (ageMs > this.heartbeatDegradedMs) return "offline";
    if (ageMs > this.heartbeatHealthyMs) return "degraded";
    if (hb.status === "degraded") return "degraded";
    return "healthy";
  }

  private toNodeView(node: NodeRecord): NodeView {
    return {
      ...node,
      freshnessState: this.getFreshnessState(node),
      trusted: node.trusted ?? false,
      revoked: node.revoked ?? false,
    };
  }

  private countActiveTasksForNode(nodeId: string): number {
    let total = 0;
    for (const task of this.tasks.values()) {
      if (task.assignedNodeId !== nodeId) continue;
      if (task.status === "claimed" || task.status === "running") total += 1;
    }
    return total;
  }

  private requeueExpiredClaims() {
    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (task.status !== "claimed") continue;
      if (!task.claimedAt) continue;
      if (now - task.claimedAt < this.claimTtlMs) continue;

      task.status = "queued";
      task.claimedAt = undefined;
      task.assignedNodeId = undefined;
      this.tasks.set(task.taskId, task);

      if (!this.taskQueue.includes(task.taskId)) {
        this.taskQueue.push(task.taskId);
      }
    }
  }
}
