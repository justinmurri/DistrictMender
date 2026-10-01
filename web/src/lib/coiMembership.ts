/** Helpers to resolve COI → VTD membership for the solver. */

type Ring = number[][];

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(
  lng: number,
  lat: number,
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): boolean {
  if (geom.type === "Polygon") {
    const [outer, ...holes] = geom.coordinates;
    if (!pointInRing(lng, lat, outer)) return false;
    for (const hole of holes) {
      if (pointInRing(lng, lat, hole)) return false;
    }
    return true;
  }
  return geom.coordinates.some((poly) =>
    pointInPolygon(lng, lat, { type: "Polygon", coordinates: poly }),
  );
}

function centroidOfGeometry(
  geom: GeoJSON.Geometry,
): [number, number] | null {
  if (geom.type === "Point") {
    return [geom.coordinates[0], geom.coordinates[1]];
  }
  let ring: Ring | null = null;
  if (geom.type === "Polygon") ring = geom.coordinates[0];
  else if (geom.type === "MultiPolygon") ring = geom.coordinates[0]?.[0] ?? null;
  if (!ring || ring.length === 0) return null;
  let sx = 0;
  let sy = 0;
  const n = ring.length - 1 > 0 ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

type CentroidIndex = { id: number; lng: number; lat: number }[];

let centroidCache: CentroidIndex | null = null;

async function loadVtdCentroids(): Promise<CentroidIndex> {
  if (centroidCache) return centroidCache;
  const res = await fetch("/data/49/vtds.geojson");
  if (!res.ok) throw new Error("Failed to load VTDs for COI membership");
  const fc = (await res.json()) as GeoJSON.FeatureCollection;
  const out: CentroidIndex = [];
  for (const f of fc.features) {
    const id = Number(f.properties?.id);
    if (!Number.isFinite(id) || !f.geometry) continue;
    const c = centroidOfGeometry(f.geometry);
    if (!c) continue;
    out.push({ id, lng: c[0], lat: c[1] });
  }
  centroidCache = out;
  return out;
}

export async function resolveCoiVtdGroups(
  cois: GeoJSON.FeatureCollection<
    GeoJSON.Polygon | GeoJSON.MultiPolygon,
    { vtd_ids?: number[] }
  >,
): Promise<number[][]> {
  const centroids = await loadVtdCentroids();
  const groups: number[][] = [];
  for (const f of cois.features) {
    const stored = f.properties?.vtd_ids;
    if (Array.isArray(stored) && stored.length > 0) {
      groups.push(stored.map(Number));
      continue;
    }
    if (!f.geometry) continue;
    const ids: number[] = [];
    for (const c of centroids) {
      if (pointInPolygon(c.lng, c.lat, f.geometry)) ids.push(c.id);
    }
    if (ids.length > 0) groups.push(ids);
  }
  return groups;
}
