import pytest
from fastapi import HTTPException

from traffic_sim.api import (
    ScenarioComparisonRequest,
    SpeedRequest,
    StartSimulationRequest,
    StepRequest,
    change_simulation_speed,
    compare_scenarios,
    create_scenario,
    create_simulation,
    get_scenario,
    get_simulation_metrics,
    get_simulation_state,
    pause_simulation,
    reset_simulation,
    resume_simulation,
    sample_network,
    sessions,
    start_simulation,
    step_simulation,
    validate_scenario,
    app,
)


def setup_function():
    sessions.clear()


def test_new_api_routes_are_registered():
    registered = {
        (route.path, method)
        for route in app.routes
        if hasattr(route, "methods")
        for method in route.methods
    }
    expected = {
        ("/api/scenarios/validate", "POST"),
        ("/api/scenarios", "POST"),
        ("/api/scenarios/{scenario_id}", "GET"),
        ("/api/simulations", "POST"),
        ("/api/simulations/{session_id}", "GET"),
        ("/api/simulations/{session_id}/metrics", "GET"),
        ("/api/simulations/{session_id}/start", "POST"),
        ("/api/simulations/{session_id}/pause", "POST"),
        ("/api/simulations/{session_id}/resume", "POST"),
        ("/api/simulations/{session_id}/step", "POST"),
        ("/api/simulations/{session_id}/reset", "POST"),
        ("/api/simulations/{session_id}/speed", "POST"),
        ("/api/scenarios/compare", "POST"),
    }
    assert expected <= registered


def test_scenario_creation_validation_and_retrieval():
    scenario = sample_network()
    assert validate_scenario(scenario) == {"valid": True, "warnings": []}
    created = create_scenario(scenario)
    assert created.id == scenario.id
    assert get_scenario(scenario.id).name == scenario.name


def test_simulation_lifecycle_step_state_metrics_and_reset():
    scenario = create_scenario(sample_network())
    state = create_simulation(StartSimulationRequest(scenario_id=scenario.id, seed=25))
    session_id = state["session_id"]
    assert state["status"] == "paused"
    assert state["duration_seconds"] == 600
    assert state["network"]["id"] == scenario.id

    assert start_simulation(session_id)["status"] == "running"
    assert pause_simulation(session_id)["status"] == "paused"
    stepped = step_simulation(session_id, StepRequest(steps=10))
    assert stepped["time_seconds"] == 10
    assert "signals" in stepped and "vehicles" in stepped and "metrics" in stepped
    assert get_simulation_state(session_id)["time_seconds"] == 10
    assert get_simulation_metrics(session_id)["time_seconds"] == 10
    assert change_simulation_speed(session_id, SpeedRequest(speed_multiplier=3.0))["speed_multiplier"] == 3.0
    assert resume_simulation(session_id)["status"] == "running"
    assert pause_simulation(session_id)["status"] == "paused"
    reset = reset_simulation(session_id)
    assert reset["time_seconds"] == 0
    assert reset["status"] == "paused"
    assert reset["seed"] == 25


def test_missing_scenario_or_session_returns_not_found():
    with pytest.raises(HTTPException) as scenario_error:
        get_scenario("missing")
    assert scenario_error.value.status_code == 404

    with pytest.raises(HTTPException) as session_error:
        get_simulation_state("missing")
    assert session_error.value.status_code == 404


def test_flyover_scenario_comparison_returns_metrics_and_deltas():
    with_flyover = sample_network()
    without_flyover = with_flyover.model_copy(deep=True)
    without_flyover.id = "sample-baseline"
    without_flyover.name = "Sample without flyover"
    without_flyover.roads = [road for road in without_flyover.roads if road.kind != "flyover"]

    request = ScenarioComparisonRequest(
        scenario_a=without_flyover,
        scenario_b=with_flyover,
        duration_seconds=300,
        seed=8,
    )
    result = compare_scenarios(request)
    repeated = compare_scenarios(request)

    assert result["duration_seconds"] == 300
    assert result["scenario_a"]["metrics"]["average_travel_time_seconds"] is not None
    assert result["scenario_b"]["metrics"]["average_speed_kph"] > 0
    assert result["scenario_a"]["completed_vehicles"] >= 0
    assert result["scenario_b"]["completed_vehicles"] >= 0
    assert result["difference_b_minus_a"]["completed_vehicles"] == result["scenario_b"]["completed_vehicles"] - result["scenario_a"]["completed_vehicles"]
    assert result["difference_b_minus_a"]["average_travel_time_seconds"] is not None
    assert result["difference_b_minus_a"]["congestion_index"] is not None
    assert repeated == result


def test_api_session_duration_limits_manual_steps_and_pauses():
    scenario = create_scenario(sample_network())
    state = create_simulation(StartSimulationRequest(scenario_id=scenario.id, seed=19, duration_seconds=60))
    stepped = step_simulation(state["session_id"], StepRequest(steps=120))

    assert stepped["time_seconds"] == 60
    assert stepped["duration_seconds"] == 60
    assert stepped["status"] == "paused"
