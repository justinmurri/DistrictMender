import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { unitDistrict } from "../lib/plan";
import type {
  Assignment,
  CoiCollection,
  CoiDrawMode,
  CoiFeatureProperties,
  HoverInfo,
  InteractionMode,
  PaintUnit,
} from "../types";
import {
  DISTRICT_COLORS,
  MIXED_COLOR,
  UNASSIGNED_COLOR,
} from "../types";

const UTAH_CENTER: [number, number] = [-111.55, 39.4];
const UTAH_ZOOM = 6.2;
const COI_FILL = "#1f6b5c";

type UnitIndexMaps = {
  tract: Map<number, number[]>;
  county: Map<number, number[]>;
};

type Props = {
  assignment: Assignment;
  paintUnit: PaintUnit;
  interactionMode: InteractionMode;
  coiDrawMode: CoiDrawMode;
  unitVtdIds: UnitIndexMaps;
  cois: CoiCollection;
  finishUnitCoiSignal: number;
  onPaintUnit: (payload: {
    kind: PaintUnit;
    unitId: number;
    vtdIds: number[];
  }) => void;
  onHover: (info: HoverInfo) => void;
  onCoisChange: (cois: CoiCollection) => void;
  onUnitCoiDraftCount: (count: number) => void;
};

const FILL_COLOR: maplibregl.ExpressionSpecification = [
  "match",
  ["coalesce", ["feature-state", "district"], 0],
  1,
  DISTRICT_COLORS[1],
  2,
  DISTRICT_COLORS[2],
  3,
  DISTRICT_COLORS[3],
  4,
  DISTRICT_COLORS[4],
  9,
  MIXED_COLOR,
  UNASSIGNED_COLOR,
];

function layerId(unit: PaintUnit, kind: "fill" | "outline"): string {
  return `${unit}-${kind}`;
}

function sourceId(unit: PaintUnit): string {
  return unit === "vtd" ? "vtds" : unit === "tract" ? "tracts" : "counties";
}

function syncVtdAssignment(
  map: maplibregl.Map,
  prev: Assignment,
  next: Assignment,
): Assignment {
  for (const idStr of Object.keys(prev)) {
    const id = Number(idStr);
    if (!(id in next)) {
      map.setFeatureState({ source: "vtds", id }, { district: 0 });
    }
  }
  for (const [idStr, district] of Object.entries(next)) {
    const id = Number(idStr);
    if (prev[id] !== district) {
      map.setFeatureState({ source: "vtds", id }, { district });
    }
  }
  return { ...next };
}

function syncParentColors(
  map: maplibregl.Map,
  unit: Exclude<PaintUnit, "vtd">,
  vtdIdsByUnit: Map<number, number[]>,
  assignment: Assignment,
) {
  const source = sourceId(unit);
  for (const [unitId, vtdIds] of vtdIdsByUnit) {
    const district = unitDistrict(vtdIds, assignment);
    const code =
      district ?? (vtdIds.some((id) => assignment[id] != null) ? 9 : 0);
    map.setFeatureState({ source, id: unitId }, { district: code });
  }
}

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

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function draftCollection(
  ring: [number, number][],
): GeoJSON.FeatureCollection {
  if (ring.length === 0) return emptyFc();
  const features: GeoJSON.Feature[] = ring.map((coordinates) => ({
    type: "Feature",
    properties: { kind: "vertex" },
    geometry: { type: "Point", coordinates },
  }));
  if (ring.length === 2) {
    features.push({
      type: "Feature",
      properties: { kind: "edge" },
      geometry: { type: "LineString", coordinates: ring },
    });
  } else if (ring.length >= 3) {
    const closed = [...ring, ring[0]];
    features.push({
      type: "Feature",
      properties: { kind: "fill" },
      geometry: { type: "Polygon", coordinates: [closed] },
    });
  }
  return { type: "FeatureCollection", features };
}

export function MapView({
  assignment,
  paintUnit,
  interactionMode,
  coiDrawMode,
  unitVtdIds,
  cois,
  finishUnitCoiSignal,
  onPaintUnit,
  onHover,
  onCoisChange,
  onUnitCoiDraftCount,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const prevAssignment = useRef<Assignment>({});
  const assignmentRef = useRef(assignment);
  const paintUnitRef = useRef(paintUnit);
  const modeRef = useRef(interactionMode);
  const coiDrawModeRef = useRef(coiDrawMode);
  const unitIdsRef = useRef(unitVtdIds);
  const coisRef = useRef(cois);
  const draftRing = useRef<[number, number][]>([]);
  const draftUnitVtds = useRef<Set<number>>(new Set());
  const draftUnitGeoms = useRef<
    Map<number, GeoJSON.Polygon | GeoJSON.MultiPolygon>
  >(new Map());
  const callbacks = useRef({
    onPaintUnit,
    onHover,
    onCoisChange,
    onUnitCoiDraftCount,
  });

  assignmentRef.current = assignment;
  paintUnitRef.current = paintUnit;
  modeRef.current = interactionMode;
  coiDrawModeRef.current = coiDrawMode;
  unitIdsRef.current = unitVtdIds;
  coisRef.current = cois;
  callbacks.current = {
    onPaintUnit,
    onHover,
    onCoisChange,
    onUnitCoiDraftCount,
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    function setDraftSource(map: maplibregl.Map) {
      const src = map.getSource("coi-draft") as maplibregl.GeoJSONSource | undefined;
      src?.setData(draftCollection(draftRing.current));
    }

    function setUnitDraftSource(map: maplibregl.Map) {
      const features: GeoJSON.Feature[] = [];
      for (const [, geom] of draftUnitGeoms.current) {
        features.push({
          type: "Feature",
          properties: { kind: "unit" },
          geometry: geom,
        });
      }
      const src = map.getSource("coi-draft") as maplibregl.GeoJSONSource | undefined;
      src?.setData({ type: "FeatureCollection", features });
      callbacks.current.onUnitCoiDraftCount(draftUnitVtds.current.size);
    }

    function clearUnitDraft(map: maplibregl.Map) {
      draftUnitVtds.current = new Set();
      draftUnitGeoms.current = new Map();
      setUnitDraftSource(map);
    }

    function finishUnitDraft(map: maplibregl.Map) {
      const vtdIds = [...draftUnitVtds.current];
      if (vtdIds.length === 0) return;
      const geoms = [...draftUnitGeoms.current.values()];
      let geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
      if (geoms.length === 1) {
        geometry = geoms[0];
      } else {
        const polys: GeoJSON.Position[][][] = [];
        for (const g of geoms) {
          if (g.type === "Polygon") polys.push(g.coordinates);
          else polys.push(...g.coordinates);
        }
        geometry = { type: "MultiPolygon", coordinates: polys };
      }
      const id = `coi-${crypto.randomUUID()}`;
      const feature: GeoJSON.Feature<
        GeoJSON.Polygon | GeoJSON.MultiPolygon,
        CoiFeatureProperties
      > = {
        type: "Feature",
        properties: {
          id,
          name: `Community ${coisRef.current.features.length + 1}`,
          vtd_ids: vtdIds,
          source: "units",
        },
        geometry,
      };
      clearUnitDraft(map);
      callbacks.current.onCoisChange({
        type: "FeatureCollection",
        features: [...coisRef.current.features, feature],
      });
    }

    function finishDraft(map: maplibregl.Map) {
      const ring = draftRing.current;
      if (ring.length < 3) {
        draftRing.current = [];
        setDraftSource(map);
        return;
      }
      const closed = [...ring, ring[0]];
      const id = `coi-${crypto.randomUUID()}`;
      const feature: GeoJSON.Feature<
        GeoJSON.Polygon,
        CoiFeatureProperties
      > = {
        type: "Feature",
        properties: {
          id,
          name: `Community ${coisRef.current.features.length + 1}`,
          source: "polygon",
        },
        geometry: { type: "Polygon", coordinates: [closed] },
      };
      draftRing.current = [];
      setDraftSource(map);
      callbacks.current.onCoisChange({
        type: "FeatureCollection",
        features: [...coisRef.current.features, feature],
      });
    }

    function onMapReady(map: maplibregl.Map) {
      if (cancelled || readyRef.current) return;

      map.addControl(
        new maplibregl.NavigationControl({ showCompass: false }),
        "top-right",
      );

      map.addSource("vtds", {
        type: "geojson",
        data: "/data/49/vtds.geojson",
        promoteId: "id",
      });
      map.addSource("tracts", {
        type: "geojson",
        data: "/data/49/tracts.geojson",
        promoteId: "id",
      });
      map.addSource("counties", {
        type: "geojson",
        data: "/data/49/counties.geojson",
        promoteId: "id",
      });
      map.addSource("cois", {
        type: "geojson",
        data: coisRef.current,
      });
      map.addSource("coi-draft", {
        type: "geojson",
        data: emptyFc(),
      });

      for (const unit of ["county", "tract", "vtd"] as PaintUnit[]) {
        const source = sourceId(unit);
        const initialVis =
          unit === paintUnitRef.current ? "visible" : "none";
        map.addLayer({
          id: layerId(unit, "fill"),
          type: "fill",
          source,
          layout: { visibility: initialVis },
          paint: {
            "fill-color": FILL_COLOR,
            "fill-opacity": [
              "case",
              ["boolean", ["feature-state", "hover"], false],
              0.92,
              unit === "vtd" ? 0.75 : 0.7,
            ],
          },
        });
        map.addLayer({
          id: layerId(unit, "outline"),
          type: "line",
          source,
          layout: { visibility: initialVis },
          paint: {
            "line-color": "#1c2420",
            "line-width":
              unit === "county" ? 1.2 : unit === "tract" ? 0.8 : 0.45,
            "line-opacity": 0.4,
          },
        });
      }

      map.addLayer({
        id: "cois-fill",
        type: "fill",
        source: "cois",
        paint: {
          "fill-color": COI_FILL,
          "fill-opacity": 0.22,
        },
      });
      map.addLayer({
        id: "cois-outline",
        type: "line",
        source: "cois",
        paint: {
          "line-color": COI_FILL,
          "line-width": 2,
        },
      });
      map.addLayer({
        id: "coi-draft-fill",
        type: "fill",
        source: "coi-draft",
        filter: [
          "any",
          ["==", ["geometry-type"], "Polygon"],
          ["==", ["geometry-type"], "MultiPolygon"],
        ],
        paint: {
          "fill-color": COI_FILL,
          "fill-opacity": 0.18,
        },
      });
      map.addLayer({
        id: "coi-draft-line",
        type: "line",
        source: "coi-draft",
        filter: [
          "any",
          ["==", ["geometry-type"], "LineString"],
          ["==", ["geometry-type"], "Polygon"],
          ["==", ["geometry-type"], "MultiPolygon"],
        ],
        paint: {
          "line-color": COI_FILL,
          "line-width": 2,
          "line-dasharray": [2, 1],
        },
      });
      map.addLayer({
        id: "coi-draft-points",
        type: "circle",
        source: "coi-draft",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 6,
          "circle-color": COI_FILL,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });

      readyRef.current = true;
      prevAssignment.current = syncVtdAssignment(
        map,
        prevAssignment.current,
        assignmentRef.current,
      );
      if (unitIdsRef.current.tract.size > 0) {
        syncParentColors(
          map,
          "tract",
          unitIdsRef.current.tract,
          assignmentRef.current,
        );
      }
      if (unitIdsRef.current.county.size > 0) {
        syncParentColors(
          map,
          "county",
          unitIdsRef.current.county,
          assignmentRef.current,
        );
      }

      let hovered: { source: string; id: number } | null = null;

      const clearHover = () => {
        if (hovered) {
          map.setFeatureState(
            { source: hovered.source, id: hovered.id },
            { hover: false },
          );
          hovered = null;
        }
        if (modeRef.current === "paint") {
          map.getCanvas().style.cursor = "";
        }
        callbacks.current.onHover(null);
      };

      const featuresAt = (point: { x: number; y: number }, unit: PaintUnit) => {
        const pad = unit === "county" ? 6 : 12;
        return map.queryRenderedFeatures(
          [
            [point.x - pad, point.y - pad],
            [point.x + pad, point.y + pad],
          ],
          { layers: [layerId(unit, "fill")] },
        );
      };

      map.on("mousemove", (e) => {
        if (modeRef.current === "coi" && coiDrawModeRef.current === "polygon") {
          clearHover();
          map.getCanvas().style.cursor = "crosshair";
          return;
        }
        if (modeRef.current !== "paint" && !(modeRef.current === "coi" && coiDrawModeRef.current === "units")) {
          clearHover();
          return;
        }
        const unit = paintUnitRef.current;
        const feature = featuresAt(e.point, unit)[0];
        if (!feature || feature.id == null) {
          clearHover();
          return;
        }
        const source = sourceId(unit);
        const id = Number(feature.id);
        map.getCanvas().style.cursor = "pointer";
        if (hovered && (hovered.source !== source || hovered.id !== id)) {
          map.setFeatureState(
            { source: hovered.source, id: hovered.id },
            { hover: false },
          );
        }
        hovered = { source, id };
        map.setFeatureState({ source, id }, { hover: true });

        const props = feature.properties ?? {};
        if (unit === "vtd") {
          callbacks.current.onHover({
            kind: "vtd",
            id,
            name: String(props.name ?? ""),
            population: Number(props.population ?? 0),
            geoid: String(props.vtd_geoid ?? ""),
          });
        } else {
          callbacks.current.onHover({
            kind: unit,
            id,
            name: String(props.name ?? ""),
            population: Number(props.population ?? 0),
            vtdCount: Number(props.vtd_count ?? 0),
          });
        }
      });

      map.on("mouseout", clearHover);

      map.on("click", (e) => {
        if (modeRef.current === "coi" && coiDrawModeRef.current === "polygon") {
          draftRing.current = [
            ...draftRing.current,
            [e.lngLat.lng, e.lngLat.lat],
          ];
          setDraftSource(map);
          return;
        }

        const unit = paintUnitRef.current;
        const feature = featuresAt(e.point, unit)[0];
        if (!feature?.properties || feature.id == null) return;
        const unitId = Number(feature.id);
        const props = feature.properties;

        let vtdIds: number[];
        if (unit === "vtd") {
          vtdIds = [unitId];
        } else {
          const fromIndex =
            unit === "tract"
              ? unitIdsRef.current.tract.get(unitId)
              : unitIdsRef.current.county.get(unitId);
          vtdIds = fromIndex ?? parseVtdIds(props.vtd_ids);
        }

        if (modeRef.current === "coi" && coiDrawModeRef.current === "units") {
          if (vtdIds.length === 0) return;
          const allIn = vtdIds.every((id) => draftUnitVtds.current.has(id));
          if (allIn) {
            for (const id of vtdIds) {
              draftUnitVtds.current.delete(id);
              draftUnitGeoms.current.delete(id);
            }
            // Also drop unit-level geom keyed by negative unit id if stored
            draftUnitGeoms.current.delete(-unitId - 1);
          } else {
            for (const id of vtdIds) draftUnitVtds.current.add(id);
            const geom = feature.geometry;
            if (geom && (geom.type === "Polygon" || geom.type === "MultiPolygon")) {
              draftUnitGeoms.current.set(
                unit === "vtd" ? unitId : -unitId - 1,
                geom as GeoJSON.Polygon | GeoJSON.MultiPolygon,
              );
            }
          }
          setUnitDraftSource(map);
          return;
        }

        if (vtdIds.length === 0) {
          callbacks.current.onHover({
            kind: unit,
            id: unitId,
            name: String(props.name ?? ""),
            population: Number(props.population ?? 0),
            vtdCount: 0,
          });
          return;
        }
        callbacks.current.onPaintUnit({ kind: unit, unitId, vtdIds });
      });

      map.on("dblclick", (e) => {
        if (modeRef.current !== "coi" || coiDrawModeRef.current !== "polygon")
          return;
        e.preventDefault();
        if (draftRing.current.length > 1) {
          draftRing.current = draftRing.current.slice(0, -1);
        }
        finishDraft(map);
      });

      const onKey = (ev: KeyboardEvent) => {
        if (modeRef.current !== "coi") return;
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (coiDrawModeRef.current === "polygon") finishDraft(map);
          else finishUnitDraft(map);
        } else if (ev.key === "Escape") {
          draftRing.current = [];
          setDraftSource(map);
          clearUnitDraft(map);
        }
      };
      window.addEventListener("keydown", onKey);
      map.once("remove", () => window.removeEventListener("keydown", onKey));

      // Expose finish for unit COI via custom event on map container
      (map as unknown as { __finishUnitCoi?: () => void }).__finishUnitCoi = () =>
        finishUnitDraft(map);
    }

    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#e7ebe6" },
          },
        ],
      },
      center: UTAH_CENTER,
      zoom: UTAH_ZOOM,
      maxZoom: 14,
      minZoom: 5,
      attributionControl: { compact: true },
    });

    mapRef.current = map;
    map.on("error", (e) => {
      console.error("MapLibre error", e.error);
    });

    map.once("load", () => onMapReady(map));
    if (map.loaded()) onMapReady(map);

    return () => {
      cancelled = true;
      readyRef.current = false;
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    for (const unit of ["vtd", "tract", "county"] as PaintUnit[]) {
      const vis = unit === paintUnit ? "visible" : "none";
      if (!map.getLayer(layerId(unit, "fill"))) continue;
      map.setLayoutProperty(layerId(unit, "fill"), "visibility", vis);
      map.setLayoutProperty(layerId(unit, "outline"), "visibility", vis);
    }
  }, [paintUnit, unitVtdIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    prevAssignment.current = syncVtdAssignment(
      map,
      prevAssignment.current,
      assignment,
    );
    if (unitVtdIds.tract.size > 0) {
      syncParentColors(map, "tract", unitVtdIds.tract, assignment);
    }
    if (unitVtdIds.county.size > 0) {
      syncParentColors(map, "county", unitVtdIds.county, assignment);
    }
  }, [assignment, unitVtdIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const canvas = map.getCanvas();
    if (interactionMode === "coi") {
      if (coiDrawMode === "polygon") {
        map.doubleClickZoom.disable();
        canvas.style.cursor = "crosshair";
      } else {
        map.doubleClickZoom.enable();
        canvas.style.cursor = "";
        draftRing.current = [];
        const src = map.getSource("coi-draft") as
          | maplibregl.GeoJSONSource
          | undefined;
        // Keep unit draft; clear polygon vertices only
        if (draftUnitVtds.current.size === 0) src?.setData(emptyFc());
        else {
          const features: GeoJSON.Feature[] = [];
          for (const [, geom] of draftUnitGeoms.current) {
            features.push({
              type: "Feature",
              properties: { kind: "unit" },
              geometry: geom,
            });
          }
          src?.setData({ type: "FeatureCollection", features });
        }
      }
    } else {
      map.doubleClickZoom.enable();
      canvas.style.cursor = "";
      draftRing.current = [];
      draftUnitVtds.current = new Set();
      draftUnitGeoms.current = new Map();
      const src = map.getSource("coi-draft") as maplibregl.GeoJSONSource | undefined;
      src?.setData(emptyFc());
      onUnitCoiDraftCount(0);
    }
  }, [interactionMode, coiDrawMode, onUnitCoiDraftCount]);

  useEffect(() => {
    if (!finishUnitCoiSignal) return;
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const finish = (map as unknown as { __finishUnitCoi?: () => void })
      .__finishUnitCoi;
    finish?.();
  }, [finishUnitCoiSignal]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource("cois") as maplibregl.GeoJSONSource | undefined;
    src?.setData(cois);
  }, [cois]);

  return (
    <div
      className="map-root"
      ref={containerRef}
      aria-label="Utah redistricting map"
      data-mode={interactionMode}
      data-coi-draw={coiDrawMode}
    />
  );
}
