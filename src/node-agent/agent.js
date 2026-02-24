export async function executeOnNode(node, job) {
  // Prototype execution stub
  const startedAt = new Date().toISOString();
  await sleep(80);

  return {
    nodeId: node.nodeId,
    jobId: job.jobId,
    status: "completed",
    startedAt,
    completedAt: new Date().toISOString(),
    output: {
      summary: `Executed ${job.taskType} on ${node.nodeId}`
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
