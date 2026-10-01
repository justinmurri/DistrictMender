import type {
  Assignment,
  CoiCollection,
  DistrictId,
  Manifest,
  PaintUnit,
} from "../types";
import { DISTRICT_IDS } from "../types";

export function emptyPops(): Record<DistrictId, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0 };
}

export function districtPopulations(
  assignment: Assignment,
  pops: number[],
): Record<DistrictId, number> {
  const result = emptyPops();
  for (const [idStr, district] of Object.entries(assignment)) {
    const id = Number(idStr);
    result[district] += pops[id] ?? 0;
  }
  return result;
}

export function unassignedPopulation(
  totalPopulation: number,
  pops: Record<DistrictId, number>,
): number {
  const assigned = DISTRICT_IDS.reduce(
    (sum: number, d: DistrictId) => sum + pops[d],
    0,
  );
  return Math.max(0, totalPopulation - assigned);
}

export function deviationPct(pop: number, ideal: number): number {
  if (ideal === 0) return 0;
  return ((pop - ideal) / ideal) * 100;
}

export function withinDeviation(
  pop: number,
  ideal: number,
  limitPct: number,
): boolean {
  return Math.abs(deviationPct(pop, ideal)) <= limitPct;
}

/** Utah-style total deviation: (max − min) / ideal × 100. */
export function totalDeviationPct(
  pops: Record<DistrictId, number> | number[],
  ideal: number,
): number {
  if (ideal === 0) return 0;
  const values = Array.isArray(pops)
    ? pops
    : DISTRICT_IDS.map((d) => pops[d]);
  const positive = values.filter((p) => p > 0);
  if (positive.length === 0) return 0;
  return ((Math.max(...positive) - Math.min(...positive)) / ideal) * 100;
}

export function withinTotalDeviation(
  pops: Record<DistrictId, number> | number[],
  ideal: number,
  limitPct: number,
): boolean {
  return totalDeviationPct(pops, ideal) <= limitPct;
}

export function formatPop(n: number): string {
  return n.toLocaleString("en-US");
}

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch("/data/49/manifest.json");
  if (!res.ok) throw new Error(`Failed to load manifest (${res.status})`);
  return res.json() as Promise<Manifest>;
}

export async function loadVtdPops(): Promise<number[]> {
  const res = await fetch("/data/49/vtd_pops.json");
  if (!res.ok) throw new Error(`Failed to load VTD populations (${res.status})`);
  return res.json() as Promise<number[]>;
}

export type UnitIndex = {
  vtdIdsByUnitId: Map<number, number[]>;
  nameByUnitId: Map<number, string>;
  populationByUnitId: Map<number, number>;
};

function parseVtdIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map((x) => Number(x));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map((x) => Number(x));
    } catch {
      return [];
    }
  }
  return [];
}

export async function loadUnitIndex(
  unit: Exclude<PaintUnit, "vtd">,
): Promise<UnitIndex> {
  const path =
    unit === "tract" ? "/data/49/tracts.geojson" : "/data/49/counties.geojson";
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${unit} layer (${res.status})`);
  const fc = (await res.json()) as GeoJSON.FeatureCollection;
  const vtdIdsByUnitId = new Map<number, number[]>();
  const nameByUnitId = new Map<number, string>();
  const populationByUnitId = new Map<number, number>();
  for (const feature of fc.features) {
    const props = feature.properties ?? {};
    const id = Number(props.id);
    vtdIdsByUnitId.set(id, parseVtdIds(props.vtd_ids));
    nameByUnitId.set(id, String(props.name ?? `${unit} ${id}`));
    populationByUnitId.set(id, Number(props.population ?? 0));
  }
  return { vtdIdsByUnitId, nameByUnitId, populationByUnitId };
}

/** District shared by all assigned members, else null if empty/mixed. */
export function unitDistrict(
  vtdIds: number[],
  assignment: Assignment,
): DistrictId | null {
  let found: DistrictId | null = null;
  for (const id of vtdIds) {
    const d = assignment[id];
    if (d == null) continue;
    if (found == null) found = d;
    else if (found !== d) return null;
  }
  return found;
}

export function emptyCoiCollection(): CoiCollection {
  return { type: "FeatureCollection", features: [] };
}
