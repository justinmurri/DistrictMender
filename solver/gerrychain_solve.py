"""GerryChain-based Utah congressional plan completer."""

from __future__ import annotations

import json
import random
from collections import deque
from functools import partial
from pathlib import Path
from typing import Any

import networkx as nx
from gerrychain import Graph, Partition, updaters
from gerrychain.proposals import recom

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GRAPH_PATH = ROOT / "data" / "states" / "49" / "graph.json"

POP_COL = "population"
COI_ATTR = "coi_region"


def load_dual_graph(path: Path | None = None) -> tuple[Graph, dict[str, Any]]:
    raw = json.loads((path or DEFAULT_GRAPH_PATH).read_text())
    nx_g = nx.Graph()
    for node in raw["nodes"]:
        nx_g.add_node(
            int(node["id"]),
            population=int(node["population"]),
            **{COI_ATTR: -1},
        )
    for a, b in raw["edges"]:
        nx_g.add_edge(int(a), int(b))
    return Graph.from_networkx(nx_g), raw


def total_deviation_pct(pops: list[float] | dict[Any, float], ideal: float) -> float:
    values = list(pops.values()) if isinstance(pops, dict) else list(pops)
    positive = [v for v in values if v > 0]
    if not positive or ideal <= 0:
        return 0.0
    return (max(positive) - min(positive)) / ideal * 100.0


def _apply_coi_regions(graph: Graph, coi_vtd_groups: list[list[int]]) -> dict[str, float]:
    for n in graph.nodes:
        graph.node_data(n)[COI_ATTR] = -1
    for gi, group in enumerate(coi_vtd_groups):
        for vid in group:
            vid = int(vid)
            if vid in graph.nodes and graph.node_data(vid)[COI_ATTR] < 0:
                graph.node_data(vid)[COI_ATTR] = gi
    if not coi_vtd_groups:
        return {}
    return {COI_ATTR: 0.35}


def _district_pops(graph: Graph, assignment: dict[int, int], num_districts: int) -> list[float]:
    pops = [0.0] * (num_districts + 1)
    for node, dist in assignment.items():
        pops[int(dist)] += graph.node_data(node)[POP_COL]
    return pops


def _bfs_dist_capped(
    graph: Graph,
    start: int,
    targets: set[int],
    max_depth: int = 80,
) -> int:
    if start in targets:
        return 0
    q: deque[int] = deque([start])
    seen = {start}
    depth = 0
    layer_left = 1
    next_layer = 0
    while q and depth <= max_depth:
        u = q.popleft()
        layer_left -= 1
        for v in graph.neighbors(u):
            if v in seen:
                continue
            if v in targets:
                return depth + 1
            seen.add(v)
            q.append(v)
            next_layer += 1
        if layer_left == 0:
            depth += 1
            layer_left = next_layer
            next_layer = 0
    return -1


def _seed_and_grow(
    graph: Graph,
    locked: dict[int, int],
    num_districts: int,
    ideal: float,
    rng: random.Random,
) -> dict[int, int]:
    assignment: dict[int, int] = {}
    for node, dist in locked.items():
        if node in graph.nodes and 1 <= dist <= num_districts:
            assignment[int(node)] = int(dist)

    has = {d: False for d in range(1, num_districts + 1)}
    for d in assignment.values():
        has[d] = True

    nodes = list(graph.nodes)
    for d in range(1, num_districts + 1):
        if has[d]:
            continue
        seeds = [n for n, dist in assignment.items() if dist > 0]
        best = None
        best_score = -1e18
        for n in nodes:
            if n in assignment:
                continue
            if seeds:
                dist = _bfs_dist_capped(graph, n, set(seeds), 80)
                min_dist = 80 if dist < 0 else dist
            else:
                min_dist = 1e9
            score = min_dist * 1000 + graph.node_data(n)[POP_COL] + rng.random()
            if score > best_score:
                best_score = score
                best = n
        if best is None:
            raise RuntimeError(f"Cannot seed district {d}")
        assignment[best] = d
        has[d] = True

    pops = _district_pops(graph, assignment, num_districts)
    guard = graph.number_of_nodes() * num_districts + 50
    while guard > 0:
        guard -= 1
        unassigned = [n for n in nodes if n not in assignment]
        if not unassigned:
            break
        cands: list[tuple[float, int, int]] = []
        for u in unassigned:
            neigh_d = {assignment[v] for v in graph.neighbors(u) if v in assignment}
            for d in neigh_d:
                next_pop = pops[d] + graph.node_data(u)[POP_COL]
                deficit = ideal - pops[d]
                score = deficit - abs(next_pop - ideal) * 0.15
                cands.append((score, u, d))
        if not cands:
            for u in unassigned:
                q: deque[int] = deque([u])
                seen = {u}
                target = None
                while q:
                    x = q.popleft()
                    if x != u and x in assignment:
                        target = assignment[x]
                        break
                    for v in graph.neighbors(x):
                        if v not in seen:
                            seen.add(v)
                            q.append(v)
                if target is not None:
                    assignment[u] = target
                    pops[target] += graph.node_data(u)[POP_COL]
            break
        cands.sort(reverse=True)
        _, u, d = cands[0]
        if u in assignment:
            continue
        assignment[u] = d
        pops[d] += graph.node_data(u)[POP_COL]

    for n in nodes:
        if n in assignment:
            continue
        q = deque([n])
        seen = {n}
        target = 1
        while q:
            x = q.popleft()
            if x in assignment:
                target = assignment[x]
                break
            for v in graph.neighbors(x):
                if v not in seen:
                    seen.add(v)
                    q.append(v)
        assignment[n] = target

    return assignment


def _is_contiguous(graph: Graph, assignment: dict[int, int], num_districts: int) -> bool:
    for d in range(1, num_districts + 1):
        members = [n for n, dist in assignment.items() if dist == d]
        if not members:
            return False
        start = members[0]
        want = set(members)
        seen = {start}
        q: deque[int] = deque([start])
        while q:
            u = q.popleft()
            for v in graph.neighbors(u):
                if v in want and v not in seen:
                    seen.add(v)
                    q.append(v)
        if seen != want:
            return False
    return True


def _partition_from_assignment(graph: Graph, assignment: dict[int, int]) -> Partition:
    return Partition(
        graph,
        assignment,
        {
            "population": updaters.Tally(POP_COL, alias="population"),
            "cut_edges": updaters.cut_edges,
        },
    )


def _normalize_labels(assignment: dict[int, int]) -> dict[int, int]:
    labels = sorted(set(assignment.values()))
    if not labels:
        return assignment
    if min(labels) == 0:
        remap = {old: i + 1 for i, old in enumerate(labels)}
        return {n: remap[d] for n, d in assignment.items()}
    return assignment


def _locks_ok(assignment: dict[int, int], locked: dict[int, int]) -> bool:
    for node, dist in locked.items():
        if int(assignment.get(node, -1)) != int(dist):
            return False
    return True


def _can_remove_without_split(
    graph: Graph,
    assignment: dict[int, int],
    node: int,
) -> bool:
    """True if removing node from its district leaves that district contiguous (or empty)."""
    d = assignment[node]
    remaining = [n for n, dist in assignment.items() if dist == d and n != node]
    if len(remaining) <= 1:
        return True
    start = remaining[0]
    want = set(remaining)
    seen = {start}
    q: deque[int] = deque([start])
    while q:
        u = q.popleft()
        for v in graph.neighbors(u):
            if v in want and v not in seen:
                seen.add(v)
                q.append(v)
    return seen == want


def _balance_flips(
    graph: Graph,
    assignment: dict[int, int],
    locked: dict[int, int],
    num_districts: int,
    ideal: float,
    max_total_dev_pct: float,
    rng: random.Random,
    rounds: int = 8000,
) -> dict[int, int]:
    """Move unlocked boundary VTDs to shrink (max − min) population."""
    assign = dict(assignment)
    pops = _district_pops(graph, assign, num_districts)

    def current_dev() -> float:
        vals = pops[1:]
        return (max(vals) - min(vals)) / ideal * 100.0 if ideal else 0.0

    for _ in range(rounds):
        if current_dev() <= max_total_dev_pct:
            break
        # Overweight → underweight boundary moves
        donor = max(range(1, num_districts + 1), key=lambda d: pops[d])
        receiver = min(range(1, num_districts + 1), key=lambda d: pops[d])
        if donor == receiver:
            break

        candidates: list[tuple[float, int]] = []
        for u, d in assign.items():
            if d != donor or u in locked:
                continue
            if not any(assign.get(v) == receiver for v in graph.neighbors(u)):
                continue
            if not _can_remove_without_split(graph, assign, u):
                continue
            # Score: how much this shrinks |max-min| after move
            before = max(pops[1:]) - min(pops[1:])
            new_donor = pops[donor] - graph.node_data(u)[POP_COL]
            new_recv = pops[receiver] + graph.node_data(u)[POP_COL]
            others = [pops[x] for x in range(1, num_districts + 1) if x not in (donor, receiver)]
            after_vals = others + [new_donor, new_recv]
            after = max(after_vals) - min(after_vals)
            if after < before:
                candidates.append((before - after + rng.random() * 1e-6, u))

        if not candidates:
            # Any improving flip between any adjacent pair
            improved = False
            nodes = list(assign.keys())
            rng.shuffle(nodes)
            for u in nodes:
                if u in locked:
                    continue
                from_d = assign[u]
                if not _can_remove_without_split(graph, assign, u):
                    continue
                for v in graph.neighbors(u):
                    to_d = assign.get(v)
                    if to_d is None or to_d == from_d:
                        continue
                    before = max(pops[1:]) - min(pops[1:])
                    new_from = pops[from_d] - graph.node_data(u)[POP_COL]
                    new_to = pops[to_d] + graph.node_data(u)[POP_COL]
                    others = [
                        pops[x]
                        for x in range(1, num_districts + 1)
                        if x not in (from_d, to_d)
                    ]
                    after = max(others + [new_from, new_to]) - min(
                        others + [new_from, new_to]
                    )
                    if after < before:
                        pops[from_d] = new_from
                        pops[to_d] = new_to
                        assign[u] = to_d
                        improved = True
                        break
                if improved:
                    break
            if not improved:
                break
            continue

        candidates.sort(reverse=True)
        _, u = candidates[0]
        from_d = assign[u]
        pops[from_d] -= graph.node_data(u)[POP_COL]
        pops[receiver] += graph.node_data(u)[POP_COL]
        assign[u] = receiver

    return assign


def _run_recom(
    partition: Partition,
    *,
    ideal: float,
    steps: int,
    epsilon: float,
    locked: dict[int, int],
    region_surcharge: dict[str, float],
    max_total_dev_pct: float,
    rng: random.Random,
) -> Partition:
    import warnings

    warnings.filterwarnings("ignore")
    proposal_kwargs: dict[str, Any] = {
        "pop_col": POP_COL,
        "pop_target": ideal,
        "epsilon": epsilon,
        "node_repeats": 0,
        "rng": rng,
    }
    if region_surcharge:
        proposal_kwargs["region_surcharge"] = region_surcharge
    proposal = partial(recom, **proposal_kwargs)

    current = partition
    best = partition
    best_dev = total_deviation_pct(dict(current["population"]), ideal)

    for _ in range(max(0, steps)):
        try:
            proposed = proposal(current)
        except Exception:
            continue
        amap = {
            int(n): int(proposed.assignment.mapping[n]) for n in proposed.graph.nodes
        }
        if not _locks_ok(amap, locked):
            continue
        pops = dict(proposed["population"])
        dev = total_deviation_pct(pops, ideal)
        if dev <= best_dev or (dev <= max_total_dev_pct and rng.random() < 0.25):
            current = proposed
            if dev < best_dev:
                best = proposed
                best_dev = dev
                if best_dev <= max_total_dev_pct:
                    break
        elif rng.random() < 0.05:
            current = proposed

    return best


def solve_plan(
    *,
    locked: dict[int, int] | None = None,
    coi_vtd_groups: list[list[int]] | None = None,
    steps: int = 80,
    max_total_dev_pct: float = 1.0,
    seed: int | None = None,
    graph_path: Path | None = None,
) -> dict[str, Any]:
    import warnings

    warnings.filterwarnings("ignore")

    graph, meta = load_dual_graph(graph_path)
    num_districts = int(meta["num_districts"])
    ideal = float(meta["ideal_population"])
    locked = {int(k): int(v) for k, v in (locked or {}).items() if int(v) >= 1}
    coi_vtd_groups = coi_vtd_groups or []
    rng = random.Random(seed)
    epsilon = max(0.001, (max_total_dev_pct / 100.0) / 2.0)

    region_surcharge = _apply_coi_regions(graph, coi_vtd_groups)

    if locked:
        # Seed/grow + flips. Skip ReCom with locks — bipartition often stalls for hours.
        assignment = _normalize_labels(
            _seed_and_grow(graph, locked, num_districts, ideal, rng)
        )
        assignment = _balance_flips(
            graph,
            assignment,
            locked,
            num_districts,
            ideal,
            max_total_dev_pct,
            rng,
            rounds=12000,
        )
        amap = assignment
    else:
        initial = Partition.from_random_assignment(
            graph=graph,
            n_parts=num_districts,
            epsilon=epsilon,
            pop_col=POP_COL,
            updaters={
                "population": updaters.Tally(POP_COL, alias="population"),
                "cut_edges": updaters.cut_edges,
            },
            rng=seed if seed is not None else rng.randint(0, 10**9),
        )
        mapping = _normalize_labels(
            {int(n): int(initial.assignment.mapping[n]) for n in graph.nodes}
        )
        initial = _partition_from_assignment(graph, mapping)
        final = _run_recom(
            initial,
            ideal=ideal,
            steps=steps,
            epsilon=epsilon,
            locked={},
            region_surcharge=region_surcharge,
            max_total_dev_pct=max_total_dev_pct,
            rng=rng,
        )
        amap = _normalize_labels(
            {int(n): int(final.assignment.mapping[n]) for n in graph.nodes}
        )
        amap = _balance_flips(
            graph,
            amap,
            {},
            num_districts,
            ideal,
            max_total_dev_pct,
            rng,
            rounds=3000,
        )

    pops_by_d = _district_pops(graph, amap, num_districts)
    district_pops = [pops_by_d[d] for d in range(1, num_districts + 1)]
    total_dev = total_deviation_pct(district_pops, ideal)
    contiguous = _is_contiguous(graph, amap, num_districts)
    balanced = total_dev <= max_total_dev_pct + 1e-9 and contiguous

    if balanced:
        message = (
            f"GerryChain plan with total deviation {total_dev:.3f}% "
            f"(limit {max_total_dev_pct}%)."
        )
    elif contiguous:
        message = (
            f"Plan is contiguous but total deviation is {total_dev:.3f}% "
            f"(limit {max_total_dev_pct}%). Try fewer locked units or more steps."
        )
    else:
        message = (
            "Could not keep every district contiguous "
            "(often from conflicting locked paint)."
        )

    return {
        "assignment": {str(k): v for k, v in amap.items()},
        "districtPops": district_pops,
        "totalDevPct": total_dev,
        "maxAbsDevPct": max(abs(p - ideal) / ideal * 100.0 for p in district_pops)
        if ideal
        else 0.0,
        "contiguous": contiguous,
        "balanced": balanced,
        "message": message,
        "steps": steps,
        "engine": "gerrychain",
    }
