import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  DlqEntry,
  HeartbeatRequest,
  RegisterNodeRequest,
  Task,
  TaskResult,
} from "./contracts.js";
import { InMemoryControlPlaneStore, type ControlPlaneStore } from "./persistence.js";
import type { EdgeMeshEvent, EdgeMeshPlugin } from "./plugins/types.js";
import { createTelemetryPlugin } from "./plugins/telemetry-plugin.js";
import { JobTokenManager, NodeJwtManager, NodeTrustManager } from "./security.js";
import { computeRetryDecision } from "./control/retry-policy.js";

const SCHEMA_VERSION = "1.0" as const;

function createStore(): ControlPlaneStore {
  if (process.env.EDGEMESH_STORE === "redis") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RedisControlPlaneStore } = require("./persistence/redis-adapter.js");
    const redisUrl = process.env.EDGEMESH_REDIS_URL ?? "redis://localhost:6379";
    return new RedisControlPlaneStore(redisUrl) as ControlPlaneStore;
  }
  return new InMemoryControlPlaneStore();
}

function extractNodeJwt(
  req: FastifyRequest,
  mgr: NodeJwtManager
): { ok: true; nodeId: string } | { ok: false; error: string } {
  const auth = req.headers.authorization;
  const raw = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!raw) return { ok: false, error: "missing_node_token" };
  return mgr.verify(raw);
}

export function buildControlPlane(
  store: ControlPlaneStore = createStore(),
  options: { plugins?: EdgeMeshPlugin[]; nodeJwtManager?: NodeJwtManager } = {}
): FastifyInstance {
  const app = Fastify({ logger: true });

  const tokenManager = new JobTokenManager();
  const trustManager = new NodeTrustManager();
  const nodeJwtManager = options.nodeJwtManager ?? new NodeJwtManager();
  const adminSecret = process.env.EDGEMESH_ADMIN_SECRET ?? "admin-dev";

  const events: EdgeMeshEvent[] = [];
  const ctx = {
    emit(event: EdgeMeshEvent) {
      events.push(event);
      if (events.length > 2000) events.shift();
    },
  };

  const plugins = options.plugins ?? [createTelemetryPlugin()];
  for (const plugin of plugins) {
    plugin.register(app, ctx);
  }

  app.get("/health", async () => ({ ok: true }));

  // ── Nodes ────────────────────────────────────────────────────────────────

  app.post<{ Body: RegisterNodeRequest }>(
    "/v1/nodes/register",
    {
      schema: {
        body: {
          type: "object",
          required: ["schemaVersion", "nodeId", "capabilities"],
          properties: {
            schemaVersion: { type: "string" },
            nodeId: { type: "string", minLength: 1 },
            region: { type: "string" },
            capabilities: {
              type: "object",
              required: ["tags", "maxConcurrentTasks"],
              properties: {
                tags: { type: "array", items: { type: "string" } },
                maxConcurrentTasks: { type: "integer", minimum: 1, maximum: 100 },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const bootstrapToken = req.headers["x-bootstrap-token"];
      if (
        !trustManager.verifyBootstrapToken(
          typeof bootstrapToken === "string" ? bootstrapToken : undefined
        )
      ) {
        return reply.code(401).send({ ok: false, error: "node_bootstrap_denied" });
      }

      await store.upsertNode(req.body);
      await store.setNodeTrust(req.body.nodeId, { trusted: true, revoked: false });
      ctx.emit({ type: "node.registered", at: Date.now(), nodeId: req.body.nodeId });

      const { token, exp } = nodeJwtManager.issue(req.body.nodeId);
      return { ok: true, nodeId: req.body.nodeId, trusted: true, token, exp };
    }
  );

  app.post<{ Params: { nodeId: string } }>("/v1/nodes/refresh-token", async (req, reply) => {
    const jwt = extractNodeJwt(req, nodeJwtManager);
    if (!jwt.ok) return reply.code(401).send({ ok: false, error: jwt.error });

    const node = await store.getNode(jwt.nodeId);
    if (!node) return reply.code(404).send({ ok: false, error: "unknown_node" });
    if (node.revoked) return reply.code(403).send({ ok: false, error: "node_revoked" });

    const { token, exp } = nodeJwtManager.issue(jwt.nodeId);
    return { ok: true, token, exp };
  });

  app.post<{ Params: { nodeId: string } }>("/v1/nodes/:nodeId/revoke", async (req, reply) => {
    const adminToken = req.headers["x-admin-token"];
    if (adminToken !== adminSecret)
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    await store.setNodeTrust(req.params.nodeId, { trusted: false, revoked: true });
    ctx.emit({ type: "node.revoked", at: Date.now(), nodeId: req.params.nodeId });
    return { ok: true };
  });

  app.get("/v1/nodes", async () => ({ nodes: await store.listNodes() }));

  app.get<{ Params: { nodeId: string } }>("/v1/nodes/:nodeId/stats", async (req, reply) => {
    const node = await store.getNode(req.params.nodeId);
    if (!node) return reply.code(404).send({ ok: false, error: "node_not_found" });

    const allTasks = await store.listTasks();
    const mine = allTasks.filter((t) => t.assignedNodeId === req.params.nodeId);
    const completed = mine.filter((t) => t.status === "done").length;
    const failed = mine.filter((t) => t.status === "failed").length;
    const running = mine.filter((t) => t.status === "claimed" || t.status === "running").length;
    const total = mine.length;
    const successRatio = completed + failed > 0 ? completed / (completed + failed) : null;

    return {
      ok: true,
      nodeId: req.params.nodeId,
      freshnessState: node.freshnessState,
      tasksTotal: total,
      tasksCompleted: completed,
      tasksFailed: failed,
      tasksRunning: running,
      successRatio,
    };
  });

  app.post<{ Params: { nodeId: string }; Body: HeartbeatRequest }>(
    "/v1/nodes/:nodeId/heartbeat",
    {
      schema: {
        body: {
          type: "object",
          required: ["schemaVersion", "nodeId", "ts", "status", "load", "runningTasks"],
          properties: {
            schemaVersion: { type: "string" },
            nodeId: { type: "string", minLength: 1 },
            ts: { type: "number" },
            status: { type: "string", enum: ["healthy", "degraded"] },
            load: { type: "number", minimum: 0, maximum: 1 },
            runningTasks: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      const jwt = extractNodeJwt(req, nodeJwtManager);
      if (!jwt.ok) return reply.code(401).send({ ok: false, error: jwt.error });
      if (jwt.nodeId !== req.params.nodeId)
        return reply.code(403).send({ ok: false, error: "token_node_mismatch" });

      const node = await store.getNode(req.params.nodeId);
      if (!node) return reply.code(404).send({ ok: false, error: "unknown_node" });
      if (node.revoked) return reply.code(403).send({ ok: false, error: "node_revoked" });
      const ok = await store.setHeartbeat(req.params.nodeId, req.body);
      if (!ok) return reply.code(404).send({ ok: false, error: "unknown_node" });
      ctx.emit({ type: "node.heartbeat", at: Date.now(), nodeId: req.params.nodeId });
      return { ok: true };
    }
  );

  // ── Job tokens + tasks ────────────────────────────────────────────────────

  app.post<{
    Body: { jobId: string; targetNodeId?: string; requiredTags?: string[]; ttlMs?: number };
  }>(
    "/v1/auth/job-token",
    {
      schema: {
        body: {
          type: "object",
          required: ["jobId"],
          properties: {
            jobId: { type: "string", minLength: 1 },
            targetNodeId: { type: "string" },
            requiredTags: { type: "array", items: { type: "string" } },
            ttlMs: { type: "number" },
          },
        },
      },
    },
    async (req, reply) => {
      const adminToken = req.headers["x-admin-token"];
      if (adminToken !== adminSecret)
        return reply.code(401).send({ ok: false, error: "unauthorized" });
      const exp = Date.now() + Math.max(1000, Math.min(req.body.ttlMs ?? 60_000, 5 * 60_000));
      const token = tokenManager.issue({
        jobId: req.body.jobId,
        targetNodeId: req.body.targetNodeId,
        requiredTags: req.body.requiredTags,
        exp,
      });
      return { ok: true, token, exp };
    }
  );

  app.post<{ Body: Omit<Task, "status" | "createdAt" | "schemaVersion"> }>(
    "/v1/tasks",
    {
      schema: {
        body: {
          type: "object",
          required: ["taskId", "kind", "payload"],
          properties: {
            taskId: { type: "string", minLength: 1 },
            kind: { type: "string", minLength: 1 },
            payload: { type: "object" },
            targetNodeId: { type: "string" },
            requiredTags: { type: "array", items: { type: "string" } },
            maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
            priority: { type: "integer", minimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const auth = req.headers.authorization;
      const rawToken =
        typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!rawToken) return reply.code(401).send({ ok: false, error: "missing_job_token" });

      const verify = tokenManager.verify(rawToken, {
        jobId: req.body.taskId,
        targetNodeId: req.body.targetNodeId,
        requiredTags: req.body.requiredTags,
      });
      if (!verify.ok) return reply.code(401).send({ ok: false, error: verify.error });

      const newTask: Task = {
        ...req.body,
        schemaVersion: SCHEMA_VERSION,
        status: "queued",
        createdAt: Date.now(),
      };
      await store.enqueueTask(newTask);
      ctx.emit({ type: "task.enqueued", at: Date.now(), taskId: newTask.taskId });
      return { ok: true, taskId: newTask.taskId };
    }
  );

  app.post<{ Params: { nodeId: string } }>("/v1/nodes/:nodeId/tasks/claim", async (req, reply) => {
    const jwt = extractNodeJwt(req, nodeJwtManager);
    if (!jwt.ok) return reply.code(401).send({ ok: false, error: jwt.error });
    if (jwt.nodeId !== req.params.nodeId)
      return reply.code(403).send({ ok: false, error: "token_node_mismatch" });

    const task = await store.claimTask(req.params.nodeId);
    if (task) {
      ctx.emit({
        type: "task.claimed",
        at: Date.now(),
        nodeId: req.params.nodeId,
        taskId: task.taskId,
      });
    }
    return { ok: true, task };
  });

  app.post<{ Params: { taskId: string } }>("/v1/tasks/:taskId/ack", async (req, reply) => {
    const jwt = extractNodeJwt(req, nodeJwtManager);
    if (!jwt.ok) return reply.code(401).send({ ok: false, error: jwt.error });

    const task = await store.getTask(req.params.taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task_not_found" });
    if (task.assignedNodeId !== jwt.nodeId)
      return reply.code(403).send({ ok: false, error: "token_node_mismatch" });

    await store.setTaskStatus(req.params.taskId, "running");
    ctx.emit({
      type: "task.running",
      at: Date.now(),
      taskId: req.params.taskId,
      nodeId: jwt.nodeId,
    });
    return { ok: true };
  });

  app.post<{ Params: { taskId: string }; Body: TaskResult }>(
    "/v1/tasks/:taskId/result",
    {
      schema: {
        body: {
          type: "object",
          required: ["schemaVersion", "taskId", "nodeId", "ok", "finishedAt"],
          properties: {
            schemaVersion: { type: "string" },
            taskId: { type: "string" },
            nodeId: { type: "string" },
            ok: { type: "boolean" },
            output: { type: "object" },
            error: { type: "string" },
            finishedAt: { type: "number" },
          },
        },
      },
    },
    async (req, reply) => {
      const jwt = extractNodeJwt(req, nodeJwtManager);
      if (!jwt.ok) return reply.code(401).send({ ok: false, error: jwt.error });
      if (req.body.nodeId !== jwt.nodeId)
        return reply.code(403).send({ ok: false, error: "token_node_mismatch" });

      const task = await store.getTask(req.params.taskId);
      if (!task) return reply.code(404).send({ ok: false, error: "task_not_found" });

      if (req.body.ok) {
        await store.setTaskStatus(task.taskId, "done");
        await store.setTaskResult(req.body);
        ctx.emit({
          type: "task.done",
          at: Date.now(),
          taskId: task.taskId,
          nodeId: req.body.nodeId,
        });
        return { ok: true };
      }

      const retry = computeRetryDecision({
        attempt: task.attempt ?? 1,
        maxAttempts: task.maxAttempts ?? 3,
      });

      if (retry.retry) {
        await store.requeueForRetry(task.taskId, Date.now() + retry.delayMs);
        ctx.emit({
          type: "task.failed",
          at: Date.now(),
          taskId: task.taskId,
          nodeId: req.body.nodeId,
          detail: { retrying: true, attempt: task.attempt, delayMs: retry.delayMs },
        });
        return { ok: true, retrying: true, delayMs: retry.delayMs };
      }

      await store.setTaskStatus(task.taskId, "failed");
      await store.setTaskResult(req.body);
      const dlqEntry: DlqEntry = {
        schemaVersion: SCHEMA_VERSION,
        taskId: task.taskId,
        task,
        lastResult: req.body,
        reason: "max_attempts_exhausted",
        enqueuedAt: Date.now(),
      };
      await store.enqueueDlq(dlqEntry);
      ctx.emit({
        type: "task.failed",
        at: Date.now(),
        taskId: task.taskId,
        nodeId: req.body.nodeId,
        detail: { retrying: false, toDlq: retry.toDlq },
      });
      return { ok: true, retrying: false, toDlq: true };
    }
  );

  // ── Queries ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { status?: Task["status"] } }>(
    "/v1/tasks",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["queued", "claimed", "running", "done", "failed"] },
          },
        },
      },
    },
    async (req) => ({ ok: true, tasks: await store.listTasks(req.query.status) })
  );

  app.get("/v1/tasks/queue", async () => ({ ok: true, tasks: await store.listQueuedTasks() }));
  app.get("/v1/tasks/running", async () => ({ ok: true, tasks: await store.listRunningTasks() }));

  app.get("/v1/observability/queue-depth", async () => ({
    ok: true,
    queueDepth: (await store.listTasks("queued")).length,
  }));

  app.get("/v1/observability/node-health-timeline", async () => {
    const timeline = events
      .filter(
        (e) =>
          e.type === "node.heartbeat" || e.type === "node.registered" || e.type === "node.revoked"
      )
      .map((e) => ({ at: e.at, type: e.type, nodeId: e.nodeId ?? null }));
    return { ok: true, timeline };
  });

  app.get("/v1/runs/summary", async () => {
    const [queuedTasks, claimedTasks, runningTasks, doneTasks, failedTasks] = await Promise.all([
      store.listTasks("queued"),
      store.listTasks("claimed"),
      store.listTasks("running"),
      store.listTasks("done"),
      store.listTasks("failed"),
    ]);

    const queued = queuedTasks.length;
    const claimed = claimedTasks.length;
    const running = runningTasks.length;
    const done = doneTasks.length;
    const failed = failedTasks.length;

    const finished = done + failed;
    const successRatio = finished > 0 ? done / finished : null;

    const enqueuedAt = new Map<string, number>();
    const claimLatencies: number[] = [];
    for (const e of events) {
      if (e.type === "task.enqueued" && e.taskId) enqueuedAt.set(e.taskId, e.at);
      if (e.type === "task.claimed" && e.taskId) {
        const start = enqueuedAt.get(e.taskId);
        if (typeof start === "number") claimLatencies.push(Math.max(0, e.at - start));
      }
    }
    const avgClaimLatencyMs =
      claimLatencies.length > 0
        ? Math.round(claimLatencies.reduce((s, v) => s + v, 0) / claimLatencies.length)
        : null;

    return {
      ok: true,
      totals: { queued, claimed, running, done, failed },
      metrics: {
        queueDepth: queued,
        successRatio,
        avgClaimLatencyMs,
        samples: { claimLatency: claimLatencies.length },
      },
    };
  });

  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId", async (req, reply) => {
    const task = await store.getTask(req.params.taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task_not_found" });
    return { ok: true, task, result: (await store.getTaskResult(task.taskId)) ?? null };
  });

  // ── DLQ ───────────────────────────────────────────────────────────────────

  app.get("/v1/dlq", async () => ({ ok: true, entries: await store.listDlq() }));

  app.get<{ Params: { taskId: string } }>("/v1/dlq/:taskId", async (req, reply) => {
    const entry = await store.getDlqEntry(req.params.taskId);
    if (!entry) return reply.code(404).send({ ok: false, error: "dlq_entry_not_found" });
    return { ok: true, entry };
  });

  app.post<{ Params: { taskId: string } }>("/v1/dlq/:taskId/replay", async (req, reply) => {
    const adminToken = req.headers["x-admin-token"];
    if (adminToken !== adminSecret)
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    const ok = await store.requeueFromDlq(req.params.taskId);
    if (!ok) return reply.code(404).send({ ok: false, error: "dlq_entry_not_found" });
    ctx.emit({ type: "task.enqueued", at: Date.now(), taskId: req.params.taskId });
    return { ok: true, taskId: req.params.taskId };
  });

  return app;
}

export async function startControlPlane() {
  const app = buildControlPlane();
  const host = process.env.EDGEMESH_HOST ?? "0.0.0.0";
  const port = Number(process.env.EDGEMESH_PORT ?? 8787);
  await app.listen({ host, port });
  app.log.info(`OpenClaw EdgeMesh control plane listening on http://${host}:${port}`);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startControlPlane().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
