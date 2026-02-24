import { authorize } from "./policy.js";

export function pickNode(job, nodes) {
  const candidates = [];

  for (const node of nodes) {
    const auth = authorize(job, node);
    if (!auth.ok) continue;

    // lower score is better
    const latencyPenalty = node.latencyMs;
    const loadPenalty = node.health.load * 100;
    const thermalPenalty = Math.max(0, node.health.temperatureC - 70) * 3;
    const gpuBonus = job.constraints.requiresGpu && node.capabilities.gpu ? -40 : 0;
    const npuBonus = job.constraints.requiresNpu && node.capabilities.npu ? -25 : 0;

    const score = latencyPenalty + loadPenalty + thermalPenalty + gpuBonus + npuBonus;
    candidates.push({ node, score });
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.node || null;
}
