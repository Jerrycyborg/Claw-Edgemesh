export function reviewExecution(result) {
  const codeOk = result?.status === "completed";
  const securityGate = result?.execution?.securityGate;
  const securityOk = securityGate ? securityGate.ok === true : true;

  const blockers = [];
  if (!codeOk) blockers.push("execution_failed");
  if (!securityOk) blockers.push("security_gate_failed");

  return {
    goNoGo: blockers.length ? "NO_GO" : "GO",
    code: codeOk ? "pass" : "fail",
    security: securityOk ? "pass" : "fail",
    blockers,
    summary: blockers.length
      ? `NO_GO: ${blockers.join(", ")}`
      : "GO: code + security checks passed",
  };
}
