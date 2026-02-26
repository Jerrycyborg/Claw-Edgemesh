import { Redis } from "ioredis";
import type { ControlPlaneStore } from "../persistence.js";
import type {
  DlqEntry,
  HeartbeatRequest,
  NodeFreshnessState,
  NodeView,
  RegisterNodeRequest,
  Task,
  TaskResult,
} from "../contracts.js";

type NodeRecord = RegisterNodeRequest & {
  lastHeartbeat?: HeartbeatRequest;
  trusted?: boolean;
  revoked?: boolean;
};

export class RedisControlPlaneStore implements ControlPlaneStore {
  private readonly redis: Redis;
  private readonly claimTtlMs: number;
  private readonly heartbeatHealthyMs: number;
  private readonly heartbeatDegradedMs: number;

  constructor(
    redisOrUrl: Redis | string,
    options: {
      claimTtlMs?: number;
      heartbeatHealthyMs?: number;
      heartbeatDegradedMs?: number;
    } = {}
  ) {
    this.redis = typeof redisOrUrl === "string" ? new Redis(redisOrUrl) : redisOrUrl;
    this.claimTtlMs = options.claimTtlMs ?? 30_000;
    this.heartbeatHealthyMs = options.heartbeatHealthyMs ?? 10_000;
    this.heartbeatDegradedMs = options.heartbeatDegradedMs ?? 30_000;
  }

  // ── Nodes ────────────────────────────────────────────────────────────────

  async upsertNode(node: RegisterNodeRequest): Promise<void> {
    const existing = await this.getNodeRecord(node.nodeId);
    const record: NodeRecord = { ...node, lastHeartbeat: existing?.lastHeartbeat };
    await this.redis.set(`node:${node.nodeId}`, JSON.stringify(record));
    await this.redis.sadd("nodes", node.nodeId);
  }

  async getNode(nodeId: string): Promise<NodeView | undefined> {
    const record = await this.getNodeRecord(nodeId);
    if (!record) return undefined;
    return this.toNodeView(record);
  }

  async listNodes(): Promise<NodeView[]> {
    const ids = await this.redis.smembers("nodes");
    const records = await Promise.all(ids.map((id) => this.getNodeRecord(id)));
    return records.filter((r): r is NodeRecord => r !== undefined).map((r) => this.toNodeView(r));
  }

  async setHeartbeat(nodeId: string, heartbeat: HeartbeatRequest): Promise<boolean> {
    const record = await this.getNodeRecord(nodeId);
    if (!record) return false;
    record.lastHeartbeat = heartbeat;
    await this.redis.set(`node:${nodeId}`, JSON.stringify(record));
    return true;
  }

  async setNodeTrust(
    nodeId: string,
    trust: { trusted?: boolean; revoked?: boolean }
  ): Promise<boolean> {
    const record = await this.getNodeRecord(nodeId);
    if (!record) return false;
    record.trusted = trust.trusted ?? record.trusted;
    record.revoked = trust.revoked ?? record.revoked;
    await this.redis.set(`node:${nodeId}`, JSON.stringify(record));
    return true;
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  async enqueueTask(task: Task): Promise<void> {
    await this.redis.set(`task:${task.taskId}`, JSON.stringify(task));
    await this.redis.sadd("tasks", task.taskId);
    await this.redis.rpush("taskqueue", task.taskId);
  }

  async claimTask(nodeId: string): Promise<Task | null> {
    await this.requeueExpiredClaims();

    const node = await this.getNodeRecord(nodeId);
    if (!node) return null;
    if (node.revoked || !node.trusted) return null;
    if (this.getFreshnessState(node) !== "healthy") return null;

    const active = await this.countActiveTasksForNode(nodeId);
    if (active >= node.capabilities.maxConcurrentTasks) return null;

    const queuedIds = await this.redis.lrange("taskqueue", 0, -1);
    const now = Date.now();

    for (const taskId of queuedIds) {
      const raw = await this.redis.get(`task:${taskId}`);
      if (!raw) continue;
      const task = JSON.parse(raw) as Task;

      if (task.status !== "queued") continue;
      if (task.retryAfter && task.retryAfter > now) continue;
      if (task.targetNodeId && task.targetNodeId !== nodeId) continue;
      if (task.requiredTags?.length) {
        const tags = new Set(node.capabilities.tags);
        if (!task.requiredTags.every((t) => tags.has(t))) continue;
      }

      const claimed = await this.tryClaimTask(task, nodeId);
      if (claimed) return claimed;
    }

    return null;
  }

  async setTaskStatus(taskId: string, status: Task["status"]): Promise<Task | null> {
    const raw = await this.redis.get(`task:${taskId}`);
    if (!raw) return null;
    const task = JSON.parse(raw) as Task;
    task.status = status;
    if (status === "running" || status === "done" || status === "failed") {
      task.claimedAt = undefined;
    }
    await this.redis.set(`task:${taskId}`, JSON.stringify(task));
    return task;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const raw = await this.redis.get(`task:${taskId}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as Task;
  }

  async listQueuedTasks(): Promise<Task[]> {
    return this.listTasks("queued");
  }

  async listRunningTasks(): Promise<Task[]> {
    const all = await this.listTasks();
    return all.filter((t) => t.status === "claimed" || t.status === "running");
  }

  async listTasks(status?: Task["status"]): Promise<Task[]> {
    const ids = await this.redis.smembers("tasks");
    const raws = await Promise.all(ids.map((id) => this.redis.get(`task:${id}`)));
    const tasks = raws.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as Task);
    return status ? tasks.filter((t) => t.status === status) : tasks;
  }

  async requeueForRetry(taskId: string, retryAfter: number): Promise<boolean> {
    const raw = await this.redis.get(`task:${taskId}`);
    if (!raw) return false;
    const task = JSON.parse(raw) as Task;
    task.status = "queued";
    task.claimedAt = undefined;
    task.assignedNodeId = undefined;
    task.retryAfter = retryAfter;
    await this.redis.set(`task:${taskId}`, JSON.stringify(task));
    const queue = await this.redis.lrange("taskqueue", 0, -1);
    if (!queue.includes(taskId)) await this.redis.rpush("taskqueue", taskId);
    return true;
  }

  // ── Results ───────────────────────────────────────────────────────────────

  async setTaskResult(result: TaskResult): Promise<void> {
    await this.redis.set(`result:${result.taskId}`, JSON.stringify(result));
  }

  async getTaskResult(taskId: string): Promise<TaskResult | undefined> {
    const raw = await this.redis.get(`result:${taskId}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as TaskResult;
  }

  // ── DLQ ───────────────────────────────────────────────────────────────────

  async enqueueDlq(entry: DlqEntry): Promise<void> {
    await this.redis.set(`dlq:${entry.taskId}`, JSON.stringify(entry));
    await this.redis.sadd("dlq", entry.taskId);
  }

  async listDlq(): Promise<DlqEntry[]> {
    const ids = await this.redis.smembers("dlq");
    const raws = await Promise.all(ids.map((id) => this.redis.get(`dlq:${id}`)));
    return raws.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as DlqEntry);
  }

  async getDlqEntry(taskId: string): Promise<DlqEntry | undefined> {
    const raw = await this.redis.get(`dlq:${taskId}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as DlqEntry;
  }

  async requeueFromDlq(taskId: string): Promise<boolean> {
    const dlqRaw = await this.redis.get(`dlq:${taskId}`);
    if (!dlqRaw) return false;
    const taskRaw = await this.redis.get(`task:${taskId}`);
    if (!taskRaw) return false;

    const task = JSON.parse(taskRaw) as Task;
    task.status = "queued";
    task.attempt = 0;
    task.retryAfter = undefined;
    task.claimedAt = undefined;
    task.assignedNodeId = undefined;

    await this.redis.set(`task:${taskId}`, JSON.stringify(task));
    const queue = await this.redis.lrange("taskqueue", 0, -1);
    if (!queue.includes(taskId)) await this.redis.rpush("taskqueue", taskId);
    await this.redis.del(`dlq:${taskId}`);
    await this.redis.srem("dlq", taskId);
    return true;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async quit(): Promise<void> {
    await this.redis.quit();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async tryClaimTask(task: Task, nodeId: string): Promise<Task | null> {
    const key = `task:${task.taskId}`;

    // Re-read inside claim to catch any concurrent status change.
    // Node.js is single-threaded so this is safe for single-process deployments.
    // Multi-instance deployments should layer Redlock (or similar) on top.
    const fresh = await this.redis.get(key);
    if (!fresh) return null;
    const freshTask = JSON.parse(fresh) as Task;
    if (freshTask.status !== "queued") return null;

    const updated: Task = {
      ...freshTask,
      status: "claimed",
      claimedAt: Date.now(),
      attempt: (freshTask.attempt ?? 0) + 1,
      assignedNodeId: nodeId,
    };

    await this.redis.set(key, JSON.stringify(updated));
    await this.redis.lrem("taskqueue", 1, task.taskId);
    return updated;
  }

  private async requeueExpiredClaims(): Promise<void> {
    const now = Date.now();
    const ids = await this.redis.smembers("tasks");
    const raws = await Promise.all(ids.map((id) => this.redis.get(`task:${id}`)));

    for (const raw of raws) {
      if (!raw) continue;
      const task = JSON.parse(raw) as Task;
      if (task.status !== "claimed" || !task.claimedAt) continue;
      if (now - task.claimedAt < this.claimTtlMs) continue;

      task.status = "queued";
      task.claimedAt = undefined;
      task.assignedNodeId = undefined;
      await this.redis.set(`task:${task.taskId}`, JSON.stringify(task));
      const queue = await this.redis.lrange("taskqueue", 0, -1);
      if (!queue.includes(task.taskId)) await this.redis.rpush("taskqueue", task.taskId);
    }
  }

  private async countActiveTasksForNode(nodeId: string): Promise<number> {
    const ids = await this.redis.smembers("tasks");
    const raws = await Promise.all(ids.map((id) => this.redis.get(`task:${id}`)));
    return raws
      .filter((r): r is string => r !== null)
      .map((r) => JSON.parse(r) as Task)
      .filter(
        (t) => t.assignedNodeId === nodeId && (t.status === "claimed" || t.status === "running")
      ).length;
  }

  private async getNodeRecord(nodeId: string): Promise<NodeRecord | undefined> {
    const raw = await this.redis.get(`node:${nodeId}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as NodeRecord;
  }

  private getFreshnessState(node: NodeRecord): NodeFreshnessState {
    const hb = node.lastHeartbeat;
    if (!hb) return "offline";
    const age = Date.now() - hb.ts;
    if (age > this.heartbeatDegradedMs) return "offline";
    if (age > this.heartbeatHealthyMs) return "degraded";
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
}
