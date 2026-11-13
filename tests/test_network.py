import pytest
from pydantic import ValidationError

from traffic_sim.models import Network, Road
from traffic_sim.network import build_graph, road_cell_count
from traffic_sim.sample import create_sample_network


def test_sample_network_has_valid_roads_lanes_junctions_and_capacities():
    network = create_sample_network()
    graph = build_graph(network)

    assert len(network.junctions) == 5
    assert len(network.roads) == 7
    assert len(network.signals) == 1
    assert graph.number_of_nodes() == 5
    assert graph.number_of_edges() == 7
    assert all(road.lane_count >= 1 for road in network.roads)
    assert all(road.capacity_vehicles_per_hour and road.capacity_vehicles_per_hour > 0 for road in network.roads)
    assert next(road for road in network.roads if road.id == "west-central").capacity_vehicles_per_hour == 3600
    assert next(road for road in network.roads if road.id == "central-east").capacity_vehicles_per_hour == 5400
    assert next(road for road in network.roads if road.id == "bypass").capacity_vehicles_per_hour == 3600
    assert road_cell_count(next(road for road in network.roads if road.id == "bypass"), network.cell_length_m) == 42


def test_road_capacity_defaults_to_lane_count_times_per_lane_capacity():
    road = Road(id="r", from_junction="a", to_junction="b", length_m=100, lane_count=2)
    assert road.capacity_vehicles_per_hour == 3600


def test_unknown_road_junction_is_rejected():
    with pytest.raises(ValidationError, match="unknown junction"):
        Network.model_validate({
            "junctions": [{"id": "a"}],
            "roads": [{"id": "r", "from_junction": "a", "to_junction": "missing", "length_m": 10, "lane_count": 1}],
        })


def test_duplicate_junction_ids_are_rejected():
    with pytest.raises(ValidationError, match="junction ids must be unique"):
        Network.model_validate({
            "junctions": [{"id": "a"}, {"id": "a"}],
            "roads": [{"id": "r", "from_junction": "a", "to_junction": "b", "length_m": 10, "lane_count": 1}],
        })
