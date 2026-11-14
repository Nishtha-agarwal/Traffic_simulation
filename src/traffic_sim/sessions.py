"""In-memory scenario and simulation session lifecycle management."""

from __future__ import annotations
from dataclasses import dataclass
from threading import RLock
import time
from uuid import uuid4
from .models import Network
from .simulation import Simulation


@dataclass
class SimulationSession:
    id: str
    scenario_id: str
    scenario: Network
    seed: int
    simulation: Simulation
    duration_seconds: int = 600
    status: str = "paused"
    speed_multiplier: float = 1.0
    last_clock: float = 0.0


class SessionManager:
    """Small process-local store; explicit step calls remain deterministic."""

    def __init__(self) -> None:
        self.scenarios: dict[str, Network] = {}
        self.sessions: dict[str, SimulationSession] = {}
        self._lock = RLock()

    def save_scenario(self, scenario: Network) -> Network:
        with self._lock:
            stored = scenario.model_copy(deep=True)
            self.scenarios[stored.id] = stored
            return stored.model_copy(deep=True)

    def get_scenario(self, scenario_id: str) -> Network | None:
        with self._lock:
            scenario = self.scenarios.get(scenario_id)
            return scenario.model_copy(deep=True) if scenario else None

    def create(self, scenario_id: str, seed: int, speed: float = 1.0, duration_seconds: int = 600) -> SimulationSession:
        with self._lock:
            scenario = self.scenarios.get(scenario_id)
            if scenario is None:
                raise KeyError(scenario_id)
            session_id = str(uuid4())
            session = SimulationSession(
                id=session_id,
                scenario_id=scenario_id,
                scenario=scenario.model_copy(deep=True),
                seed=seed,
                simulation=Simulation(scenario.model_copy(deep=True), seed=seed),
                duration_seconds=duration_seconds,
                speed_multiplier=speed,
            )
            self.sessions[session_id] = session
            return session

    def _get(self, session_id: str) -> SimulationSession:
        session = self.sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)
        return session

    def _advance_clock(self, session: SimulationSession) -> None:
        now = time.monotonic()
        if session.status == "running":
            remaining = max(0, session.duration_seconds - session.simulation.time_seconds)
            due = min(remaining, int((now - session.last_clock) * session.speed_multiplier))
            if due:
                session.simulation.step(due)
                session.last_clock += due / session.speed_multiplier
            if session.simulation.time_seconds >= session.duration_seconds:
                session.status = "paused"
        else:
            session.last_clock = now

    def start(self, session_id: str) -> SimulationSession:
        with self._lock:
            session = self._get(session_id)
            if session.status != "running" and session.simulation.time_seconds < session.duration_seconds:
                session.status = "running"
                session.last_clock = time.monotonic()
            return session

    def pause(self, session_id: str) -> SimulationSession:
        with self._lock:
            session = self._get(session_id)
            self._advance_clock(session)
            session.status = "paused"
            return session

    def resume(self, session_id: str) -> SimulationSession:
        return self.start(session_id)

    def step(self, session_id: str, steps: int) -> dict:
        with self._lock:
            session = self._get(session_id)
            self._advance_clock(session)
            remaining = max(0, session.duration_seconds - session.simulation.time_seconds)
            if remaining:
                snapshot = session.simulation.step(min(steps, remaining))
            else:
                snapshot = session.simulation.snapshot()
            if session.simulation.time_seconds >= session.duration_seconds:
                session.status = "paused"
            session.last_clock = time.monotonic()
            return snapshot

    def reset(self, session_id: str) -> SimulationSession:
        with self._lock:
            session = self._get(session_id)
            session.status = "paused"
            session.simulation = Simulation(session.scenario.model_copy(deep=True), seed=session.seed)
            session.last_clock = time.monotonic()
            return session

    def set_speed(self, session_id: str, speed: float) -> SimulationSession:
        with self._lock:
            session = self._get(session_id)
            self._advance_clock(session)
            session.speed_multiplier = speed
            session.last_clock = time.monotonic()
            return session

    def state(self, session_id: str) -> dict:
        with self._lock:
            session = self._get(session_id)
            self._advance_clock(session)
            return {
                "session_id": session.id,
                "scenario_id": session.scenario_id,
                "seed": session.seed,
                "status": session.status,
                "speed_multiplier": session.speed_multiplier,
                "duration_seconds": session.duration_seconds,
                "network": session.scenario.model_dump(),
                **session.simulation.snapshot(),
            }

    def metrics(self, session_id: str) -> dict:
        state = self.state(session_id)
        return {"session_id": session_id, "time_seconds": state["time_seconds"], **state["metrics"]}

    def clear(self) -> None:
        with self._lock:
            self.scenarios.clear()
            self.sessions.clear()
