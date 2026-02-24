import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { HeartbeatRequest, RegisterNodeRequest, Task, TaskResult } from "./contracts.js";
import { InMemoryControlPlaneStore, type ControlPlaneStore } from "./persistence.js";
import type { EdgeMeshEvent, EdgeMeshPlugin } from "./plugins/types.js";
import { createTelemetryPlugin } from "./plugins/telemetry-plugin.js";
import { JobTokenManager, NodeTrustManager } from "./security.js";

const SCHEMA_VERSION = "1.0" as const;

export function buildControlPlane(
  store: ControlPlaneStore = new InMemoryControlPlaneStore(),
  options: { plugins?: EdgeMeshPlugin[] } = {}
): FastifyInstance {
  const app = Fastify({ logger: true });

  const tokenManager = new JobTokenManager();
  const trustManager = new NodeTrustManager();

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

  app.post<{ Body: RegisterNodeRequest }>("/v1/nodes/register", async (req, reply) => {
    const bootstrapToken = req.headers["x-bootstrap-token"];
    const ok = trustManager.trustNode(
      req.body.nodeId,
      typeof bootstrapToken === "string" ? bootstrapToken : undefined
    );
    if (!ok) return reply.code(401).send({ ok: false, error: "node_bootstrap_denied" });

    store.upsertNode(req.body);
    store.setNodeTrust(req.body.nodeId, { trusted: true, revoked: false });
    ctx.emit({ type: "node.registered", at: Date.now(), nodeId: req.body.nodeId });
    return { ok: true, nodeId: req.body.nodeId, trusted: true };
  });

  app.post<{ Params: { nodeId: string } }>("/v1/nodes/:nodeId/revoke", async (req) => {
    trustManager.revokeNode(req.params.nodeId);
    store.setNodeTrust(req.params.nodeId, { trusted: false, revoked: true });
    ctx.emit({ type: "node.revoked", at: Date.now(), nodeId: req.params.nodeId });
    return { ok: true };
  });

  app.get("/v1/nodes", async () => ({ nodes: store.listNodes() }));

  app.post<{ Params: { nodeId: string }; Body: HeartbeatRequest }>(
    "/v1/nodes/:nodeId/heartbeat",
    async (req, reply) => {
      if (trustManager.isRevoked(req.params.nodeId)) {
        return reply.code(403).send({ ok: false, error: "node_revoked" });
      }
      const ok = store.setHeartbeat(req.params.nodeId, req.body);
      if (!ok) return reply.code(404).send({ ok: false, error: "unknown_node" });
      ctx.emit({ type: "node.heartbeat", at: Date.now(), nodeId: req.params.nodeId });
      return { ok: true };
    }
  );

  app.post<{
    Body: { jobId: string; targetNodeId?: string; requiredTags?: string[]; ttlMs?: number };
  }>("/v1/auth/job-token", async (req) => {
    const exp = Date.now() + Math.max(1000, Math.min(req.body.ttlMs ?? 60_000, 5 * 60_000));
    const token = tokenManager.issue({
      jobId: req.body.jobId,
      targetNodeId: req.body.targetNodeId,
      requiredTags: req.body.requiredTags,
      exp,
    });
    return { ok: true, token, exp };
  });

  app.post<{ Body: Omit<Task, "status" | "createdAt" | "schemaVersion"> }>(
    "/v1/tasks",
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
      store.enqueueTask(newTask);
      ctx.emit({ type: "task.enqueued", at: Date.now(), taskId: newTask.taskId });
      return { ok: true, taskId: newTask.taskId };
    }
  );

  app.post<{ Params: { nodeId: string } }>("/v1/nodes/:nodeId/tasks/claim", async (req) => {
    const task = store.claimTask(req.params.nodeId);
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
    const task = store.setTaskStatus(req.params.taskId, "running");
    if (!task) return reply.code(404).send({ ok: false, error: "task_not_found" });
    ctx.emit({
      type: "task.running",
      at: Date.now(),
      taskId: req.params.taskId,
      nodeId: task.assignedNodeId,
    });
    return { ok: true };
  });

  app.post<{ Params: { taskId: string }; Body: TaskResult }>(
    "/v1/tasks/:taskId/result",
    async (req, reply) => {
      const task = store.getTask(req.params.taskId);
      if (!task) return reply.code(404).send({ ok: false, error: "task_not_found" });

      store.setTaskStatus(task.taskId, req.body.ok ? "done" : "failed");
      store.setTaskResult(req.body);
      ctx.emit({
        type: req.body.ok ? "task.done" : "task.failed",
        at: Date.now(),
        taskId: task.taskId,
        nodeId: req.body.nodeId,
      });
      return { ok: true };
    }
  );

  app.get("/v1/tasks", async (req: any) => {
    const status = req.query?.status as Task["status"] | undefined;
    return { ok: true, tasks: store.listTasks(status) };
  });

  app.get("/v1/tasks/queue", async () => ({ ok: true, tasks: store.listQueuedTasks() }));
  app.get("/v1/tasks/running", async () => ({ ok: true, tasks: store.listRunningTasks() }));

  app.get("/v1/observability/queue-depth", async () => ({
    ok: true,
    queueDepth: store.listTasks("queued").length,
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
    const queued = store.listTasks("queued").length;
    const claimed = store.listTasks("claimed").length;
    const running = store.listTasks("running").length;
    const done = store.listTasks("done").length;
    const failed = store.listTasks("failed").length;

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
        ? Math.round(claimLatencies.reduce((sum, v) => sum + v, 0) / claimLatencies.length)
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
    const task = store.getTask(req.params.taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task_not_found" });
    return { ok: true, task, result: store.getTaskResult(task.taskId) ?? null };
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
