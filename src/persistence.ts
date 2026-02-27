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
  upsertNode(node: RegisterNodeRequest): Promise<void>;
  getNode(nodeId: string): Promise<NodeView | undefined>;
  listNodes(): Promise<NodeView[]>;
  setHeartbeat(nodeId: string, heartbeat: HeartbeatRequest): Promise<boolean>;
  setNodeTrust(nodeId: string, trust: { trusted?: boolean; revoked?: boolean }): Promise<boolean>;

  enqueueTask(task: Task): Promise<void>;
  claimTask(nodeId: string): Promise<Task | null>;
  setTaskStatus(taskId: string, status: Task["status"]): Promise<Task | null>;
  getTask(taskId: string): Promise<Task | undefined>;
  listQueuedTasks(): Promise<Task[]>;
  listRunningTasks(): Promise<Task[]>;
  listTasks(status?: Task["status"]): Promise<Task[]>;

  cancelTask(taskId: string): Promise<boolean>;
  requeueForRetry(taskId: string, retryAfter: number): Promise<boolean>;

  setTaskResult(result: TaskResult): Promise<void>;
  getTaskResult(taskId: string): Promise<TaskResult | undefined>;

  enqueueDlq(entry: DlqEntry): Promise<void>;
  listDlq(): Promise<DlqEntry[]>;
  getDlqEntry(taskId: string): Promise<DlqEntry | undefined>;
  requeueFromDlq(taskId: string): Promise<boolean>;
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

  async upsertNode(node: RegisterNodeRequest): Promise<void> {
    const existing = this.nodes.get(node.nodeId);
    this.nodes.set(node.nodeId, { ...node, lastHeartbeat: existing?.lastHeartbeat });
  }

  async getNode(nodeId: string): Promise<NodeView | undefined> {
    const node = this.nodes.get(nodeId);
    if (!node) return undefined;
    return this.toNodeView(node);
  }

  async listNodes(): Promise<NodeView[]> {
    return [...this.nodes.values()].map((n) => this.toNodeView(n));
  }

  async setHeartbeat(nodeId: string, heartbeat: HeartbeatRequest): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.lastHeartbeat = heartbeat;
    this.nodes.set(nodeId, node);
    return true;
  }

  async setNodeTrust(
    nodeId: string,
    trust: { trusted?: boolean; revoked?: boolean }
  ): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.trusted = trust.trusted ?? node.trusted;
    node.revoked = trust.revoked ?? node.revoked;
    this.nodes.set(nodeId, node);
    return true;
  }

  async enqueueTask(task: Task): Promise<void> {
    this.tasks.set(task.taskId, task);
    this.taskQueue.push(task.taskId);
  }

  async claimTask(nodeId: string): Promise<Task | null> {
    this.requeueExpiredClaims();

    const node = this.nodes.get(nodeId);
    if (!node) return null;
    if (node.revoked || !node.trusted) return null;
    if (this.getFreshnessState(node) !== "healthy") return null;

    const activeOnNode = this.countActiveTasksForNode(nodeId);
    if (activeOnNode >= node.capabilities.maxConcurrentTasks) return null;

    const now = Date.now();
    const nodeTags = new Set(node.capabilities.tags);
    const candidates = this.taskQueue
      .map((taskId) => this.tasks.get(taskId))
      .filter((t): t is Task => {
        if (!t || t.status !== "queued") return false;
        if (t.retryAfter && t.retryAfter > now) return false;
        if (t.targetNodeId && t.targetNodeId !== nodeId) return false;
        if (t.requiredTags?.length && !t.requiredTags.every((tag) => nodeTags.has(tag)))
          return false;
        return true;
      })
      .sort((a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pb !== pa) return pb - pa; // higher priority first
        return a.createdAt - b.createdAt; // FIFO tiebreak
      });

    const candidateId = candidates[0]?.taskId;
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

  async setTaskStatus(taskId: string, status: Task["status"]): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = status;

    if (status === "running" || status === "done" || status === "failed") {
      task.claimedAt = undefined;
    }
    this.tasks.set(taskId, task);
    return task;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return this.tasks.get(taskId);
  }

  async listQueuedTasks(): Promise<Task[]> {
    return this.listTasks("queued");
  }

  async listRunningTasks(): Promise<Task[]> {
    return [...this.tasks.values()].filter(
      (task) => task.status === "claimed" || task.status === "running"
    );
  }

  async listTasks(status?: Task["status"]): Promise<Task[]> {
    if (!status) return [...this.tasks.values()];
    return [...this.tasks.values()].filter((task) => task.status === status);
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "done" || task.status === "failed" || task.status === "cancelled")
      return false;

    const idx = this.taskQueue.indexOf(taskId);
    if (idx >= 0) this.taskQueue.splice(idx, 1);

    task.status = "cancelled";
    task.claimedAt = undefined;
    this.tasks.set(taskId, task);
    return true;
  }

  async requeueForRetry(taskId: string, retryAfter: number): Promise<boolean> {
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

  async setTaskResult(result: TaskResult): Promise<void> {
    this.results.set(result.taskId, result);
  }

  async getTaskResult(taskId: string): Promise<TaskResult | undefined> {
    return this.results.get(taskId);
  }

  async enqueueDlq(entry: DlqEntry): Promise<void> {
    this.dlq.set(entry.taskId, entry);
  }

  async listDlq(): Promise<DlqEntry[]> {
    return [...this.dlq.values()];
  }

  async getDlqEntry(taskId: string): Promise<DlqEntry | undefined> {
    return this.dlq.get(taskId);
  }

  async requeueFromDlq(taskId: string): Promise<boolean> {
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
