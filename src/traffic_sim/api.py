"""FastAPI endpoints for scenarios, live sessions, metrics, and comparisons."""

from __future__ import annotations

from typing import Literal

import networkx as nx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from .models import Network
from .network import build_graph, validate_network_connectivity
from .sample import create_sample_network
from .sessions import SessionManager
from .simulation import Simulation


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartSimulationRequest(APIModel):
    scenario_id: str = Field(min_length=1)
    seed: int = 1
    speed_multiplier: float = Field(default=1.0, ge=0.25, le=20)
    duration_seconds: int = Field(default=600, ge=60, le=7200)


class StepRequest(APIModel):
    steps: int = Field(default=1, ge=1, le=3600)


class SpeedRequest(APIModel):
    speed_multiplier: float = Field(ge=0.25, le=20)


class ScenarioComparisonRequest(APIModel):
    scenario_a: Network
    scenario_b: Network
    duration_seconds: int = Field(default=600, ge=1, le=7200)
    seed: int = 1


app = FastAPI(title="QUEST Traffic Simulation API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://trafficflow-frontend.onrender.com",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
sessions = SessionManager()


def _scenario_validation(network: Network) -> dict:
    warnings = validate_network_connectivity(network)
    graph = build_graph(network)
    for pair in network.demand:
        if not nx.has_path(graph, pair.origin, pair.destination):
            warnings.append(f"demand {pair.origin!r} to {pair.destination!r} has no route")
    return {"valid": True, "warnings": warnings}


def _get_state(session_id: str) -> dict:
    try:
        return sessions.state(session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Simulation session not found") from error


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/networks/sample", response_model=Network)
def sample_network() -> Network:
    return create_sample_network()


@app.post("/api/networks/validate")
def validate_network(network: Network) -> dict:
    return _scenario_validation(network)


@app.post("/api/scenarios/validate")
def validate_scenario(network: Network) -> dict:
    return _scenario_validation(network)


@app.post("/api/scenarios", response_model=Network)
def create_scenario(network: Network) -> Network:
    return sessions.save_scenario(network)


@app.get("/api/scenarios/{scenario_id}", response_model=Network)
def get_scenario(scenario_id: str) -> Network:
    scenario = sessions.get_scenario(scenario_id)
    if scenario is None:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return scenario


@app.post("/api/simulations")
def create_simulation(request: StartSimulationRequest) -> dict:
    try:
        session = sessions.create(request.scenario_id, request.seed, request.speed_multiplier, request.duration_seconds)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Scenario not found") from error
    return _get_state(session.id)


@app.post("/api/simulations/{session_id}/start")
def start_simulation(session_id: str) -> dict:
    try:
        sessions.start(session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Simulation session not found") from error
    return _get_state(session_id)


@app.post("/api/simulations/{session_id}/pause")
def pause_simulation(session_id: str) -> dict:
    try:
        sessions.pause(session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Simulation session not found") from error
    return _get_state(session_id)


@app.post("/api/simulations/{session_id}/resume")
def resume_simulation(session_id: str) -> dict:
    try:
        sessions.resume(session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Simulation session not found") from error
    return _get_state(session_id)


@app.post("/api/simulations/{session_id}/step")
def step_simulation(session_id: str, request: StepRequest) -> dict:
    try:
        sessions.step(session_id, request.steps)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Simulation session not found") from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _get_state(session_id)


@app.post("/api/simulations/{session_id}/speed")
def change_simulation_speed(session_id: str, request: SpeedRequest) -> dict:
    try:
        sessions.set_speed(session_id, request.speed_multiplier)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Simulation session not found") from error
    return _get_state(session_id)


@app.post("/api/simulations/{session_id}/reset")
def reset_simulation(session_id: str) -> dict:
    try:
        sessions.reset(session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Simulation session not found") from error
    return _get_state(session_id)


@app.get("/api/simulations/{session_id}")
def get_simulation_state(session_id: str) -> dict:
    return _get_state(session_id)


@app.get("/api/simulations/{session_id}/metrics")
def get_simulation_metrics(session_id: str) -> dict:
    try:
        return sessions.metrics(session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Simulation session not found") from error


@app.post("/api/scenarios/compare")
def compare_scenarios(request: ScenarioComparisonRequest) -> dict:
    simulation_a = Simulation(request.scenario_a.model_copy(deep=True), seed=request.seed)
    simulation_b = Simulation(request.scenario_b.model_copy(deep=True), seed=request.seed)
    result_a = simulation_a.step(request.duration_seconds)
    result_b = simulation_b.step(request.duration_seconds)
    metric_names: tuple[Literal[
        "average_speed_kph",
        "average_travel_time_seconds",
        "average_delay_seconds",
        "throughput_vehicles_per_hour",
        "queue_length",
        "congestion_index",
    ], ...] = (
        "average_speed_kph",
        "average_travel_time_seconds",
        "average_delay_seconds",
        "throughput_vehicles_per_hour",
        "queue_length",
        "congestion_index",
    )
    metrics_a = result_a["metrics"]
    metrics_b = result_b["metrics"]
    differences = {
        key: round(metrics_b[key] - metrics_a[key], 4)
        if metrics_a[key] is not None and metrics_b[key] is not None else None
        for key in metric_names
    }
    differences["completed_vehicles"] = result_b["completed_vehicles"] - result_a["completed_vehicles"]
    return {
        "duration_seconds": request.duration_seconds,
        "seed": request.seed,
        "scenario_a": {"id": request.scenario_a.id, "name": request.scenario_a.name, "metrics": metrics_a, "completed_vehicles": result_a["completed_vehicles"]},
        "scenario_b": {"id": request.scenario_b.id, "name": request.scenario_b.name, "metrics": metrics_b, "completed_vehicles": result_b["completed_vehicles"]},
        "difference_b_minus_a": differences,
    }
