import type { Assignment, DistrictId } from "../types";

export type SolveApiResult = {
  assignment: Record<string, number>;
  districtPops: number[];
  totalDevPct: number;
  maxAbsDevPct: number;
  contiguous: boolean;
  balanced: boolean;
  message: string;
  engine?: string;
};

export type RunSolveOptions = {
  assignment: Assignment;
  coiVtdGroups?: number[][];
  maxTotalDevPct?: number;
  steps?: number;
  seed?: number;
  signal?: AbortSignal;
};

export function apiAssignmentToAssignment(
  record: Record<string, number>,
): Assignment {
  const out: Assignment = {};
  for (const [idStr, d] of Object.entries(record)) {
    const id = Number(idStr);
    if (d >= 1 && d <= 4) out[id] = d as DistrictId;
  }
  return out;
}

export function assignmentToLockedRecord(
  assignment: Assignment,
): Record<string, number> {
  const locked: Record<string, number> = {};
  for (const [idStr, d] of Object.entries(assignment)) {
    locked[idStr] = d;
  }
  return locked;
}

export async function runSolve(
  options: RunSolveOptions,
): Promise<SolveApiResult> {
  const res = await fetch("/api/solve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locked: assignmentToLockedRecord(options.assignment),
      coiVtdGroups: options.coiVtdGroups ?? [],
      steps: options.steps ?? 80,
      maxTotalDevPct: options.maxTotalDevPct ?? 1,
      seed: options.seed ?? null,
    }),
    signal: options.signal,
  });
  if (!res.ok) {
    let detail = `Solver failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as SolveApiResult;
}
