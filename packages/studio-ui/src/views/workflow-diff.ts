// Workflow run diff (pure): align the step outputs of two runs — the data layer for what-if fork analysis.
// A's order is authoritative; steps that exist only in B are appended at the end. equal = deep equality (JSON).

export interface WfStepOut { stepId: string; output: unknown }
export interface WfStepDiff {
  stepId: string;
  a?: unknown;
  b?: unknown;
  /** Present on both sides and the output is identical (typically true for the replayed common prefix). */
  equal: boolean;
}

export function diffWorkflowSteps(a: WfStepOut[], b: WfStepOut[]): WfStepDiff[] {
  const bMap = new Map(b.map((s) => [s.stepId, s.output]));
  const seen = new Set<string>();
  const rows: WfStepDiff[] = [];
  for (const s of a) {
    seen.add(s.stepId);
    const hasB = bMap.has(s.stepId);
    const bOut = bMap.get(s.stepId);
    rows.push({
      stepId: s.stepId,
      a: s.output,
      ...(hasB ? { b: bOut } : {}),
      equal: hasB && JSON.stringify(s.output) === JSON.stringify(bOut),
    });
  }
  for (const s of b) {
    if (!seen.has(s.stepId)) rows.push({ stepId: s.stepId, b: s.output, equal: false });
  }
  return rows;
}
