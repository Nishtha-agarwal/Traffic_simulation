"""Small example network used by the API, frontend, and tests."""

from .models import (
    DemandPair,
    Junction,
    Network,
    Road,
    SignalPhase,
    TrafficSignal,
)


def create_sample_network() -> Network:
    return Network(
        id="sample-grid",
        name="Sample City Corridor",
        cell_length_m=10,
        junctions=[
            Junction(id="west", x=0, y=100),
            Junction(id="central", x=150, y=100, signal_id="central-signal"),
            Junction(id="east", x=300, y=100),
            Junction(id="north", x=150, y=0),
            Junction(id="south", x=150, y=200),
        ],
        roads=[
            Road(id="west-central", from_junction="west", to_junction="central", length_m=150, lane_count=2, speed_limit_kph=50),
            Road(id="central-west", from_junction="central", to_junction="west", length_m=150, lane_count=2, speed_limit_kph=50),
            Road(id="central-east", from_junction="central", to_junction="east", length_m=150, lane_count=3, speed_limit_kph=60),
            Road(id="east-central", from_junction="east", to_junction="central", length_m=150, lane_count=3, speed_limit_kph=60),
            Road(id="north-central", from_junction="north", to_junction="central", length_m=100, lane_count=1, speed_limit_kph=40, capacity_vehicles_per_hour=1500),
            Road(id="central-south", from_junction="central", to_junction="south", length_m=100, lane_count=1, speed_limit_kph=40),
            Road(id="bypass", from_junction="west", to_junction="east", length_m=420, lane_count=2, speed_limit_kph=80, capacity_vehicles_per_hour=3600, kind="flyover"),
        ],
        signals=[
            TrafficSignal(
                id="central-signal",
                junction_id="central",
                phases=[
                    SignalPhase(duration_seconds=30, green_movements=["west-central>central-east"]),
                    SignalPhase(duration_seconds=20, green_movements=["north-central>central-south"]),
                ],
            )
        ],
        demand=[DemandPair(origin="west", destination="east", vehicles_per_hour=900)],
    )
