import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { HeartbeatRequest, RegisterNodeRequest, Task, TaskResult } from "./contracts.js";
import { InMemoryControlPlaneStore, type ControlPlaneStore } from "./persistence.js";
import type { EdgeMeshEvent, EdgeMeshPlugin } from "./plugins/types.js";
import { createTelemetryPlugin } from "./plugins/telemetry-plugin.js";

const SCHEMA_VERSION = "1.0" as const;

export function buildControlPlane(
  store: ControlPlaneStore = new InMemoryControlPlaneStore(),
  options: { plugins?: EdgeMeshPlugin[] } = {}
): FastifyInstance {
  const app = Fastify({ logger: true });

  const events: EdgeMeshEvent[] = [];
  const ctx = {
    emit(event: EdgeMeshEvent) {
      events.push(event);
      if (events.length > 1000) events.shift();
    },
  };

  const plugins = options.plugins ?? [createTelemetryPlugin()];
  for (const plugin of plugins) {
    plugin.register(app, ctx);
  }

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: RegisterNodeRequest }>("/v1/nodes/register", async (req) => {
    store.upsertNode(req.body);
    ctx.emit({ type: "node.registered", at: Date.now(), nodeId: req.body.nodeId });
    return { ok: true, nodeId: req.body.nodeId };
  });

  app.get("/v1/nodes", async () => ({ nodes: store.listNodes() }));

  app.post<{ Params: { nodeId: string }; Body: HeartbeatRequest }>(
    "/v1/nodes/:nodeId/heartbeat",
    async (req, reply) => {
      const ok = store.setHeartbeat(req.params.nodeId, req.body);
      if (!ok) return reply.code(404).send({ ok: false, error: "unknown_node" });
      ctx.emit({ type: "node.heartbeat", at: Date.now(), nodeId: req.params.nodeId });
      return { ok: true };
    }
  );

  app.post<{ Body: Omit<Task, "status" | "createdAt" | "schemaVersion"> }>(
    "/v1/tasks",
    async (req) => {
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
