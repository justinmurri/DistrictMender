"""FastAPI service exposing GerryChain auto-complete."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from gerrychain_solve import solve_plan

app = FastAPI(title="DistrictMender solver", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SolveRequest(BaseModel):
    locked: dict[str, int] = Field(default_factory=dict)
    coiVtdGroups: list[list[int]] = Field(default_factory=list)
    steps: int = 80
    maxTotalDevPct: float = 1.0
    seed: int | None = None


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "engine": "gerrychain"}


@app.post("/api/solve")
def solve(req: SolveRequest) -> dict[str, Any]:
    try:
        locked = {int(k): int(v) for k, v in req.locked.items()}
        return solve_plan(
            locked=locked,
            coi_vtd_groups=req.coiVtdGroups,
            steps=req.steps,
            max_total_dev_pct=req.maxTotalDevPct,
            seed=req.seed,
        )
    except Exception as exc:  # noqa: BLE001 — surface to client
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def main() -> None:
    import uvicorn

    uvicorn.run("server:app", host="127.0.0.1", port=8765, reload=False)


if __name__ == "__main__":
    main()
