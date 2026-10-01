import type { CSSProperties } from "react";
import type {
  CoiCollection,
  CoiDrawMode,
  DistrictId,
  HoverInfo,
  InteractionMode,
  Manifest,
  PaintUnit,
} from "../types";
import { DISTRICT_COLORS, DISTRICT_IDS, PAINT_UNITS } from "../types";
import {
  deviationPct,
  formatPop,
  totalDeviationPct,
  withinDeviation,
  withinTotalDeviation,
} from "../lib/plan";

type Props = {
  manifest: Manifest | null;
  selectedDistrict: DistrictId;
  onSelectDistrict: (d: DistrictId) => void;
  paintUnit: PaintUnit;
  onPaintUnitChange: (u: PaintUnit) => void;
  interactionMode: InteractionMode;
  onInteractionModeChange: (m: InteractionMode) => void;
  coiDrawMode: CoiDrawMode;
  onCoiDrawModeChange: (m: CoiDrawMode) => void;
  onFinishUnitCoi: () => void;
  unitCoiDraftCount: number;
  pops: Record<DistrictId, number>;
  unassigned: number;
  assignedVtdCount: number;
  hover: HoverInfo;
  cois: CoiCollection;
  onRenameCoi: (id: string, name: string) => void;
  onDeleteCoi: (id: string) => void;
  onClear: () => void;
  onAutoComplete: () => void;
  solving: boolean;
  solveMessage: string | null;
};

function hoverTitle(kind: PaintUnit | undefined): string {
  if (kind === "county") return "County";
  if (kind === "tract") return "Tract";
  return "VTD";
}

export function SidePanel({
  manifest,
  selectedDistrict,
  onSelectDistrict,
  paintUnit,
  onPaintUnitChange,
  interactionMode,
  onInteractionModeChange,
  coiDrawMode,
  onCoiDrawModeChange,
  onFinishUnitCoi,
  unitCoiDraftCount,
  pops,
  unassigned,
  assignedVtdCount,
  hover,
  cois,
  onRenameCoi,
  onDeleteCoi,
  onClear,
  onAutoComplete,
  solving,
  solveMessage,
}: Props) {
  const ideal = manifest?.ideal_district_population ?? 0;
  const limit = manifest?.population_deviation_limit_pct ?? 1;
  const vtdCount = manifest?.vtd_count ?? 0;
  const totalDev = totalDeviationPct(pops, ideal);
  const planComplete =
    assignedVtdCount > 0 && unassigned === 0 && withinTotalDeviation(pops, ideal, limit);

  return (
    <aside className="side-panel">
      <header className="brand">
        <p className="brand-mark">DistrictMender</p>
        <h1>Utah congressional map</h1>
        <p className="lede">
          Paint seeds, draw COIs (polygon or units), then Auto-complete with
          GerryChain. Utah total deviation limit: {limit}% (max−min vs ideal).
        </p>
      </header>

      <section className="mode-picker" aria-label="Interaction mode">
        <h2>Mode</h2>
        <div className="segmented">
          <button
            type="button"
            className={interactionMode === "paint" ? "active" : ""}
            aria-pressed={interactionMode === "paint"}
            onClick={() => onInteractionModeChange("paint")}
          >
            Paint
          </button>
          <button
            type="button"
            className={interactionMode === "coi" ? "active" : ""}
            aria-pressed={interactionMode === "coi"}
            onClick={() => onInteractionModeChange("coi")}
          >
            Draw COI
          </button>
        </div>
      </section>

      {interactionMode === "coi" && (
        <section className="unit-picker" aria-label="COI draw method">
          <h2>COI method</h2>
          <div className="segmented">
            <button
              type="button"
              className={coiDrawMode === "polygon" ? "active" : ""}
              aria-pressed={coiDrawMode === "polygon"}
              onClick={() => onCoiDrawModeChange("polygon")}
            >
              Polygon
            </button>
            <button
              type="button"
              className={coiDrawMode === "units" ? "active" : ""}
              aria-pressed={coiDrawMode === "units"}
              onClick={() => onCoiDrawModeChange("units")}
            >
              Units
            </button>
          </div>
          {coiDrawMode === "units" && (
            <>
              <div className="segmented" style={{ marginTop: "0.5rem" }}>
                {PAINT_UNITS.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className={paintUnit === u.id ? "active" : ""}
                    aria-pressed={paintUnit === u.id}
                    onClick={() => onPaintUnitChange(u.id)}
                  >
                    {u.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="primary"
                style={{ marginTop: "0.65rem" }}
                disabled={unitCoiDraftCount === 0}
                onClick={onFinishUnitCoi}
              >
                Finish COI ({unitCoiDraftCount} VTDs)
              </button>
            </>
          )}
        </section>
      )}

      {interactionMode === "paint" && (
        <>
          <section className="unit-picker" aria-label="Paint unit">
            <h2>Paint unit</h2>
            <div className="segmented">
              {PAINT_UNITS.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={paintUnit === u.id ? "active" : ""}
                  aria-pressed={paintUnit === u.id}
                  onClick={() => onPaintUnitChange(u.id)}
                >
                  {u.label}
                </button>
              ))}
            </div>
          </section>

          <section className="district-picker" aria-label="Select district">
            <h2>Active district</h2>
            <div className="district-row">
              {DISTRICT_IDS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={selectedDistrict === d ? "active" : ""}
                  aria-pressed={selectedDistrict === d}
                  onClick={() => onSelectDistrict(d)}
                  style={
                    {
                      "--district": DISTRICT_COLORS[d],
                    } as CSSProperties
                  }
                >
                  D{d}
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="pops" aria-label="District populations">
        <div className="section-head">
          <h2>Population</h2>
          {manifest && (
            <span className="ideal">Ideal {formatPop(ideal)}</span>
          )}
        </div>
        <ul className="pop-list">
          {DISTRICT_IDS.map((d) => {
            const pop = pops[d];
            const pct = ideal ? Math.min(100, (pop / ideal) * 100) : 0;
            const dev = deviationPct(pop, ideal);
            const ok = pop === 0 || withinDeviation(pop, ideal, limit);
            return (
              <li key={d}>
                <div className="pop-meta">
                  <span
                    className="swatch"
                    style={{ background: DISTRICT_COLORS[d] }}
                  />
                  <span>District {d}</span>
                  <span className={ok ? "dev ok" : "dev bad"}>
                    {pop === 0
                      ? "—"
                      : `${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%`}
                  </span>
                </div>
                <div className="bar-track" aria-hidden>
                  <div
                    className="bar-fill"
                    style={{
                      width: `${pct}%`,
                      background: DISTRICT_COLORS[d],
                    }}
                  />
                </div>
                <div className="pop-value">{formatPop(pop)}</div>
              </li>
            );
          })}
        </ul>
        <p className="unassigned">
          Unassigned <strong>{formatPop(unassigned)}</strong>
          <span className="dot">·</span>
          {assignedVtdCount.toLocaleString()} VTDs painted
        </p>
        {assignedVtdCount > 0 && unassigned === 0 && (
          <p className={planComplete ? "total-dev ok" : "total-dev bad"}>
            Total deviation {(totalDev).toFixed(3)}%
            {planComplete ? " (within limit)" : ` (limit ${limit}%)`}
          </p>
        )}
      </section>

      <section className="hover-card" aria-live="polite">
        <h2>{hoverTitle(hover?.kind)}</h2>
        {hover ? (
          <dl>
            {hover.name && (
              <div>
                <dt>Name</dt>
                <dd>{hover.name}</dd>
              </div>
            )}
            <div>
              <dt>ID</dt>
              <dd>{hover.id}</dd>
            </div>
            <div>
              <dt>Population</dt>
              <dd>{formatPop(hover.population)}</dd>
            </div>
            {hover.geoid && (
              <div>
                <dt>GEOID</dt>
                <dd className="mono">{hover.geoid}</dd>
              </div>
            )}
            {hover.vtdCount != null && (
              <div>
                <dt>VTDs</dt>
                <dd>{hover.vtdCount.toLocaleString()}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="muted">
            {interactionMode === "paint"
              ? "Hover a unit on the map."
              : coiDrawMode === "polygon"
                ? "Click vertices. Double-click or Enter to finish; Esc to cancel."
                : "Click VTDs / tracts / counties to add them. Finish COI when done."}
          </p>
        )}
      </section>

      <section className="coi-list" aria-label="Communities of interest">
        <h2>Communities of interest</h2>
        {cois.features.length === 0 ? (
          <p className="muted">
            {interactionMode === "coi"
              ? coiDrawMode === "units"
                ? "No COIs yet. Click units on the map."
                : "No COIs yet. Click the map to start a polygon."
              : "No COIs yet. Switch to Draw COI to add one."}
          </p>
        ) : (
          <ul>
            {cois.features.map((f) => (
              <li key={f.properties.id}>
                <input
                  type="text"
                  value={f.properties.name}
                  aria-label="COI name"
                  onChange={(e) =>
                    onRenameCoi(f.properties.id, e.target.value)
                  }
                />
                <button
                  type="button"
                  className="ghost compact"
                  onClick={() => onDeleteCoi(f.properties.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="panel-actions">
        <div className="solver-actions">
          <button
            type="button"
            className="primary"
            onClick={onAutoComplete}
            disabled={solving || !manifest}
          >
            {solving ? "Solving…" : "Auto-complete"}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onClear}
            disabled={solving}
          >
            Clear assignments
          </button>
        </div>
        {solveMessage && <p className="solve-status">{solveMessage}</p>}
        {manifest && (
          <p className="footnote">
            {manifest.census_year} Census · {vtdCount.toLocaleString()} VTDs
            {manifest.tract_count != null &&
              ` · ${manifest.tract_count.toLocaleString()} tracts`}
            {manifest.county_count != null &&
              ` · ${manifest.county_count} counties`}{" "}
            · {formatPop(manifest.total_population)} people
          </p>
        )}
      </footer>
    </aside>
  );
}
