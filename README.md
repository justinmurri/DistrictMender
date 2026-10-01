# DistrictMender

Web-based redistricting tool for Utah congressional districts. Paint by VTD, tract, or county; draw communities of interest (COIs); auto-complete a valid 4-district plan with MGGG GerryChain.

## Status

- **Phase 1 done:** Utah census pipeline (VTDs, tracts, counties, adjacency graph)
- **Phase 2 done:** React + MapLibre map UI
- **Phase 3 done:** Paint by VTD / tract / county; COIs via polygon or unit selection
- **Phase 4 done:** GerryChain auto-complete (FastAPI) with Utah **total deviation** ≤1%

## Run

```bash
# once: data + Python deps
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/build_dataset.py

# terminal 1 — GerryChain solver API
source .venv/bin/activate
cd solver && uvicorn server:app --host 127.0.0.1 --port 8765

# terminal 2 — web UI
cd web && npm install && npm run dev
```

Open http://127.0.0.1:5173/ — Vite proxies `/api` to the solver.

## Stack

- **Data:** 2020 Census VTDs, tracts, counties (TIGER2020PL + PL 94-171)
- **Web:** React + TypeScript + MapLibre GL
- **Solver:** [GerryChain](https://github.com/mggg/GerryChain) ReCom via FastAPI (`solver/`); painted VTDs stay locked; COIs soft-kept with `region_surcharge`

## Population equality

Utah’s ≤1% rule is measured as **total deviation**:

`(max district pop − min district pop) / ideal × 100`

not merely each district within ±1% of ideal.

## Utah standards

Congressional plans must meet Utah Code § 20A-19-103 and § 20A-20-302(4), including ≤1% total population deviation, contiguity, compactness, COI preservation, and minimized county/municipality splits.
