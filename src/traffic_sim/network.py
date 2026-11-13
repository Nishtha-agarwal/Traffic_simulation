"""Graph helpers and capacity calculations for the road-network model."""

from __future__ import annotations

import networkx as nx

from .models import Network, Road


def build_graph(network: Network) -> nx.MultiDiGraph:
    """Return a directed graph with road configuration attached to each edge."""
    graph = nx.MultiDiGraph()
    graph.add_nodes_from((node.id, node.model_dump()) for node in network.junctions)
    for road in network.roads:
        graph.add_edge(
            road.from_junction,
            road.to_junction,
            key=road.id,
            **road.model_dump(),
            free_flow_seconds=road.length_m / road.speed_limit_kph * 3.6,
        )
    return graph


def road_cell_count(road: Road, cell_length_m: float) -> int:
    """Map a road to at least one simulation cell, rounding up to preserve length."""
    import math

    return max(1, math.ceil(road.length_m / cell_length_m))


def validate_network_connectivity(network: Network) -> list[str]:
    """Return non-fatal topology observations useful to the editor."""
    graph = build_graph(network)
    warnings: list[str] = []
    for junction_id in graph.nodes:
        if graph.in_degree(junction_id) == 0 and graph.out_degree(junction_id) == 0:
            warnings.append(f"junction {junction_id!r} is isolated")
    return warnings
