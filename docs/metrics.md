# Simulation metric definitions

All measurements use the simulation's fixed one-second steps. A road's storage capacity is its number of cells multiplied by its lane count.

| Metric | Definition |
|---|---|
| Average speed | Total distance moved, including completed trips, divided by all simulated vehicle-seconds, multiplied by 3.6 to convert m/s to km/h. Waiting vehicles contribute time but no distance. |
| Average travel time | Mean elapsed simulation seconds for completed trips only. It is `null` until a trip completes. |
| Average delay | Mean completed trip time minus estimated free-flow time. Free-flow time uses the same cell count and per-tick speed rule as the engine; it excludes signal delay and queues. It is `null` until a trip completes. |
| Throughput | Completed trips divided by elapsed simulation seconds, multiplied by 3,600. This is a run-to-date hourly rate, not a forecast. |
| Queue length | Vehicles at a road's final cell that cannot leave because of a red signal, downstream occupancy, a junction movement already admitted that tick, or insufficient configured capacity credit. |
| Congestion index | Current active vehicles divided by total network lane-cell storage. This is a weighted network occupancy ratio from 0 to 1. |
| Road utilization | For each road, active vehicles on the road divided by that road's lane-cell storage. |
| Road average speed | Distance recorded on the road divided by simulated vehicle-seconds spent on that road, multiplied by 3.6. It is `null` before any vehicle-seconds accrue. |
| Road speed ratio | Road average speed divided by that road's configured speed limit, capped at 1 for visualization. It is `null` when the road has no observations. |
| Road density | Current road vehicles divided by road length in kilometres and lane count, in vehicles/km/lane. The density heat layer uses occupancy as a fraction of the cell-storage limit (`1 / cell_length_m` vehicles/km/lane). |
| Active-vehicle delay | Elapsed time since network entry minus free-flow time for distance actually travelled at the configured speed limit of each traversed road, clamped at zero. This is an agent-level estimate; the network average delay remains based on completed trips only. |

The live event buffer contains at most the latest 100 transitions. Vehicle entry/completion, signal phase, queue, and congestion events are emitted only when the corresponding engine state changes. Signal phase transitions are reported even when successive phases both show a green aspect for different movements.

The live run duration is a session limit. When elapsed simulation time reaches it, the session pauses automatically. The dashboard timeline represents elapsed live time only; it does not provide historical playback.

Demand arrivals are not held in an off-road queue when every origin lane entry cell is occupied; `queue_length` counts only vehicles already on the network at a stop line. The metrics describe this simplified cell-based model and are not calibrated traffic-engineering estimates.
