#!/usr/bin/env python3
"""
Build Utah 2020 census dataset for DistrictMender.

VTDs are the atomic paint/solver unit. Census tracts sit between VTDs and
counties. Population comes from PL 94-171 at the VTD level (no census blocks).

Usage:
    python scripts/build_dataset.py
    python scripts/build_dataset.py --skip-download

Outputs (data/states/49/):
    manifest.json     - metadata + layer paths
    graph.json        - VTD adjacency + population for solver
    vtds.geojson      - VTD polygons (atomic units)
    tracts.geojson    - tracts + member vtd_ids
    counties.geojson  - counties + member vtd_ids
    vtd_pops.json     - compact population array (index = vtd id)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import zipfile
from pathlib import Path

import geopandas as gpd
import pandas as pd

STATE_FIPS = "49"
STATE_ABBR = "UT"
NUM_DISTRICTS = 4

PL_ZIP_URL = (
    "https://www2.census.gov/programs-surveys/decennial/2020/data/"
    "01-Redistricting_File--PL_94-171/Utah/ut2020.pl.zip"
)
VTD_ZIP_URL = (
    f"https://www2.census.gov/geo/tiger/TIGER2020PL/STATE/"
    f"{STATE_FIPS}_UTAH/{STATE_FIPS}/tl_2020_{STATE_FIPS}_vtd20.zip"
)
TRACT_ZIP_URL = (
    f"https://www2.census.gov/geo/tiger/TIGER2020PL/STATE/"
    f"{STATE_FIPS}_UTAH/{STATE_FIPS}/tl_2020_{STATE_FIPS}_tract20.zip"
)
COUNTY_ZIP_URL = (
    f"https://www2.census.gov/geo/tiger/TIGER2020PL/STATE/"
    f"{STATE_FIPS}_UTAH/{STATE_FIPS}/tl_2020_{STATE_FIPS}_county20.zip"
)

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "states" / STATE_FIPS
CACHE_DIR = DATA_DIR / "raw"
OUT_GRAPH = DATA_DIR / "graph.json"
OUT_VTDS = DATA_DIR / "vtds.geojson"
OUT_TRACTS = DATA_DIR / "tracts.geojson"
OUT_COUNTIES = DATA_DIR / "counties.geojson"
OUT_POPS = DATA_DIR / "vtd_pops.json"
OUT_MANIFEST = DATA_DIR / "manifest.json"

VTD_SIMPLIFY = 0.0008
UNIT_SIMPLIFY = 0.0005


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  cached: {dest.name}")
        return dest
    print(f"  downloading: {url}")
    subprocess.run(["curl", "-fsSL", "-o", str(dest), url], check=True)
    return dest


def extract_shapefile(zip_path: Path, extract_dir: Path) -> Path:
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        shp_name = next(n for n in zf.namelist() if n.endswith(".shp"))
        zf.extractall(extract_dir)
        return extract_dir / shp_name


def load_vtds(cache: Path) -> gpd.GeoDataFrame:
    zip_path = download(VTD_ZIP_URL, cache / f"tl_2020_{STATE_FIPS}_vtd20.zip")
    shp = extract_shapefile(zip_path, cache / "vtds")
    gdf = gpd.read_file(shp).to_crs(4326)
    gdf["vtd_geoid"] = gdf["GEOID20"].astype(str)
    gdf["name"] = gdf["NAME20"].astype(str)
    gdf["county_fips"] = gdf["COUNTYFP20"].astype(str).str.zfill(3)
    return gdf[["vtd_geoid", "name", "county_fips", "geometry"]]


def load_tracts(cache: Path) -> gpd.GeoDataFrame:
    zip_path = download(TRACT_ZIP_URL, cache / f"tl_2020_{STATE_FIPS}_tract20.zip")
    shp = extract_shapefile(zip_path, cache / "tracts")
    gdf = gpd.read_file(shp).to_crs(4326)
    gdf["tract_geoid"] = gdf["GEOID20"].astype(str)
    gdf["name"] = gdf["NAME20"].astype(str)
    gdf["county_fips"] = gdf["COUNTYFP20"].astype(str).str.zfill(3)
    return gdf[["tract_geoid", "name", "county_fips", "geometry"]]


def load_counties(cache: Path) -> gpd.GeoDataFrame:
    zip_path = download(COUNTY_ZIP_URL, cache / f"tl_2020_{STATE_FIPS}_county20.zip")
    shp = extract_shapefile(zip_path, cache / "counties")
    gdf = gpd.read_file(shp).to_crs(4326)
    gdf["county_fips"] = gdf["COUNTYFP20"].astype(str).str.zfill(3)
    gdf["name"] = gdf["NAME20"].astype(str)
    return gdf[["county_fips", "name", "geometry"]]


def load_vtd_population(cache: Path) -> pd.DataFrame:
    """Parse PL 94-171 for VTD-level total population (SUMLEV 700)."""
    zip_path = download(PL_ZIP_URL, cache / "ut2020.pl.zip")
    with zipfile.ZipFile(zip_path) as zf:
        geo_lines = zf.read("utgeo2020.pl").decode("utf-8", errors="replace").splitlines()
        data_lines = zf.read("ut000012020.pl").decode("utf-8", errors="replace").splitlines()

    logrec_to_geoid: dict[str, str] = {}
    for line in geo_lines:
        parts = line.split("|")
        if len(parts) < 10 or parts[2] != "700":
            continue
        logrec = parts[7]
        geoid = parts[9].replace("7000000US", "")
        logrec_to_geoid[logrec] = geoid

    rows: list[dict[str, object]] = []
    for line in data_lines:
        parts = line.split("|")
        if len(parts) < 7:
            continue
        logrec = parts[4]
        if logrec not in logrec_to_geoid:
            continue
        rows.append(
            {
                "vtd_geoid": logrec_to_geoid[logrec],
                "population": int(parts[5]),
            }
        )
    return pd.DataFrame(rows)


def join_vtds_to_tracts(
    vtds: gpd.GeoDataFrame, tracts: gpd.GeoDataFrame
) -> gpd.GeoDataFrame:
    """Assign each VTD to the tract with the largest intersection area."""
    print("  joining VTDs to tracts (largest overlap)...")
    left = vtds[["vtd_geoid", "geometry"]].copy()
    left["vtd_geom"] = left.geometry
    # Project for accurate area (UTM Zone 12N)
    left_p = left.to_crs(26912)
    tracts_p = tracts[["tract_geoid", "geometry"]].to_crs(26912)

    hit = gpd.sjoin(
        left_p[["vtd_geoid", "geometry"]],
        tracts_p,
        how="left",
        predicate="intersects",
    )
    if hit.empty:
        out = vtds.copy()
        out["tract_geoid"] = None
        return out

    hit = hit.merge(
        tracts_p.rename(columns={"geometry": "tract_geom"}),
        on="tract_geoid",
        how="left",
    )
    hit = hit.merge(
        left_p[["vtd_geoid", "geometry"]].rename(columns={"geometry": "vtd_geom"}),
        on="vtd_geoid",
        how="left",
    )

    def _overlap_area(row: pd.Series) -> float:
        if row.get("tract_geom") is None or row.vtd_geom is None:
            return 0.0
        try:
            return float(row.vtd_geom.intersection(row.tract_geom).area)
        except Exception:
            return 0.0

    hit["overlap"] = hit.apply(_overlap_area, axis=1)
    best = (
        hit.sort_values("overlap", ascending=False)
        .drop_duplicates(subset=["vtd_geoid"], keep="first")
    )
    return vtds.merge(best[["vtd_geoid", "tract_geoid"]], on="vtd_geoid", how="left")


def build_adjacency(gdf: gpd.GeoDataFrame) -> list[list[int]]:
    print("  building VTD adjacency graph...")
    gdf = gdf.reset_index(drop=True)
    neighbors: list[list[int]] = [[] for _ in range(len(gdf))]
    sindex = gdf.sindex
    for i, geom in enumerate(gdf.geometry):
        if geom is None or geom.is_empty:
            continue
        for j in sindex.intersection(geom.bounds):
            if i != j and geom.touches(gdf.geometry.iloc[j]):
                neighbors[i].append(int(j))
    return neighbors


def write_aggregate_geojson(
    units: gpd.GeoDataFrame,
    atoms: gpd.GeoDataFrame,
    key: str,
    id_field: str,
    out_path: Path,
    extra_props: list[str],
) -> int:
    """Aggregate VTD ids + population onto parent polygons."""
    atoms = atoms.reset_index(drop=True)
    atoms["id"] = atoms.index
    grouped = (
        atoms.dropna(subset=[key])
        .groupby(key, dropna=False)
        .agg(
            population=("population", "sum"),
            vtd_ids=("id", list),
            vtd_count=("id", "count"),
        )
        .reset_index()
    )
    out = units.merge(grouped, on=key, how="left")
    out["population"] = out["population"].fillna(0).astype(int)
    out["vtd_count"] = out["vtd_count"].fillna(0).astype(int)
    out["vtd_ids"] = out["vtd_ids"].apply(
        lambda xs: [int(x) for x in xs] if isinstance(xs, list) else []
    )
    out["geometry"] = out.geometry.simplify(UNIT_SIMPLIFY, preserve_topology=True)
    out = out.reset_index(drop=True)
    out[id_field] = out.index

    features: list[dict] = []
    for _, row in out.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        props: dict[str, object] = {
            id_field: int(row[id_field]),
            key: None if pd.isna(row[key]) else row[key],
            "population": int(row["population"]),
            "vtd_count": int(row["vtd_count"]),
            "vtd_ids": json.dumps(row["vtd_ids"], separators=(",", ":")),
        }
        for prop in extra_props:
            val = row[prop]
            props[prop] = None if pd.isna(val) else val
        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": geom.__geo_interface__,
            }
        )

    out_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"  wrote {out_path} ({len(features):,} features)")
    return len(features)


def write_vtd_geojson(vtds: gpd.GeoDataFrame, out_path: Path) -> None:
    vtds = vtds.reset_index(drop=True).copy()
    vtds["id"] = vtds.index
    vtds["geometry"] = vtds.geometry.simplify(VTD_SIMPLIFY, preserve_topology=True)
    features: list[dict] = []
    for _, row in vtds.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": int(row["id"]),
                    "vtd_geoid": row["vtd_geoid"],
                    "name": row["name"],
                    "county_fips": row["county_fips"],
                    "tract_geoid": None
                    if pd.isna(row.get("tract_geoid"))
                    else row["tract_geoid"],
                    "population": int(row["population"]),
                },
                "geometry": geom.__geo_interface__,
            }
        )
    out_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"  wrote {out_path} ({len(features):,} features)")


def main(skip_download: bool = False) -> None:
    del skip_download
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print("Loading VTDs...")
    vtds = load_vtds(CACHE_DIR)
    print(f"  {len(vtds):,} VTDs")

    print("Loading tracts...")
    tracts = load_tracts(CACHE_DIR)
    print(f"  {len(tracts):,} tracts")

    print("Loading counties...")
    counties = load_counties(CACHE_DIR)
    print(f"  {len(counties):,} counties")

    print("Loading VTD population (PL SUMLEV 700)...")
    pop = load_vtd_population(CACHE_DIR)
    merged = vtds.merge(pop, on="vtd_geoid", how="left")
    merged["population"] = merged["population"].fillna(0).astype(int)
    total_pop = int(merged["population"].sum())
    print(f"  total population: {total_pop:,}")

    merged = join_vtds_to_tracts(merged, tracts)
    matched = int(merged["tract_geoid"].notna().sum())
    print(f"  {matched:,} VTDs matched to a tract")

    ideal = int(round(total_pop / NUM_DISTRICTS))
    print(f"  ideal district population: {ideal:,}")

    all_vtds = merged.reset_index(drop=True).copy()
    neighbors = build_adjacency(all_vtds)

    nodes = [
        {
            "id": i,
            "vtd_geoid": row.vtd_geoid,
            "population": int(row.population),
            "county_fips": row.county_fips,
            "tract_geoid": None if pd.isna(row.tract_geoid) else str(row.tract_geoid),
        }
        for i, row in all_vtds.iterrows()
    ]
    edges: list[list[int]] = []
    for i, nbrs in enumerate(neighbors):
        for j in nbrs:
            if i < j:
                edges.append([int(i), int(j)])

    graph = {
        "state_fips": STATE_FIPS,
        "state_abbr": STATE_ABBR,
        "num_districts": NUM_DISTRICTS,
        "ideal_population": ideal,
        "total_population": total_pop,
        "atomic_unit": "vtd",
        "node_count": len(nodes),
        "edge_count": len(edges),
        "nodes": nodes,
        "edges": edges,
    }
    OUT_GRAPH.write_text(json.dumps(graph))
    print(f"  wrote {OUT_GRAPH} ({len(nodes):,} nodes, {len(edges):,} edges)")

    print("  writing map layers...")
    write_vtd_geojson(all_vtds, OUT_VTDS)
    tract_count = write_aggregate_geojson(
        tracts,
        all_vtds,
        key="tract_geoid",
        id_field="id",
        out_path=OUT_TRACTS,
        extra_props=["name", "county_fips"],
    )
    county_count = write_aggregate_geojson(
        counties,
        all_vtds,
        key="county_fips",
        id_field="id",
        out_path=OUT_COUNTIES,
        extra_props=["name"],
    )

    pops = [int(n["population"]) for n in nodes]
    OUT_POPS.write_text(json.dumps(pops, separators=(",", ":")))
    print(f"  wrote {OUT_POPS}")

    # Remove obsolete block artifacts if present
    for obsolete in (
        DATA_DIR / "blocks.geojson",
        DATA_DIR / "block_pops.json",
    ):
        if obsolete.exists():
            obsolete.unlink()
            print(f"  removed obsolete {obsolete.name}")

    manifest = {
        "state_fips": STATE_FIPS,
        "state_abbr": STATE_ABBR,
        "state_name": "Utah",
        "num_congressional_districts": NUM_DISTRICTS,
        "census_year": 2020,
        "atomic_unit": "vtd",
        "total_population": total_pop,
        "ideal_district_population": ideal,
        "vtd_count": len(nodes),
        "tract_count": tract_count,
        "county_count": county_count,
        "population_deviation_limit_pct": 1.0,
        "paint_units": ["vtd", "tract", "county"],
        "files": {
            "graph": str(OUT_GRAPH.relative_to(ROOT)),
            "vtds_geojson": str(OUT_VTDS.relative_to(ROOT)),
            "tracts_geojson": str(OUT_TRACTS.relative_to(ROOT)),
            "counties_geojson": str(OUT_COUNTIES.relative_to(ROOT)),
            "vtd_pops": str(OUT_POPS.relative_to(ROOT)),
        },
    }
    OUT_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"  wrote {OUT_MANIFEST}")
    print("Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Build Utah VTD/tract/county dataset for DistrictMender"
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Use cached raw files only (downloads skip automatically when present)",
    )
    args = parser.parse_args()
    main(skip_download=args.skip_download)
