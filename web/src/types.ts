export type DistrictId = 1 | 2 | 3 | 4;

/** Atomic unit is VTD; tract sits between VTD and county. */
export type PaintUnit = "vtd" | "tract" | "county";

export type InteractionMode = "paint" | "coi";

/** How to create a COI while in Draw COI mode. */
export type CoiDrawMode = "polygon" | "units";

export type Manifest = {
  state_fips: string;
  state_abbr: string;
  state_name: string;
  num_congressional_districts: number;
  census_year: number;
  atomic_unit?: "vtd";
  total_population: number;
  ideal_district_population: number;
  vtd_count?: number;
  tract_count?: number;
  county_count?: number;
  /** @deprecated use vtd_count */
  inhabited_block_count?: number;
  population_deviation_limit_pct: number;
  paint_units?: PaintUnit[];
};

/** District assignment keyed by VTD numeric id */
export type Assignment = Record<number, DistrictId>;

export type HoverInfo = {
  kind: PaintUnit;
  id: number;
  name?: string;
  population: number;
  geoid?: string;
  vtdCount?: number;
} | null;

export type CoiFeatureProperties = {
  id: string;
  name: string;
  /** Member VTDs when COI was built by unit selection (or resolved from polygon). */
  vtd_ids?: number[];
  source?: CoiDrawMode;
};

export type CoiCollection = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  CoiFeatureProperties
>;

export const DISTRICT_COLORS: Record<DistrictId, string> = {
  1: "#c45c26",
  2: "#2a6f6f",
  3: "#3d5a80",
  4: "#8b5a2b",
};

export const DISTRICT_IDS: DistrictId[] = [1, 2, 3, 4];

export const UNASSIGNED_COLOR = "#9aa3a0";
export const MIXED_COLOR = "#6b736f";

export const PAINT_UNITS: { id: PaintUnit; label: string }[] = [
  { id: "vtd", label: "VTD" },
  { id: "tract", label: "Tract" },
  { id: "county", label: "County" },
];

export const COI_STORAGE_KEY = "districtmender.utah.cois";
