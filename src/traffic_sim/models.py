"""Validated configuration models for networks and simulation demand."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Junction(StrictModel):
    id: str = Field(min_length=1)
    x: float = 0
    y: float = 0
    signal_id: str | None = None


class Road(StrictModel):
    id: str = Field(min_length=1)
    from_junction: str = Field(min_length=1)
    to_junction: str = Field(min_length=1)
    length_m: float = Field(gt=0)
    lane_count: int = Field(ge=1, le=12)
    speed_limit_kph: float = Field(default=50, gt=0)
    kind: Literal["road", "flyover"] = "road"
    capacity_vehicles_per_hour: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def set_default_capacity(self) -> "Road":
        if self.capacity_vehicles_per_hour is None:
            self.capacity_vehicles_per_hour = self.lane_count * 1800
        return self


class SignalPhase(StrictModel):
    duration_seconds: int = Field(gt=0)
    green_movements: list[str] = Field(default_factory=list)
    state: Literal["green", "yellow", "red"] | None = None


class TrafficSignal(StrictModel):
    id: str = Field(min_length=1)
    junction_id: str = Field(min_length=1)
    enabled: bool = True
    cycle_offset_seconds: int = Field(default=0, ge=0)
    phases: list[SignalPhase] = Field(min_length=1)


class DemandPair(StrictModel):
    origin: str = Field(min_length=1)
    destination: str = Field(min_length=1)
    vehicles_per_hour: float = Field(ge=0)


class Network(StrictModel):
    id: str = Field(default="network", min_length=1)
    name: str = Field(default="Untitled network", min_length=1)
    cell_length_m: float = Field(default=10, gt=0)
    junctions: list[Junction] = Field(min_length=1)
    roads: list[Road] = Field(min_length=1)
    signals: list[TrafficSignal] = Field(default_factory=list)
    demand: list[DemandPair] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_references(self) -> "Network":
        junction_ids = [junction.id for junction in self.junctions]
        road_ids = [road.id for road in self.roads]
        signal_ids = [signal.id for signal in self.signals]
        if len(junction_ids) != len(set(junction_ids)):
            raise ValueError("junction ids must be unique")
        if len(road_ids) != len(set(road_ids)):
            raise ValueError("road ids must be unique")
        if len(signal_ids) != len(set(signal_ids)):
            raise ValueError("signal ids must be unique")

        junction_set = set(junction_ids)
        signal_set = set(signal_ids)
        for road in self.roads:
            if road.from_junction not in junction_set or road.to_junction not in junction_set:
                raise ValueError(f"road {road.id!r} references an unknown junction")
            if road.from_junction == road.to_junction:
                raise ValueError(f"road {road.id!r} cannot connect a junction to itself")
            if road.capacity_vehicles_per_hour is None:
                raise ValueError(f"road {road.id!r} is missing its resolved capacity")
        for junction in self.junctions:
            if junction.signal_id and junction.signal_id not in signal_set:
                raise ValueError(f"junction {junction.id!r} references an unknown signal")
        for signal in self.signals:
            if signal.junction_id not in junction_set:
                raise ValueError(f"signal {signal.id!r} references an unknown junction")
            if sum(phase.duration_seconds for phase in signal.phases) <= 0:
                raise ValueError(f"signal {signal.id!r} must have a positive cycle")
        for pair in self.demand:
            if pair.origin not in junction_set or pair.destination not in junction_set:
                raise ValueError("demand references an unknown origin or destination")
            if pair.origin == pair.destination:
                raise ValueError("demand origin and destination must differ")
        return self


class SimulationEvent(StrictModel):
    """An event emitted from a real model state transition."""

    event_id: int = Field(ge=1)
    time_seconds: int = Field(ge=0)
    category: Literal["vehicle", "signal", "congestion", "queue", "infrastructure"]
    severity: Literal["info", "warning", "critical"] = "info"
    description: str = Field(min_length=1)
    vehicle_id: int | None = None
    road_id: str | None = None
    junction_id: str | None = None
    utilization: float | None = Field(default=None, ge=0, le=1)
    vehicle_distance_travelled_m: float | None = Field(default=None, ge=0)
    vehicle_travel_time_seconds: int | None = Field(default=None, ge=0)
    vehicle_delay_seconds: float | None = Field(default=None, ge=0)
