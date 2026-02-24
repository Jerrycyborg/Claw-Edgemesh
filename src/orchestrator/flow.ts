export type StageStatus = "passed" | "failed";

export interface StageResult {
  stage: "security-tests" | "implementation" | "review";
  status: StageStatus;
  details: string;
}

export interface ReviewerInput {
  codeCriticalFindings: number;
  securityCriticalFindings: number;
  notes?: string;
}

export interface FinalReview {
  go: boolean;
  decision: "go" | "no-go";
  rationale: string;
}

export interface OrchestratorState {
  securityPassed: boolean;
  implementationPassed: boolean;
  reviewer: ReviewerInput;
}

export interface OrchestratorOutcome {
  completed: boolean;
  stages: StageResult[];
  finalReview: FinalReview;
}

export function runOrchestratorFlow(state: OrchestratorState): OrchestratorOutcome {
  const stages: StageResult[] = [];

  stages.push({
    stage: "security-tests",
    status: state.securityPassed ? "passed" : "failed",
    details: state.securityPassed ? "Mandatory security tests passed." : "Mandatory security tests failed.",
  });

  if (!state.securityPassed) {
    return {
      completed: false,
      stages,
      finalReview: {
        go: false,
        decision: "no-go",
        rationale: "Security gate failed; orchestration cannot complete.",
      },
    };
  }

  stages.push({
    stage: "implementation",
    status: state.implementationPassed ? "passed" : "failed",
    details: state.implementationPassed ? "Implementation stage passed." : "Implementation stage failed.",
  });

  const criticalFindings = state.reviewer.codeCriticalFindings + state.reviewer.securityCriticalFindings;
  const reviewerPass = criticalFindings === 0;

  stages.push({
    stage: "review",
    status: reviewerPass ? "passed" : "failed",
    details: reviewerPass
      ? "Final reviewer found no critical code/security findings."
      : `Final reviewer blocked release with ${criticalFindings} critical findings.`,
  });

  const go = state.securityPassed && state.implementationPassed && reviewerPass;

  return {
    completed: go,
    stages,
    finalReview: {
      go,
      decision: go ? "go" : "no-go",
      rationale: go
        ? "Mandatory security gate passed and final critical code+security review approved."
        : "Release blocked by failed implementation and/or critical reviewer findings.",
    },
  };
}
