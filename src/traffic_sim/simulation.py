"""Deterministic discrete-time, cell-based traffic simulation core."""

from __future__ import annotations

from dataclasses import dataclass
import math
import random

import networkx as nx

from .models import Network, SimulationEvent
from .network import build_graph, road_cell_count


@dataclass
class Vehicle:
    id: int
    origin: str
    destination: str
    route: list[str]
    road_index: int
    lane_index: int
    position_cells: int
    entered_at: int
    distance_travelled_m: float = 0.0
    free_flow_seconds_travelled: float = 0.0
    current_speed_kph: float = 0.0


class Simulation:
    """A one-second-step prototype; cell occupancy is conservatively one vehicle."""

    def __init__(self, network: Network, seed: int = 1):
        self.network = network
        self.graph = build_graph(network)
        self.rng = random.Random(seed)
        self.time_seconds = 0
        self.next_vehicle_id = 1
        self.vehicles: list[Vehicle] = []
        self.completed_travel_times: list[int] = []
        self.completed_free_flow_times: list[float] = []
        self._total_distance_m = 0.0
        self._vehicle_seconds = 0
        self._queues_by_road = {road.id: 0 for road in network.roads}
        self._roads = {road.id: road for road in network.roads}
        self._capacity_credit = {road.id: 0.0 for road in network.roads}
        self._road_distance_m = {road.id: 0.0 for road in network.roads}
        self._road_vehicle_seconds = {road.id: 0 for road in network.roads}
        self._events: list[SimulationEvent] = []
        self._next_event_id = 1
        self._roads_by_pair: dict[tuple[str, str], list] = {}
        for road in network.roads:
            self._roads_by_pair.setdefault((road.from_junction, road.to_junction), []).append(road)
        self._cells = {road.id: road_cell_count(road, network.cell_length_m) for road in network.roads}
        self._incoming = {node.id: [] for node in network.junctions}
        for road in network.roads:
            self._incoming[road.to_junction].append(road.id)
        self._signal_by_junction = {signal.junction_id: signal for signal in network.signals if signal.enabled}

    def _route(self, origin: str, destination: str) -> list[str] | None:
        try:
            nodes = nx.shortest_path(self.graph, origin, destination, weight="free_flow_seconds")
        except nx.NetworkXNoPath:
            return None
        return [
            min(self._roads_by_pair[(a, b)], key=lambda road: road.length_m / road.speed_limit_kph).id
            for a, b in zip(nodes, nodes[1:])
        ]

    def _signal_allows(self, junction_id: str, incoming_road_id: str, outgoing_road_id: str) -> bool:
        signal = self._signal_by_junction.get(junction_id)
        if not signal:
            return True
        cycle = sum(phase.duration_seconds for phase in signal.phases)
        elapsed = (self.time_seconds + signal.cycle_offset_seconds) % cycle
        for phase in signal.phases:
            if elapsed < phase.duration_seconds:
                movement = f"{incoming_road_id}>{outgoing_road_id}"
                return movement in phase.green_movements
            elapsed -= phase.duration_seconds
        return False

    def _generate_demand(self) -> None:
        for pair in self.network.demand:
            expected_arrivals = pair.vehicles_per_hour / 3600
            arrivals = int(expected_arrivals)
            if self.rng.random() < expected_arrivals - arrivals:
                arrivals += 1
            for _ in range(arrivals):
                route = self._route(pair.origin, pair.destination)
                if route:
                    first_road = route[0]
                    lane_load = [0] * self._roads[first_road].lane_count
                    lane_entry_occupied = [False] * self._roads[first_road].lane_count
                    for vehicle in self.vehicles:
                        if vehicle.route[vehicle.road_index] == first_road:
                            lane_load[vehicle.lane_index] += 1
                            if vehicle.position_cells == 0:
                                lane_entry_occupied[vehicle.lane_index] = True
                    available_lanes = [lane for lane, occupied in enumerate(lane_entry_occupied) if not occupied]
                    if not available_lanes:
                        continue
                    start_lane = min(available_lanes, key=lane_load.__getitem__)
                    self.vehicles.append(Vehicle(self.next_vehicle_id, pair.origin, pair.destination, route, 0, start_lane, 0, self.time_seconds))
                    self.next_vehicle_id += 1

    def _emit_event(
        self,
        category: str,
        description: str,
        *,
        severity: str = "info",
        vehicle_id: int | None = None,
        road_id: str | None = None,
        junction_id: str | None = None,
        utilization: float | None = None,
        vehicle_distance_travelled_m: float | None = None,
        vehicle_travel_time_seconds: int | None = None,
        vehicle_delay_seconds: float | None = None,
        time_seconds: int | None = None,
    ) -> None:
        self._events.append(SimulationEvent(
            event_id=self._next_event_id,
            time_seconds=self.time_seconds if time_seconds is None else time_seconds,
            category=category,
            severity=severity,
            description=description,
            vehicle_id=vehicle_id,
            road_id=road_id,
            junction_id=junction_id,
            utilization=utilization,
            vehicle_distance_travelled_m=vehicle_distance_travelled_m,
            vehicle_travel_time_seconds=vehicle_travel_time_seconds,
            vehicle_delay_seconds=vehicle_delay_seconds,
        ))
        self._next_event_id += 1
        if len(self._events) > 100:
            del self._events[:-100]

    def _signal_states_at(self, time_seconds: int) -> dict[str, tuple[str, int]]:
        result: dict[str, tuple[str, int]] = {}
        for signal in self.network.signals:
            cycle_length = sum(phase.duration_seconds for phase in signal.phases)
            phase_elapsed = (time_seconds + signal.cycle_offset_seconds) % cycle_length
            for phase_index, phase in enumerate(signal.phases):
                if phase_elapsed < phase.duration_seconds:
                    state = "off" if not signal.enabled else phase.state or ("green" if phase.green_movements else "red")
                    result[signal.id] = (state, phase_index)
                    break
                phase_elapsed -= phase.duration_seconds
        return result

    def step(self, ticks: int = 1) -> dict:
        if ticks < 1:
            raise ValueError("ticks must be at least one")
        for _ in range(ticks):
            old_signal_states = self._signal_states_at(self.time_seconds)
            old_queues = self._queues_by_road.copy()
            old_occupancy = {road_id: self._road_occupancy(road_id) for road_id in self._roads}
            first_new_vehicle_id = self.next_vehicle_id
            self._generate_demand()
            for vehicle in self.vehicles:
                if vehicle.id >= first_new_vehicle_id:
                    self._emit_event(
                        "vehicle", f"Vehicle #{vehicle.id} entered the network on {vehicle.route[0]}.",
                        vehicle_id=vehicle.id, road_id=vehicle.route[0], time_seconds=self.time_seconds + 1,
                    )
            self._vehicle_seconds += len(self.vehicles)
            queues_by_road = {road_id: 0 for road_id in self._roads}
            for road_id, road in self._roads.items():
                self._capacity_credit[road_id] = min(
                    float(road.lane_count),
                    self._capacity_credit[road_id] + road.capacity_vehicles_per_hour / 3600,
                )
            occupancy: dict[str, set[tuple[int, int]]] = {road_id: set() for road_id in self._roads}
            for vehicle in self.vehicles:
                road_id = vehicle.route[vehicle.road_index]
                occupancy[road_id].add((vehicle.lane_index, vehicle.position_cells))
                self._road_vehicle_seconds[road_id] += 1
                vehicle.current_speed_kph = 0.0
            # Move downstream-first so a cell released by a leading car is available
            # only on the next tick; this prevents update-order advantages.
            movers = sorted(self.vehicles, key=lambda v: (-v.road_index, -v.position_cells, v.id))
            removed: set[int] = set()
            junctions_used: set[str] = set()
            for vehicle in movers:
                road_id = vehicle.route[vehicle.road_index]
                road = self._roads[road_id]
                last_cell = self._cells[road_id] - 1
                target = min(last_cell, vehicle.position_cells + max(1, math.floor(road.speed_limit_kph / 36)))
                current_cell = (vehicle.lane_index, vehicle.position_cells)
                target_cell = (vehicle.lane_index, target)
                path_clear = all((vehicle.lane_index, cell) not in occupancy[road_id]
                                 for cell in range(vehicle.position_cells + 1, target + 1))
                if target > vehicle.position_cells and path_clear:
                    distance_m = (target - current_cell[1]) * self.network.cell_length_m
                    occupancy[road_id].discard(current_cell)
                    occupancy[road_id].add(target_cell)
                    vehicle.position_cells = target
                    vehicle.distance_travelled_m += distance_m
                    vehicle.free_flow_seconds_travelled += distance_m / (road.speed_limit_kph / 3.6)
                    vehicle.current_speed_kph = distance_m * 3.6
                    self._total_distance_m += distance_m
                    self._road_distance_m[road_id] += distance_m
                if vehicle.position_cells < last_cell:
                    continue
                next_index = vehicle.road_index + 1
                if next_index == len(vehicle.route):
                    if self._capacity_credit[road_id] < 1:
                        queues_by_road[road_id] += 1
                        continue
                    self._capacity_credit[road_id] -= 1
                    removed.add(vehicle.id)
                    self._total_distance_m += self.network.cell_length_m
                    self._road_distance_m[road_id] += self.network.cell_length_m
                    vehicle.distance_travelled_m += self.network.cell_length_m
                    vehicle.free_flow_seconds_travelled += self.network.cell_length_m / (road.speed_limit_kph / 3.6)
                    self.completed_travel_times.append(self.time_seconds + 1 - vehicle.entered_at)
                    self.completed_free_flow_times.append(sum(
                        math.ceil(
                            self._cells[route_road]
                            / max(1, math.floor(self._roads[route_road].speed_limit_kph / 36))
                        )
                        for route_road in vehicle.route
                    ))
                    self._emit_event(
                        "vehicle", f"Vehicle #{vehicle.id} completed its route in {self.time_seconds + 1 - vehicle.entered_at}s.",
                        vehicle_id=vehicle.id, road_id=road_id, time_seconds=self.time_seconds + 1,
                        vehicle_distance_travelled_m=round(vehicle.distance_travelled_m, 2),
                        vehicle_travel_time_seconds=self.time_seconds + 1 - vehicle.entered_at,
                        vehicle_delay_seconds=round(max(0.0, self.time_seconds + 1 - vehicle.entered_at - vehicle.free_flow_seconds_travelled), 2),
                    )
                    occupancy[road_id].discard((vehicle.lane_index, vehicle.position_cells))
                    continue
                next_road_id = vehicle.route[next_index]
                next_road = self._roads[next_road_id]
                junction = road.to_junction
                if junction in junctions_used or self._capacity_credit[road_id] < 1:
                    queues_by_road[road_id] += 1
                    continue
                next_lane_load = [sum(1 for lane, _ in occupancy[next_road_id] if lane == lane_index)
                                  for lane_index in range(next_road.lane_count)]
                next_lane = min(range(next_road.lane_count), key=lambda lane: (next_lane_load[lane], lane))
                if not self._signal_allows(junction, road_id, next_road_id) or (next_lane, 0) in occupancy[next_road_id]:
                    queues_by_road[road_id] += 1
                    continue
                occupancy[road_id].discard((vehicle.lane_index, vehicle.position_cells))
                occupancy[next_road_id].add((next_lane, 0))
                vehicle.road_index = next_index
                vehicle.lane_index = next_lane
                vehicle.position_cells = 0
                self._total_distance_m += self.network.cell_length_m
                self._road_distance_m[road_id] += self.network.cell_length_m
                vehicle.distance_travelled_m += self.network.cell_length_m
                vehicle.free_flow_seconds_travelled += self.network.cell_length_m / (road.speed_limit_kph / 3.6)
                vehicle.current_speed_kph = self.network.cell_length_m * 3.6
                self._capacity_credit[road_id] -= 1
                junctions_used.add(junction)
            self.vehicles = [vehicle for vehicle in self.vehicles if vehicle.id not in removed]
            self._queues_by_road = queues_by_road
            self.time_seconds += 1

            new_signal_states = self._signal_states_at(self.time_seconds)
            for signal_id, (state, phase_index) in new_signal_states.items():
                if old_signal_states.get(signal_id) != (state, phase_index):
                    signal = next(item for item in self.network.signals if item.id == signal_id)
                    self._emit_event(
                        "signal", f"{signal.junction_id} signal changed to phase {phase_index + 1} ({state.upper()}).",
                        severity="warning" if state == "red" else "info",
                        junction_id=signal.junction_id, time_seconds=self.time_seconds,
                    )

            for road_id, road in self._roads.items():
                occupancy_ratio = self._road_occupancy(road_id)
                queue_length = self._queues_by_road[road_id]
                if old_queues[road_id] == 0 and queue_length > 0:
                    self._emit_event(
                        "queue", f"A queue formed on {road_id} ({queue_length} vehicle{'' if queue_length == 1 else 's'}).",
                        severity="warning", road_id=road_id, utilization=occupancy_ratio, time_seconds=self.time_seconds,
                    )
                elif old_queues[road_id] > 0 and queue_length == 0:
                    self._emit_event("queue", f"Queue cleared on {road_id}.", road_id=road_id, utilization=occupancy_ratio, time_seconds=self.time_seconds)
                if old_occupancy[road_id] < 0.75 <= occupancy_ratio:
                    self._emit_event(
                        "congestion", f"{road_id} reached {occupancy_ratio:.0%} storage utilization.",
                        severity="critical" if occupancy_ratio >= 0.9 else "warning",
                        road_id=road_id, utilization=occupancy_ratio, time_seconds=self.time_seconds,
                    )
                elif old_occupancy[road_id] >= 0.75 > occupancy_ratio:
                    self._emit_event("congestion", f"{road_id} congestion eased below 75% utilization.", road_id=road_id, utilization=occupancy_ratio, time_seconds=self.time_seconds)
                if road.kind == "flyover" and old_occupancy[road_id] == 0 < occupancy_ratio:
                    self._emit_event("infrastructure", f"Flyover entered service with {self._roads[road_id].id} now carrying traffic.", road_id=road_id, utilization=occupancy_ratio, time_seconds=self.time_seconds)
        return self.snapshot()

    def snapshot(self) -> dict:
        occupancy_by_road = {road_id: 0 for road_id in self._roads}
        for vehicle in self.vehicles:
            occupancy_by_road[vehicle.route[vehicle.road_index]] += 1
        road_metrics = {
            road_id: {
                "vehicles": count,
                "cell_capacity": self._cells[road_id] * road.lane_count,
                "occupancy_ratio": count / (self._cells[road_id] * road.lane_count),
                "queue_length": self._queues_by_road[road_id],
                    "average_speed_kph": (
                        self._road_distance_m[road_id] / self._road_vehicle_seconds[road_id] * 3.6
                        if self._road_vehicle_seconds[road_id] else None
                    ),
                    "speed_ratio": (
                        min(1.0, self._road_distance_m[road_id] / self._road_vehicle_seconds[road_id] * 3.6 / road.speed_limit_kph)
                        if self._road_vehicle_seconds[road_id] else None
                    ),
                    "density_vehicles_per_km_per_lane": (
                        count / (road.length_m / 1000 * road.lane_count)
                    ),
            }
            for road_id, (road, count) in ((key, (self._roads[key], value)) for key, value in occupancy_by_road.items())
        }
        signals = {}
        for signal in self.network.signals:
            cycle_length = sum(phase.duration_seconds for phase in signal.phases)
            phase_elapsed = (self.time_seconds + signal.cycle_offset_seconds) % cycle_length
            phase_index = 0
            for phase_index, phase in enumerate(signal.phases):
                if phase_elapsed < phase.duration_seconds:
                    break
                phase_elapsed -= phase.duration_seconds
            phase = signal.phases[phase_index]
            signals[signal.id] = {
                "junction_id": signal.junction_id,
                "state": "off" if not signal.enabled else phase.state or ("green" if phase.green_movements else "red"),
                "phase_index": phase_index,
                "remaining_seconds": phase.duration_seconds - phase_elapsed,
                "green_movements": phase.green_movements,
            }
        return {
            "time_seconds": self.time_seconds,
            "active_vehicles": len(self.vehicles),
            "completed_vehicles": len(self.completed_travel_times),
            "mean_trip_time_seconds": (sum(self.completed_travel_times) / len(self.completed_travel_times)) if self.completed_travel_times else None,
            "roads": road_metrics,
            "signals": signals,
            "metrics": self.metrics(),
            "vehicles": [
                {"id": v.id, "road_id": v.route[v.road_index], "lane_index": v.lane_index, "position_cells": v.position_cells, "destination": v.destination}
                | {
                    "vehicle_type": "car",
                    "origin": v.origin,
                    "route": v.route,
                    "route_junctions": [v.origin, *[self._roads[road_id].to_junction for road_id in v.route]],
                    "current_speed_kph": round(v.current_speed_kph, 3),
                    "distance_travelled_m": round(v.distance_travelled_m, 2),
                    "delay_seconds": round(max(0.0, self.time_seconds - v.entered_at - v.free_flow_seconds_travelled), 2),
                    "state": "queued" if v.position_cells == self._cells[v.route[v.road_index]] - 1 and self._queues_by_road[v.route[v.road_index]] > 0 else "moving" if v.current_speed_kph > 0 else "stopped",
                }
                for v in self.vehicles
            ],
            "events": [event.model_dump() for event in self._events],
        }

    def metrics(self) -> dict:
        total_storage = sum(self._cells[road.id] * road.lane_count for road in self.network.roads)
        occupied_storage = sum(
            self._cells[road.id] * road.lane_count * self._road_occupancy(road.id)
            for road in self.network.roads
        )
        average_travel_time = (
            sum(self.completed_travel_times) / len(self.completed_travel_times)
            if self.completed_travel_times else None
        )
        average_free_flow = (
            sum(self.completed_free_flow_times) / len(self.completed_free_flow_times)
            if self.completed_free_flow_times else None
        )
        return {
            "average_speed_kph": self._total_distance_m / self._vehicle_seconds * 3.6 if self._vehicle_seconds else 0.0,
            "average_travel_time_seconds": average_travel_time,
            "average_delay_seconds": max(0.0, average_travel_time - average_free_flow) if average_travel_time is not None and average_free_flow is not None else None,
            "throughput_vehicles_per_hour": len(self.completed_travel_times) / self.time_seconds * 3600 if self.time_seconds else 0.0,
            "queue_length": sum(self._queues_by_road.values()),
            "congestion_index": occupied_storage / total_storage if total_storage else 0.0,
            "road_utilization": {road_id: self._road_occupancy(road_id) for road_id in self._roads},
        }

    def _road_occupancy(self, road_id: str) -> float:
        occupied = sum(1 for vehicle in self.vehicles if vehicle.route[vehicle.road_index] == road_id)
        road = self._roads[road_id]
        return occupied / (self._cells[road_id] * road.lane_count)
