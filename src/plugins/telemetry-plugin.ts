import type { FastifyInstance } from "fastify";
import type { EdgeMeshEvent, EdgeMeshPlugin, EdgeMeshPluginContext } from "./types.js";

export interface TelemetrySnapshot {
  counters: Record<string, number>;
  events: EdgeMeshEvent[];
}

export function createTelemetryPlugin(options: { maxEvents?: number } = {}): EdgeMeshPlugin {
  const maxEvents = options.maxEvents ?? 200;
  const counters = new Map<string, number>();
  const events: EdgeMeshEvent[] = [];

  const increment = (key: string) => counters.set(key, (counters.get(key) ?? 0) + 1);

  return {
    name: "telemetry",
    register(app: FastifyInstance, ctx: EdgeMeshPluginContext) {
      app.addHook("onResponse", async (req, reply) => {
        increment("http.requests.total");
        increment(`http.status.${reply.statusCode}`);
        increment(`http.route.${req.method}:${req.routeOptions.url}`);
      });

      const capture = (event: EdgeMeshEvent) => {
        increment(`event.${event.type}`);
        events.push(event);
        if (events.length > maxEvents) events.shift();
      };

      const originalEmit = ctx.emit;
      ctx.emit = (event) => {
        capture(event);
        originalEmit(event);
      };

      app.get("/v1/plugins/telemetry", async () => ({
        ok: true,
        plugin: "telemetry",
        counters: Object.fromEntries(counters),
        events,
      }));
    },
  };
}
