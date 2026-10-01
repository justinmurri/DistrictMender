import { useCallback, useEffect, useMemo, useState } from "react";
import { MapView } from "./components/MapView";
import { SidePanel } from "./components/SidePanel";
import { resolveCoiVtdGroups } from "./lib/coiMembership";
import {
  districtPopulations,
  emptyCoiCollection,
  loadManifest,
  loadUnitIndex,
  loadVtdPops,
  unassignedPopulation,
} from "./lib/plan";
import type {
  Assignment,
  CoiCollection,
  CoiDrawMode,
  DistrictId,
  HoverInfo,
  InteractionMode,
  Manifest,
  PaintUnit,
} from "./types";
import { COI_STORAGE_KEY } from "./types";
import { apiAssignmentToAssignment, runSolve } from "./solver/client";

function loadStoredCois(): CoiCollection {
  try {
    const raw = localStorage.getItem(COI_STORAGE_KEY);
    if (!raw) return emptyCoiCollection();
    const parsed = JSON.parse(raw) as CoiCollection;
    if (parsed?.type === "FeatureCollection" && Array.isArray(parsed.features)) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return emptyCoiCollection();
}

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [vtdPops, setVtdPops] = useState<number[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDistrict, setSelectedDistrict] = useState<DistrictId>(1);
  const [paintUnit, setPaintUnit] = useState<PaintUnit>("county");
  const [interactionMode, setInteractionMode] =
    useState<InteractionMode>("paint");
  const [coiDrawMode, setCoiDrawMode] = useState<CoiDrawMode>("polygon");
  const [assignment, setAssignment] = useState<Assignment>({});
  const [hover, setHover] = useState<HoverInfo>(null);
  const [cois, setCois] = useState<CoiCollection>(loadStoredCois);
  const [unitVtdIds, setUnitVtdIds] = useState<{
    tract: Map<number, number[]>;
    county: Map<number, number[]>;
  }>({ tract: new Map(), county: new Map() });
  const [solving, setSolving] = useState(false);
  const [solveMessage, setSolveMessage] = useState<string | null>(null);
  const [unitCoiDraftCount, setUnitCoiDraftCount] = useState(0);
  const [finishUnitCoiSignal, setFinishUnitCoiSignal] = useState(0);

  useEffect(() => {
    Promise.all([
      loadManifest(),
      loadVtdPops(),
      loadUnitIndex("tract"),
      loadUnitIndex("county"),
    ])
      .then(([m, pops, tract, county]) => {
        setManifest(m);
        setVtdPops(pops);
        setUnitVtdIds({
          tract: tract.vtdIdsByUnitId,
          county: county.vtdIdsByUnitId,
        });
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load data");
      });
  }, []);

  useEffect(() => {
    localStorage.setItem(COI_STORAGE_KEY, JSON.stringify(cois));
  }, [cois]);

  const pops = useMemo(
    () => districtPopulations(assignment, vtdPops),
    [assignment, vtdPops],
  );

  const unassigned = useMemo(() => {
    if (!manifest) return 0;
    return unassignedPopulation(manifest.total_population, pops);
  }, [manifest, pops]);

  const onPaintUnit = useCallback(
    ({ vtdIds }: { kind: PaintUnit; unitId: number; vtdIds: number[] }) => {
      if (vtdIds.length === 0) return;
      setAssignment((prev) => {
        const allActive = vtdIds.every((id) => prev[id] === selectedDistrict);
        const next = { ...prev };
        if (allActive) {
          for (const id of vtdIds) delete next[id];
        } else {
          for (const id of vtdIds) next[id] = selectedDistrict;
        }
        return next;
      });
    },
    [selectedDistrict],
  );

  const onClear = useCallback(() => {
    setAssignment({});
    setSolveMessage(null);
  }, []);

  const onAutoComplete = useCallback(async () => {
    if (solving) return;
    setSolving(true);
    setSolveMessage("Running GerryChain…");
    try {
      const coiVtdGroups = await resolveCoiVtdGroups(cois);
      const result = await runSolve({
        assignment,
        coiVtdGroups,
        maxTotalDevPct: manifest?.population_deviation_limit_pct ?? 1,
        steps: 80,
        seed: Date.now() % 1_000_000,
      });
      setAssignment(apiAssignmentToAssignment(result.assignment));
      setSolveMessage(result.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Solver failed";
      setSolveMessage(
        msg.includes("Failed to fetch") || msg.includes("NetworkError")
          ? "Solver API unreachable. Start it with: cd solver && uvicorn server:app --port 8765"
          : msg,
      );
    } finally {
      setSolving(false);
    }
  }, [assignment, cois, manifest, solving]);

  const onRenameCoi = useCallback((id: string, name: string) => {
    setCois((prev) => ({
      ...prev,
      features: prev.features.map((f) =>
        f.properties.id === id
          ? { ...f, properties: { ...f.properties, name } }
          : f,
      ),
    }));
  }, []);

  const onDeleteCoi = useCallback((id: string) => {
    setCois((prev) => ({
      ...prev,
      features: prev.features.filter((f) => f.properties.id !== id),
    }));
  }, []);

  const dataReady = manifest != null && vtdPops.length > 0;

  return (
    <div className="app-shell">
      <SidePanel
        manifest={manifest}
        selectedDistrict={selectedDistrict}
        onSelectDistrict={setSelectedDistrict}
        paintUnit={paintUnit}
        onPaintUnitChange={setPaintUnit}
        interactionMode={interactionMode}
        onInteractionModeChange={setInteractionMode}
        coiDrawMode={coiDrawMode}
        onCoiDrawModeChange={setCoiDrawMode}
        onFinishUnitCoi={() => setFinishUnitCoiSignal((n) => n + 1)}
        unitCoiDraftCount={unitCoiDraftCount}
        pops={pops}
        unassigned={unassigned}
        assignedVtdCount={Object.keys(assignment).length}
        hover={hover}
        cois={cois}
        onRenameCoi={onRenameCoi}
        onDeleteCoi={onDeleteCoi}
        onClear={onClear}
        onAutoComplete={onAutoComplete}
        solving={solving}
        solveMessage={solveMessage}
      />
      <main className="map-stage">
        {loadError && <div className="banner error">{loadError}</div>}
        {!dataReady && !loadError && (
          <div className="banner">Loading Utah census data…</div>
        )}
        <MapView
          assignment={assignment}
          paintUnit={paintUnit}
          interactionMode={interactionMode}
          coiDrawMode={coiDrawMode}
          unitVtdIds={unitVtdIds}
          cois={cois}
          finishUnitCoiSignal={finishUnitCoiSignal}
          onPaintUnit={onPaintUnit}
          onHover={setHover}
          onCoisChange={setCois}
          onUnitCoiDraftCount={setUnitCoiDraftCount}
        />
      </main>
    </div>
  );
}
