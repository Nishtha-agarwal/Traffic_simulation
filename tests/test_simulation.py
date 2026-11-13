from traffic_sim.models import DemandPair, Junction, Network, Road, SignalPhase, TrafficSignal
from traffic_sim.sample import create_sample_network
from traffic_sim.simulation import Simulation
from traffic_sim.simulation import Vehicle


def test_simulation_advances_and_tracks_road_occupancy():
    simulation = Simulation(create_sample_network(), seed=42)
    snapshot = simulation.step(60)

    assert snapshot["time_seconds"] == 60
    assert snapshot["active_vehicles"] > 0
    assert all(road["vehicles"] >= 0 for road in snapshot["roads"].values())
    assert all(0 <= road["occupancy_ratio"] <= 1 for road in snapshot["roads"].values())


def test_same_seed_produces_same_result():
    first = Simulation(create_sample_network(), seed=9).step(120)
    second = Simulation(create_sample_network(), seed=9).step(120)
    assert first == second


def test_snapshot_exposes_vehicle_inspection_road_heatmap_and_real_events():
    simulation = Simulation(create_sample_network(), seed=42)
    snapshot = simulation.step(90)

    vehicle = snapshot["vehicles"][0]
    assert vehicle["vehicle_type"] == "car"
    assert vehicle["route"]
    assert vehicle["distance_travelled_m"] > 0
    assert vehicle["current_speed_kph"] >= 0
    assert vehicle["delay_seconds"] >= 0
    assert vehicle["state"] in {"moving", "stopped", "queued"}

    road = snapshot["roads"][vehicle["road_id"]]
    assert road["density_vehicles_per_km_per_lane"] > 0
    assert road["average_speed_kph"] is not None
    assert 0 <= road["speed_ratio"] <= 1
    assert any(event["category"] == "vehicle" for event in snapshot["events"])
    assert any(event["category"] == "signal" for event in snapshot["events"])
    assert all(event["time_seconds"] <= snapshot["time_seconds"] for event in snapshot["events"])


def test_event_buffer_is_bounded_and_seed_deterministic():
    first = Simulation(create_sample_network(), seed=4).step(500)
    second = Simulation(create_sample_network(), seed=4).step(500)
    assert first["events"] == second["events"]
    assert len(first["events"]) <= 100
    completed_events = [event for event in first["events"] if event["vehicle_distance_travelled_m"] is not None]
    assert completed_events
    assert completed_events[0]["vehicle_travel_time_seconds"] > 0


def test_higher_configured_demand_changes_results_with_same_seed_and_horizon():
    baseline_network = create_sample_network()
    high_network = baseline_network.model_copy(deep=True)
    high_network.demand[0].vehicles_per_hour = 3600

    baseline = Simulation(baseline_network, seed=42).step(60)
    high = Simulation(high_network, seed=42).step(60)

    assert high["active_vehicles"] > baseline["active_vehicles"]
    assert high["completed_vehicles"] > baseline["completed_vehicles"]


def test_agents_are_distributed_across_available_lanes():
    network = create_sample_network()
    network.demand[0].vehicles_per_hour = 3600
    snapshot = Simulation(network, seed=1).step(2)
    lanes = {vehicle["lane_index"] for vehicle in snapshot["vehicles"] if vehicle["road_id"] == "bypass"}
    assert lanes == {0, 1}


def test_demand_above_one_vehicle_per_second_uses_multiple_lanes():
    network = Network(
        junctions=[Junction(id="origin"), Junction(id="destination")],
        roads=[Road(id="road", from_junction="origin", to_junction="destination", length_m=1000, lane_count=2)],
        demand=[DemandPair(origin="origin", destination="destination", vehicles_per_hour=7200)],
    )
    snapshot = Simulation(network, seed=1).step(1)
    assert snapshot["active_vehicles"] == 2
    assert {vehicle["lane_index"] for vehicle in snapshot["vehicles"]} == {0, 1}


def test_sample_flyover_is_a_real_free_flow_route():
    simulation = Simulation(create_sample_network(), seed=1)
    assert simulation._route("west", "east") == ["bypass"]


def signal_network(green_movements: list[str]) -> Network:
    return Network(
        junctions=[Junction(id="origin"), Junction(id="signal", signal_id="light"), Junction(id="destination")],
        roads=[
            Road(id="in", from_junction="origin", to_junction="signal", length_m=10, lane_count=1, capacity_vehicles_per_hour=3600),
            Road(id="out", from_junction="signal", to_junction="destination", length_m=30, lane_count=1, capacity_vehicles_per_hour=3600),
        ],
        signals=[TrafficSignal(
            id="light",
            junction_id="signal",
            phases=[
                SignalPhase(duration_seconds=5, green_movements=green_movements),
                SignalPhase(duration_seconds=5, green_movements=["in>out"]),
            ],
        )],
        demand=[DemandPair(origin="origin", destination="destination", vehicles_per_hour=3600)],
    )


def test_vehicle_moves_forward_and_keeps_separate_cells():
    network = Network(
        junctions=[Junction(id="origin"), Junction(id="destination")],
        roads=[Road(id="road", from_junction="origin", to_junction="destination", length_m=30, lane_count=1, capacity_vehicles_per_hour=3600)],
        demand=[DemandPair(origin="origin", destination="destination", vehicles_per_hour=3600)],
    )
    snapshot = Simulation(network, seed=1).step(2)
    assert snapshot["completed_vehicles"] == 1
    assert snapshot["active_vehicles"] == 1
    assert snapshot["vehicles"][0]["position_cells"] == 1


def test_red_signal_holds_vehicle_and_green_movement_releases_it():
    simulation = Simulation(signal_network([]), seed=1)
    red_snapshot = simulation.step(4)
    assert red_snapshot["vehicles"][0]["road_id"] == "in"
    assert red_snapshot["vehicles"][0]["position_cells"] == 0

    green_snapshot = simulation.step(2)
    assert green_snapshot["vehicles"][0]["road_id"] == "out"
    assert green_snapshot["vehicles"][0]["position_cells"] == 0
    assert red_snapshot["signals"]["light"]["state"] == "red"
    assert green_snapshot["signals"]["light"]["state"] == "green"


def test_yellow_phase_is_displayed_and_blocks_movements():
    network = signal_network(["in>out"])
    network.signals[0].phases = [
        SignalPhase(duration_seconds=3, green_movements=[], state="yellow"),
        SignalPhase(duration_seconds=5, green_movements=["in>out"], state="green"),
    ]
    simulation = Simulation(network, seed=1)
    yellow = simulation.step(1)
    assert yellow["signals"]["light"]["state"] == "yellow"
    assert yellow["vehicles"][0]["road_id"] == "in"
    green = simulation.step(3)
    assert green["signals"]["light"]["state"] == "green"
    assert any(event["category"] == "signal" and "phase 2" in event["description"] for event in green["events"])


def test_queue_and_congestion_events_are_emitted_from_real_thresholds():
    snapshot = Simulation(signal_network([]), seed=1).step(1)
    event_categories = {event["category"] for event in snapshot["events"]}
    assert "queue" in event_categories
    assert "congestion" in event_categories


def test_green_permission_is_specific_to_the_configured_movement():
    simulation = Simulation(signal_network(["in>out"]), seed=1)
    snapshot = simulation.step(1)
    assert snapshot["vehicles"][0]["road_id"] == "out"


def test_disabled_signal_reports_off_and_does_not_hold_vehicle():
    network = signal_network([])
    network.signals[0].enabled = False
    snapshot = Simulation(network, seed=1).step(1)
    assert snapshot["signals"]["light"]["state"] == "off"
    assert snapshot["vehicles"][0]["road_id"] == "out"


def test_junction_admits_only_one_vehicle_movement_per_tick():
    network = Network(
        junctions=[Junction(id="a"), Junction(id="b"), Junction(id="j"), Junction(id="c"), Junction(id="d")],
        roads=[
            Road(id="in-a", from_junction="a", to_junction="j", length_m=10, lane_count=1, capacity_vehicles_per_hour=3600),
            Road(id="out-a", from_junction="j", to_junction="c", length_m=10, lane_count=1, capacity_vehicles_per_hour=3600),
            Road(id="in-b", from_junction="b", to_junction="j", length_m=10, lane_count=1, capacity_vehicles_per_hour=3600),
            Road(id="out-b", from_junction="j", to_junction="d", length_m=10, lane_count=1, capacity_vehicles_per_hour=3600),
        ],
    )
    simulation = Simulation(network)
    simulation.vehicles = [
        Vehicle(1, "a", "c", ["in-a", "out-a"], 0, 0, 0, 0),
        Vehicle(2, "b", "d", ["in-b", "out-b"], 0, 0, 0, 0),
    ]
    snapshot = simulation.step(1)
    crossed = [vehicle for vehicle in snapshot["vehicles"] if vehicle["road_id"].startswith("out-")]
    assert len(crossed) == 1


def test_full_road_entry_does_not_overlap_vehicles_and_reports_congestion():
    simulation = Simulation(signal_network([]), seed=1)
    snapshot = simulation.step(1)
    incoming = snapshot["roads"]["in"]
    incoming_vehicles = [vehicle for vehicle in snapshot["vehicles"] if vehicle["road_id"] == "in"]
    assert len(incoming_vehicles) == 1
    assert incoming["vehicles"] == 1
    assert incoming["cell_capacity"] == 1
    assert incoming["occupancy_ratio"] == 1.0
    assert snapshot["metrics"]["queue_length"] == 1
    assert snapshot["metrics"]["road_utilization"]["in"] == 1.0
    assert snapshot["metrics"]["congestion_index"] == 0.25


def test_configured_road_capacity_limits_vehicle_departures():
    def run(capacity: int) -> int:
        network = Network(
            junctions=[Junction(id="origin"), Junction(id="destination")],
            roads=[Road(
                id="road", from_junction="origin", to_junction="destination",
                length_m=10, lane_count=1, capacity_vehicles_per_hour=capacity,
            )],
            demand=[DemandPair(origin="origin", destination="destination", vehicles_per_hour=3600)],
        )
        return Simulation(network, seed=1).step(4)["completed_vehicles"]

    assert run(1800) == 2
    assert run(3600) == 4


def test_metrics_have_documented_units_and_zero_delay_for_free_flow():
    network = Network(
        junctions=[Junction(id="origin"), Junction(id="destination")],
        roads=[Road(id="road", from_junction="origin", to_junction="destination", length_m=10, lane_count=1, capacity_vehicles_per_hour=3600)],
        demand=[DemandPair(origin="origin", destination="destination", vehicles_per_hour=3600)],
    )
    metrics = Simulation(network, seed=1).step(4)["metrics"]
    assert metrics["average_speed_kph"] == 36
    assert metrics["average_travel_time_seconds"] == 1
    assert metrics["average_delay_seconds"] == 0
    assert metrics["throughput_vehicles_per_hour"] == 3600
    assert metrics["queue_length"] == 0
