import type { HeartbeatRequest, NodeFreshnessState, NodeView, RegisterNodeRequest, Task, TaskResult } from "./contracts.js";

type NodeRecord = RegisterNodeRequest & { lastHeartbeat?: HeartbeatRequest };

export interface ControlPlaneStore {
  upsertNode(node: RegisterNodeRequest): void;
  getNode(nodeId: string): NodeView | undefined;
  listNodes(): NodeView[];
  setHeartbeat(nodeId: string, heartbeat: HeartbeatRequest): boolean;

  enqueueTask(task: Task): void;
  claimTask(nodeId: string): Task | null;
  setTaskStatus(taskId: string, status: Task["status"]): Task | null;
  getTask(taskId: string): Task | undefined;
  listQueuedTasks(): Task[];
  listRunningTasks(): Task[];

  setTaskResult(result: TaskResult): void;
  getTaskResult(taskId: string): TaskResult | undefined;
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private nodes = new Map<string, NodeRecord>();
  private tasks = new Map<string, Task>();
  private taskQueue: string[] = [];
  private results = new Map<string, TaskResult>();
  private readonly claimTtlMs: number;
  private readonly heartbeatHealthyMs: number;
  private readonly heartbeatDegradedMs: number;

  constructor(options: { claimTtlMs?: number; heartbeatHealthyMs?: number; heartbeatDegradedMs?: number } = {}) {
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

  enqueueTask(task: Task): void {
    this.tasks.set(task.taskId, task);
    this.taskQueue.push(task.taskId);
  }

  claimTask(nodeId: string): Task | null {
    this.requeueExpiredClaims();

    const node = this.nodes.get(nodeId);
    if (!node) return null;
    if (this.getFreshnessState(node) !== "healthy") return null;

    const activeOnNode = this.countActiveTasksForNode(nodeId);
    if (activeOnNode >= node.capabilities.maxConcurrentTasks) return null;

    const candidateId = this.taskQueue.find((taskId) => {
      const t = this.tasks.get(taskId);
      if (!t || t.status !== "queued") return false;
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
    return [...this.tasks.values()].filter((task) => task.status === "claimed" || task.status === "running");
  }

  setTaskResult(result: TaskResult): void {
    this.results.set(result.taskId, result);
  }

  getTaskResult(taskId: string): TaskResult | undefined {
    return this.results.get(taskId);
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
