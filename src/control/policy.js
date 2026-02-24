export function authorize(job, node) {
  // 1) Security/policy first
  if (job.constraints.privacy === "local-only" && !node.tags.includes("local")) {
    return { ok: false, reason: "privacy-local-only" };
  }

  if (job.constraints.requiresGpu && !node.capabilities.gpu) {
    return { ok: false, reason: "gpu-required" };
  }

  if (job.constraints.requiresNpu && !node.capabilities.npu) {
    return { ok: false, reason: "npu-required" };
  }

  if (!node.health.online) {
    return { ok: false, reason: "node-offline" };
  }

  return { ok: true };
}
