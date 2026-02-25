import type { ControlPlaneStore } from "../persistence.js";
import type {
  DlqEntry,
  HeartbeatRequest,
  NodeView,
  RegisterNodeRequest,
  Task,
  TaskResult,
} from "../contracts.js";

export class RedisControlPlaneStore implements ControlPlaneStore {
  constructor(private readonly redisUrl: string) {}

  private notImplemented(): never {
    throw new Error(`not_implemented:redis_store:${this.redisUrl}`);
  }

  // Phase 2E scaffold: API shape is fixed, implementation comes next.
  upsertNode(node: RegisterNodeRequest): void {
    void node;
    this.notImplemented();
  }
  getNode(nodeId: string): NodeView | undefined {
    void nodeId;
    this.notImplemented();
  }
  listNodes(): NodeView[] {
    this.notImplemented();
  }
  setHeartbeat(nodeId: string, heartbeat: HeartbeatRequest): boolean {
    void nodeId;
    void heartbeat;
    this.notImplemented();
  }
  setNodeTrust(nodeId: string, trust: { trusted?: boolean; revoked?: boolean }): boolean {
    void nodeId;
    void trust;
    this.notImplemented();
  }
  enqueueTask(task: Task): void {
    void task;
    this.notImplemented();
  }
  claimTask(nodeId: string): Task | null {
    void nodeId;
    this.notImplemented();
  }
  setTaskStatus(taskId: string, status: Task["status"]): Task | null {
    void taskId;
    void status;
    this.notImplemented();
  }
  getTask(taskId: string): Task | undefined {
    void taskId;
    this.notImplemented();
  }
  listQueuedTasks(): Task[] {
    this.notImplemented();
  }
  listRunningTasks(): Task[] {
    this.notImplemented();
  }
  listTasks(status?: Task["status"]): Task[] {
    void status;
    this.notImplemented();
  }
  requeueForRetry(taskId: string, retryAfter: number): boolean {
    void taskId;
    void retryAfter;
    this.notImplemented();
  }
  setTaskResult(result: TaskResult): void {
    void result;
    this.notImplemented();
  }
  getTaskResult(taskId: string): TaskResult | undefined {
    void taskId;
    this.notImplemented();
  }
  enqueueDlq(entry: DlqEntry): void {
    void entry;
    this.notImplemented();
  }
  listDlq(): DlqEntry[] {
    this.notImplemented();
  }
  getDlqEntry(taskId: string): DlqEntry | undefined {
    void taskId;
    this.notImplemented();
  }
  requeueFromDlq(taskId: string): boolean {
    void taskId;
    this.notImplemented();
  }
}
