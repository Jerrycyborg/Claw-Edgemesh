export interface ReviewDecision {
  goNoGo: "GO" | "NO_GO";
  code: "pass" | "fail";
  security: "pass" | "fail";
  blockers: string[];
  summary: string;
}

export function reviewExecution(result: any): ReviewDecision;
