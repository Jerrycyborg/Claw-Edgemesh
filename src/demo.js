import { pickNode } from "./control/scheduler.js";
import { executeOnNode } from "./node-agent/agent.js";

const nodes = [
  {
    nodeId: "laptop-main",
    tags: ["local", "trusted"],
    latencyMs: 4,
    capabilities: { gpu: true, npu: false, ramGb: 32 },
    health: { online: true, load: 0.42, temperatureC: 66 }
  },
  {
    nodeId: "old-laptop-1",
    tags: ["local", "trusted"],
    latencyMs: 9,
    capabilities: { gpu: false, npu: false, ramGb: 16 },
    health: { online: true, load: 0.18, temperatureC: 58 }
  },
  {
    nodeId: "mini-pc",
    tags: ["trusted"],
    latencyMs: 11,
    capabilities: { gpu: false, npu: true, ramGb: 8 },
    health: { online: true, load: 0.22, temperatureC: 49 }
  }
];

const job = {
  jobId: "job-001",
  taskType: "llm",
  constraints: {
    privacy: "local-only",
    maxLatencyMs: 1200,
    requiresGpu: true,
    requiresNpu: false
  },
  payload: {
    prompt: "Draft secure deployment checklist"
  }
};

const target = pickNode(job, nodes);
if (!target) {
  console.error("No eligible node found");
  process.exit(1);
}

const result = await executeOnNode(target, job);
console.log("EdgeMesh scheduling result:");
console.log(JSON.stringify({ selectedNode: target.nodeId, result }, null, 2));
