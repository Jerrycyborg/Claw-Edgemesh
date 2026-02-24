import type { FastifyInstance } from "fastify";

export interface EdgeMeshEvent {
  type: string;
  at: number;
  nodeId?: string;
  taskId?: string;
  detail?: Record<string, unknown>;
}

export interface EdgeMeshPluginContext {
  emit(event: EdgeMeshEvent): void;
}

export interface EdgeMeshPlugin {
  name: string;
  register(app: FastifyInstance, ctx: EdgeMeshPluginContext): Promise<void> | void;
}
