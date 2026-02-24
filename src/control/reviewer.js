export function reviewExecution(result) {
  const codeOk = result?.status === "completed";
  const securityGate = result?.execution?.securityGate;
  const securityOk = securityGate ? securityGate.ok === true : true;

  const codeCriticalFindings = codeOk ? 0 : 1;
  const securityCriticalFindings = securityOk ? 0 : 1;

  const blockers = [];
  if (!codeOk) blockers.push("execution_failed");
  if (!securityOk) blockers.push("security_gate_failed");

  const goNoGo = blockers.length ? "NO_GO" : "GO";

  return {
    goNoGo,
    decision: goNoGo === "GO" ? "go" : "no-go",
    code: codeOk ? "pass" : "fail",
    security: securityOk ? "pass" : "fail",
    codeCriticalFindings,
    securityCriticalFindings,
    blockers,
    summary: blockers.length
      ? `NO_GO: critical findings code=${codeCriticalFindings}, security=${securityCriticalFindings}; blockers=${blockers.join(", ")}`
      : "GO: critical findings code=0, security=0",
  };
}
