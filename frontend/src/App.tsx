import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowRight, Bus, CarFront,
  Check, ChevronDown, CircleHelp, Clock3, Gauge, GitCompareArrows, Layers3,
  Lightbulb, LoaderCircle, Pause, Play, RotateCcw, Settings2, SlidersHorizontal,
  Sparkles, Timer, TrafficCone, TrendingUp, Truck,
} from 'lucide-react'

const API = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'

type Junction = { id: string; x: number; y: number; signal_id: string | null }
type Road = {
  id: string
  from_junction: string
  to_junction: string
  length_m: number
  lane_count: number
  speed_limit_kph: number
  capacity_vehicles_per_hour: number
  kind: 'road' | 'flyover'
}
type Signal = {
  id: string
  junction_id: string
  enabled: boolean
  cycle_offset_seconds: number
  phases: { duration_seconds: number; green_movements: string[]; state?: 'green' | 'yellow' | 'red' | null }[]
}
type Network = {
  id: string
  name: string
  cell_length_m: number
  junctions: Junction[]
  roads: Road[]
  signals: Signal[]
  demand: { origin: string; destination: string; vehicles_per_hour: number }[]
}
type Metrics = {
  average_speed_kph: number
  average_travel_time_seconds: number | null
  average_delay_seconds: number | null
  throughput_vehicles_per_hour: number
  queue_length: number
  congestion_index: number
  road_utilization: Record<string, number>
}
type RoadState = { vehicles: number; cell_capacity: number; occupancy_ratio: number; queue_length: number; average_speed_kph: number | null; speed_ratio: number | null; density_vehicles_per_km_per_lane: number }
type Vehicle = { id: number; vehicle_type: 'car'; origin: string; destination: string; route: string[]; route_junctions: string[]; road_id: string; lane_index: number; position_cells: number; current_speed_kph: number; distance_travelled_m: number; delay_seconds: number; state: 'moving' | 'stopped' | 'queued' | 'completed' }
type SignalState = { junction_id: string; state: 'green' | 'yellow' | 'red' | 'off'; phase_index: number; remaining_seconds: number; green_movements: string[] }
type SimulationEvent = { event_id: number; time_seconds: number; category: 'vehicle' | 'signal' | 'congestion' | 'queue' | 'infrastructure'; severity: 'info' | 'warning' | 'critical'; description: string; vehicle_id: number | null; road_id: string | null; junction_id: string | null; utilization: number | null; vehicle_distance_travelled_m: number | null; vehicle_travel_time_seconds: number | null; vehicle_delay_seconds: number | null }
type SimulationState = {
  session_id: string
  scenario_id: string
  seed: number
  status: 'paused' | 'running'
  speed_multiplier: number
  duration_seconds: number
  network: Network
  time_seconds: number
  active_vehicles: number
  completed_vehicles: number
  mean_trip_time_seconds: number | null
  roads: Record<string, RoadState>
  signals: Record<string, SignalState>
  vehicles: Vehicle[]
  events: SimulationEvent[]
  metrics: Metrics
}
type Comparison = {
  scenario_a: { id: string; name: string; metrics: Metrics; completed_vehicles: number }
  scenario_b: { id: string; name: string; metrics: Metrics; completed_vehicles: number }
  difference_b_minus_a: Record<string, number | null>
  duration_seconds: number
  seed: number
}
type HistoryPoint = {
  time: number
  active: number
  completed: number
  speed: number
  delay: number | null
  throughput: number
  congestion: number
}
type ApiStatus = 'checking' | 'online' | 'offline'
type ChartTab = 'Overview' | 'Speed' | 'Delay' | 'Throughput' | 'Congestion'
type HeatMode = 'Network' | 'Congestion' | 'Speed' | 'Density'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const payload = await response.json()
      detail = payload.detail ?? detail
    } catch { /* Keep the HTTP status when the response is not JSON. */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return response.json() as Promise<T>
}

function json(body: unknown): RequestInit { return { method: 'POST', body: JSON.stringify(body) } }
function format(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits })
}
function pointFrom(state: SimulationState): HistoryPoint {
  return {
    time: state.time_seconds,
    active: state.active_vehicles,
    completed: state.completed_vehicles,
    speed: state.metrics.average_speed_kph,
    delay: state.metrics.average_delay_seconds,
    throughput: state.metrics.throughput_vehicles_per_hour,
    congestion: state.metrics.congestion_index * 100,
  }
}
function phaseDuration(signal: Signal, state: 'yellow' | 'red'): number {
  return signal.phases.find((phase) => phase.state === state)?.duration_seconds ?? 0
}
function clockLabel(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function pathFor(road: Road, nodes: Record<string, Junction>): string {
  const from = nodes[road.from_junction]
  const to = nodes[road.to_junction]
  if (!from || !to) return ''
  if (road.kind !== 'flyover') return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const arch = Math.min(72, Math.max(34, length * 0.22))
  const cx = (from.x + to.x) / 2 - (dy / length) * arch
  const cy = (from.y + to.y) / 2 + (dx / length) * arch
  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`
}

function pointOnRoad(road: Road, nodes: Record<string, Junction>, t: number, laneIndex: number) {
  const from = nodes[road.from_junction]
  const to = nodes[road.to_junction]
  if (!from || !to) return { x: 0, y: 0 }
  const p = Math.max(0, Math.min(1, t))
  let x: number
  let y: number
  if (road.kind === 'flyover') {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy) || 1
    const arch = Math.min(72, Math.max(34, length * 0.22))
    const cx = (from.x + to.x) / 2 - (dy / length) * arch
    const cy = (from.y + to.y) / 2 + (dx / length) * arch
    x = (1 - p) ** 2 * from.x + 2 * (1 - p) * p * cx + p ** 2 * to.x
    y = (1 - p) ** 2 * from.y + 2 * (1 - p) * p * cy + p ** 2 * to.y
  } else {
    x = from.x + (to.x - from.x) * p
    y = from.y + (to.y - from.y) * p
  }
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const offset = (laneIndex - (road.lane_count - 1) / 2) * 4
  return { x: x - Math.sin(angle) * offset, y: y + Math.cos(angle) * offset }
}

function laneDividerPath(road: Road, nodes: Record<string, Junction>, divider: number): string {
  return Array.from({ length: 13 }, (_, index) => {
    const point = pointOnRoad(road, nodes, index / 12, divider - 0.5)
    return `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
  }).join(' ')
}

const TrafficMap = memo(function TrafficMap({ network, state, selectedRoadId, onSelectRoad, heatMode, selectedVehicleId, onSelectVehicle }: {
  network: Network
  state: SimulationState | null
  selectedRoadId: string
  onSelectRoad: (id: string) => void
  heatMode: HeatMode
  selectedVehicleId: number | null
  onSelectVehicle: (vehicle: Vehicle) => void
}) {
  const nodes = useMemo(() => Object.fromEntries(network.junctions.map((node) => [node.id, node])), [network.junctions])
  const bounds = useMemo(() => {
    const xs = network.junctions.map((node) => node.x)
    const ys = network.junctions.map((node) => node.y)
    const minX = Math.min(...xs) - 55
    const maxX = Math.max(...xs) + 58
    const minY = Math.min(...ys) - 78
    const maxY = Math.max(...ys) + 64
    return `${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`
  }, [network.junctions])
  const vehiclesByRoad = useMemo(() => {
    const grouped: Record<string, Vehicle[]> = {}
    for (const vehicle of state?.vehicles ?? []) (grouped[vehicle.road_id] ??= []).push(vehicle)
    return grouped
  }, [state?.vehicles])
  const geometry = useMemo(() => Object.fromEntries(network.roads.map((road) => {
    const from = nodes[road.from_junction]
    const to = nodes[road.to_junction]
    const mid = from && to ? pointOnRoad(road, nodes, 0.5, Math.floor(road.lane_count / 2)) : { x: 0, y: 0 }
    return [road.id, {
      path: pathFor(road, nodes),
      mid,
      angle: from && to ? Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI : 0,
      cells: Math.max(1, Math.ceil(road.length_m / network.cell_length_m)),
      dividers: Array.from({ length: Math.max(0, road.lane_count - 1) }, (_, index) => laneDividerPath(road, nodes, index + 1)),
    }]
  })), [network.roads, network.cell_length_m, nodes])

  return (
    <svg className="network-svg" viewBox={bounds} role="group" aria-labelledby="network-title network-description">
      <title id="network-title">Live road network</title>
      <desc id="network-description">Model-driven network. Vehicle markers show current backend positions. Road tint shows actual lane-cell utilization.</desc>
      <defs>
        <pattern id="network-grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.65" fill="#7e9ca8" opacity="0.16" /></pattern>
        <filter id="vehicle-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <rect x={Math.min(...network.junctions.map((node) => node.x)) - 100} y={Math.min(...network.junctions.map((node) => node.y)) - 130} width="1000" height="700" fill="url(#network-grid)" pointerEvents="none" />
      {network.roads.map((road) => {
        const roadState = state?.roads[road.id]
        const occupancy = roadState?.occupancy_ratio ?? 0
        const congestionClass = occupancy >= 0.75 ? 'road-heavy' : occupancy >= 0.4 ? 'road-moderate' : 'road-free'
        const speedRatio = roadState?.speed_ratio
        const speedClass = speedRatio == null ? 'heat-no-data' : speedRatio >= 0.75 ? 'heat-fast' : speedRatio >= 0.4 ? 'heat-moderate' : 'heat-slow'
        const densityClass = !roadState ? 'heat-no-data' : occupancy >= 0.75 ? 'heat-dense' : occupancy >= 0.4 ? 'heat-moderate' : 'heat-light'
        const styleClass = heatMode === 'Network' ? 'road-network' : heatMode === 'Speed' ? speedClass : heatMode === 'Density' ? densityClass : congestionClass
        const { path: d, mid, angle, cells, dividers } = geometry[road.id]
        const density = roadState?.density_vehicles_per_km_per_lane ?? 0
        return (
          <g key={road.id} className={`road-group ${selectedRoadId === road.id ? 'road-selected' : ''}`} role="button" tabIndex={0}
            aria-label={`${road.id}, ${road.lane_count} lanes, utilization ${Math.round(occupancy * 100)} percent${roadState?.average_speed_kph == null ? '' : `, average speed ${format(roadState.average_speed_kph)} km/h`}`}
            onClick={() => onSelectRoad(road.id)}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectRoad(road.id) } }}>
            <title>{`${road.id}: ${road.lane_count} lanes · ${format(occupancy * 100, 0)}% utilized · ${roadState?.average_speed_kph == null ? 'speed no data' : `${format(roadState.average_speed_kph)} km/h`} · ${format(density, 1)} vehicles/km/lane · ${road.capacity_vehicles_per_hour} vehicles/hour`}</title>
            <path d={d} className={`road-casing ${road.kind === 'flyover' ? 'flyover-casing' : ''}`} strokeWidth={11 + road.lane_count * 5} />
            <path d={d} className="road-bed" strokeWidth={8 + road.lane_count * 5} />
            <path d={d} className={`road-load ${styleClass}`} strokeWidth={5 + road.lane_count * 3} />
            {dividers.map((divider, index) => <path key={`${road.id}-lane-${index}`} d={divider} className="lane-divider" />)}
            {road.kind === 'flyover' && <path d={d} className="flyover-center" />}
            <g className="road-tag"><rect x={mid.x - 21} y={mid.y - 14} width="42" height="11" rx="4" /><text x={mid.x} y={mid.y - 6}>{road.kind === 'flyover' ? 'FLYOVER' : `${road.lane_count} LANE${road.lane_count > 1 ? 'S' : ''}`}</text></g>
            {(vehiclesByRoad[road.id] ?? []).map((vehicle) => {
              const fraction = cells <= 1 ? 0.5 : vehicle.position_cells / (cells - 1)
              const point = pointOnRoad(road, nodes, fraction, vehicle.lane_index)
              return <g key={vehicle.id} className={`vehicle-agent ${vehicle.id === selectedVehicleId ? 'vehicle-selected' : ''}`} transform={`translate(${point.x} ${point.y}) rotate(${angle})`} filter="url(#vehicle-glow)" role="button" tabIndex={0} aria-label={`Inspect vehicle ${vehicle.id}, ${vehicle.state}, ${format(vehicle.current_speed_kph)} kilometers per hour`} onClick={(event) => { event.stopPropagation(); onSelectVehicle(vehicle) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelectVehicle(vehicle) } }}><rect x="-4.2" y="-2.4" width="8.4" height="4.8" rx="1.5" /><rect className="vehicle-canopy" x="-1.5" y="-1.55" width="3.4" height="3.1" rx="0.7" /><title>Vehicle {vehicle.id} · {vehicle.state} · {format(vehicle.current_speed_kph)} km/h · lane {vehicle.lane_index + 1} · destination {vehicle.destination}</title></g>
            })}
          </g>
        )
      })}
      {network.junctions.map((junction) => {
        const signalId = junction.signal_id
        const signal = signalId ? state?.signals[signalId] : undefined
        const fallback = signalId ? network.signals.find((item) => item.id === signalId) : undefined
      const firstPhase = fallback?.phases[0]
      const light = signal?.state ?? (fallback?.enabled ? firstPhase?.state ?? (firstPhase?.green_movements.length ? 'green' : 'red') : 'off')
        return <g key={junction.id} className="junction-group"><circle className="junction-halo" cx={junction.x} cy={junction.y} r="11" /><circle className="junction-core" cx={junction.x} cy={junction.y} r="5.4" /><text x={junction.x + 12} y={junction.y + 3} className="junction-label">{junction.id}</text>
          {signalId && <g className="map-signal" aria-label={`Traffic light ${signalId}: ${light}`} transform={`translate(${junction.x - 6} ${junction.y - 33})`}><rect width="12" height="27" rx="5" className="signal-housing" /><circle cx="6" cy="6" r="2.4" className={light === 'red' ? 'lamp-red active' : 'lamp-red'} /><circle cx="6" cy="13.5" r="2.4" className={light === 'yellow' ? 'lamp-yellow active' : 'lamp-yellow'} /><circle cx="6" cy="21" r="2.4" className={light === 'green' ? 'lamp-green active' : 'lamp-green'} /><title>{signalId}: {light}{signal ? ` · ${signal.remaining_seconds}s remaining` : ''}</title></g>}
        </g>
      })}
    </svg>
  )
})

const chartConfig: Record<ChartTab, { key: keyof HistoryPoint; title: string; unit: string; color: string; value: (point: HistoryPoint) => number | null }> = {
  Overview: { key: 'active', title: 'Active vehicles', unit: 'vehicles', color: '#53d5c9', value: (point) => point.active },
  Speed: { key: 'speed', title: 'Average speed', unit: 'km/h', color: '#53d5c9', value: (point) => point.speed },
  Delay: { key: 'delay', title: 'Average delay', unit: 'seconds', color: '#f2ae67', value: (point) => point.delay },
  Throughput: { key: 'throughput', title: 'Throughput', unit: 'vehicles/hour', color: '#88a9ff', value: (point) => point.throughput },
  Congestion: { key: 'congestion', title: 'Congestion index', unit: '% storage occupied', color: '#ff8177', value: (point) => point.congestion },
}

function AnalyticsChart({ tab, history }: { tab: ChartTab; history: HistoryPoint[] }) {
  const config = chartConfig[tab]
  const values = history.map((point) => ({ time: point.time, value: config.value(point) })).filter((point): point is { time: number; value: number } => point.value != null && Number.isFinite(point.value))
  const width = 740
  const height = 178
  const left = 46
  const right = 16
  const top = 14
  const bottom = 27
  const innerWidth = width - left - right
  const innerHeight = height - top - bottom
  const minValue = values.length ? Math.min(0, ...values.map((point) => point.value)) : 0
  const maxValue = values.length ? Math.max(1, ...values.map((point) => point.value)) : 1
  const span = maxValue - minValue || 1
  const points = values.map((point, index) => ({
    x: left + (values.length <= 1 ? innerWidth : index * innerWidth / (values.length - 1)),
    y: top + innerHeight - (point.value - minValue) / span * innerHeight,
    ...point,
  }))
  const line = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
  const lastPoint = points[points.length - 1]
  const lastValue = values[values.length - 1]
  const lastHistory = history[history.length - 1]
  const fill = points.length ? `${line} L ${lastPoint.x} ${top + innerHeight} L ${points[0].x} ${top + innerHeight} Z` : ''

  return <div className="analytics-chart">
    <div className="chart-heading"><div><p className="micro-label">{config.title}</p><strong>{values.length ? `${format(lastValue.value, 1)} ${config.unit}` : 'Waiting for simulation data'}</strong></div><span>{history.length ? `T+${history[0].time}s — T+${lastHistory.time}s` : 'No run history yet'}</span></div>
    {values.length < 2 ? <div className="chart-empty"><Activity size={19} /><span>Run or step a simulation to draw a metric history.</span></div> : <svg className="analytics-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${config.title} over simulation time in ${config.unit}`}>
      {[0, 0.5, 1].map((fraction) => { const y = top + innerHeight * fraction; const value = maxValue - span * fraction; return <g key={fraction}><line x1={left} x2={width - right} y1={y} y2={y} className="chart-gridline" /><text x={left - 8} y={y + 3} textAnchor="end" className="chart-tick">{format(value, 0)}</text></g> })}
      <path d={fill} fill={config.color} opacity="0.09" />
      <path d={line} fill="none" stroke={config.color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" className="chart-line" />
      <circle cx={lastPoint.x} cy={lastPoint.y} r="4" fill={config.color} className="chart-last-point"><title>{config.title}: {format(lastPoint.value)} {config.unit}</title></circle>
      <text x={left} y={height - 5} className="chart-tick">T+{values[0].time}s</text><text x={width - right} y={height - 5} textAnchor="end" className="chart-tick">T+{lastValue.time}s</text>
    </svg>}
  </div>
}

function VehicleInspector({ vehicle, onClose }: { vehicle: Vehicle; onClose: () => void }) {
  return <aside className="vehicle-inspector" aria-label={`Vehicle ${vehicle.id} inspection`}>
    <div className="inspection-header"><div><span className="eyebrow">AGENT INSPECTION</span><h3>Vehicle #{vehicle.id}</h3></div><button className="icon-button" aria-label="Close vehicle inspection" onClick={onClose}>×</button></div>
    <div className="inspection-status"><span className={`inspection-state state-${vehicle.state}`}>{vehicle.state.toUpperCase()}</span><span>{vehicle.vehicle_type.toUpperCase()}</span></div>
    <dl className="inspection-grid">
      <div><dt>Current road</dt><dd>{vehicle.state === 'completed' ? 'Route complete' : vehicle.road_id}</dd></div>
      <div><dt>Current speed</dt><dd>{format(vehicle.current_speed_kph)} km/h</dd></div>
      <div><dt>Distance travelled</dt><dd>{format(vehicle.distance_travelled_m / 1000, 2)} km</dd></div>
      <div><dt>Estimated delay</dt><dd>{format(vehicle.delay_seconds, 1)} sec</dd></div>
      <div className="inspection-route"><dt>Junction route</dt><dd>{vehicle.route_junctions.join(' → ')}</dd><dt>Road links</dt><dd>{vehicle.route.join(' · ')}</dd></div>
    </dl>
  </aside>
}

function EventStream({ events }: { events: SimulationEvent[] }) {
  return <section className="glass-panel event-panel" aria-label="Live traffic events">
    <div className="event-heading"><div><span className="eyebrow">MODEL STATE TRANSITIONS</span><h2>Live events</h2></div><span className="event-count">{events.length} retained</span></div>
    {events.length ? <ol className="event-list">{[...events].reverse().slice(0, 12).map((event) => <li key={event.event_id} className={`event-row event-${event.severity}`}>
      <span className={`event-icon event-icon-${event.category}`} aria-hidden="true">{event.category === 'signal' ? <Lightbulb size={13} /> : event.category === 'vehicle' ? <CarFront size={13} /> : event.category === 'queue' ? <TrafficCone size={13} /> : <Activity size={13} />}</span>
      <time dateTime={`PT${event.time_seconds}S`}>{String(Math.floor(event.time_seconds / 60)).padStart(2, '0')}:{String(event.time_seconds % 60).padStart(2, '0')}</time>
      <span className="event-category">{event.category}</span><p>{event.description}</p>
    </li>)}</ol> : <div className="event-empty"><Activity size={15} /><span>Events appear when agents, signals, queues or road conditions change.</span></div>}
  </section>
}

type ComparisonMetric = { label: string; unit: string; baseline: number | null; alternative: number | null; direction: 'up' | 'down' }
function comparisonMetrics(comparison: Comparison): ComparisonMetric[] {
  return [
    { label: 'Average speed', unit: 'km/h', baseline: comparison.scenario_a.metrics.average_speed_kph, alternative: comparison.scenario_b.metrics.average_speed_kph, direction: 'up' },
    { label: 'Average delay', unit: 'sec', baseline: comparison.scenario_a.metrics.average_delay_seconds, alternative: comparison.scenario_b.metrics.average_delay_seconds, direction: 'down' },
    { label: 'Throughput', unit: 'veh/hr', baseline: comparison.scenario_a.metrics.throughput_vehicles_per_hour, alternative: comparison.scenario_b.metrics.throughput_vehicles_per_hour, direction: 'up' },
    { label: 'Queue length', unit: 'vehicles', baseline: comparison.scenario_a.metrics.queue_length, alternative: comparison.scenario_b.metrics.queue_length, direction: 'down' },
    { label: 'Congestion', unit: '% storage', baseline: comparison.scenario_a.metrics.congestion_index * 100, alternative: comparison.scenario_b.metrics.congestion_index * 100, direction: 'down' },
    { label: 'Vehicles completed', unit: 'vehicles', baseline: comparison.scenario_a.completed_vehicles, alternative: comparison.scenario_b.completed_vehicles, direction: 'up' },
  ]
}

function ComparisonDashboard({ comparison, onCompare, busy }: { comparison: Comparison | null; onCompare: () => void; busy: boolean }) {
  const rows = comparison ? comparisonMetrics(comparison) : []
  const highlightRows = rows.filter((row) => ['Average delay', 'Throughput'].includes(row.label))
  return <section className="glass-panel comparison-panel" aria-label="Infrastructure impact comparison">
    <div className="comparison-heading"><div><div className="eyebrow-row"><GitCompareArrows size={14} /><span className="eyebrow">MATCHED-SEED ANALYSIS</span></div><h2>Infrastructure impact</h2><p>Compare a baseline route plan against the same demand with a flyover available.</p></div>
      <button className="compare-button" onClick={onCompare} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <GitCompareArrows size={14} />}{busy ? 'Calculating…' : comparison ? 'Recalculate' : 'Run comparison'}</button></div>
    {comparison ? <>
      <div className="comparison-scenarios"><div><span className="scenario-dot baseline-dot" /><small>BASELINE</small><strong>{comparison.scenario_a.name}</strong></div><span className="scenario-vs">VS</span><div><span className="scenario-dot alternative-dot" /><small>ALTERNATIVE</small><strong>{comparison.scenario_b.name}</strong></div><span className="comparison-horizon">{format(comparison.duration_seconds, 0)} sec · seed {comparison.seed}</span></div>
      <div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th scope="col">Metric</th><th scope="col">Baseline</th><th scope="col">Alternative</th><th scope="col">Δ alternative − baseline</th><th scope="col">Outcome</th></tr></thead><tbody>{rows.map((row) => {
        const difference = row.baseline == null || row.alternative == null ? null : row.alternative - row.baseline
        const improvement = difference == null ? null : row.direction === 'up' ? difference : -difference
        const percent = improvement == null || row.baseline == null || row.baseline === 0 ? null : improvement / Math.abs(row.baseline) * 100
        const outcome = improvement == null ? 'unavailable' : improvement > 0 ? 'improvement' : improvement < 0 ? 'deterioration' : 'unchanged'
        return <tr key={row.label}><th scope="row">{row.label}</th><td>{format(row.baseline)} <small>{row.unit}</small></td><td>{format(row.alternative)} <small>{row.unit}</small></td><td className={difference != null && difference > 0 ? 'delta-up' : difference != null && difference < 0 ? 'delta-down' : ''}>{difference == null ? '—' : `${difference > 0 ? '+' : ''}${format(difference)} ${row.unit}`}</td><td><span className={`outcome outcome-${outcome}`}>{outcome === 'improvement' ? '↑' : outcome === 'deterioration' ? '↓' : '→'} {percent == null ? outcome : `${outcome} ${Math.abs(percent).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}</span></td></tr>
      })}</tbody></table></div>
      <div className="comparison-highlights">{highlightRows.map((row) => {
        const delta = row.baseline == null || row.alternative == null ? null : row.direction === 'up' ? row.alternative - row.baseline : row.baseline - row.alternative
        const percent = delta == null || row.baseline == null || row.baseline === 0 ? null : delta / Math.abs(row.baseline) * 100
        const positive = delta != null && delta > 0
        return <div className={`comparison-highlight ${positive ? 'highlight-good' : delta != null && delta < 0 ? 'highlight-poor' : 'highlight-flat'}`} key={row.label}><span>{positive ? '↑' : delta != null && delta < 0 ? '↓' : '→'}</span><strong>{percent == null ? '—' : `${percent > 0 ? '+' : ''}${format(percent)}%`}</strong><small>{row.label} · {delta == null ? 'not measurable' : positive ? 'improved' : delta < 0 ? 'deteriorated' : 'unchanged'}</small></div>
      })}</div>
    </> : <div className="comparison-empty"><GitCompareArrows size={18} /><div><strong>No matched run yet</strong><p>Both networks will use the same demand, random seed and selected duration.</p></div></div>}
  </section>
}

export default function App() {
  const [network, setNetwork] = useState<Network | null>(null)
  const [baseNetwork, setBaseNetwork] = useState<Network | null>(null)
  const [simulation, setSimulation] = useState<SimulationState | null>(null)
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [events, setEvents] = useState<SimulationEvent[]>([])
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [heatMode, setHeatMode] = useState<HeatMode>('Network')
  const [inspectedVehicle, setInspectedVehicle] = useState<Vehicle | null>(null)
  const [chartTab, setChartTab] = useState<ChartTab>('Overview')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [seed, setSeed] = useState(42)
  const [speed, setSpeed] = useState(1)
  const [durationSeconds, setDurationSeconds] = useState(600)
  const [demandPreset, setDemandPreset] = useState<'Low' | 'Medium' | 'High' | 'Custom'>('Medium')
  const [selectedRoadId, setSelectedRoadId] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [preset, setPreset] = useState('sample')
  const [savedScenarioId, setSavedScenarioId] = useState('')

  const commitSimulation = (next: SimulationState, resetHistory = false) => {
    setSimulation(next)
    setSpeed(next.speed_multiplier)
    const point = pointFrom(next)
    setHistory((previous) => {
      if (resetHistory) return [point]
      if (previous[previous.length - 1]?.time === point.time) return [...previous.slice(0, -1), point]
      return [...previous, point].slice(-90)
    })
    setEvents((previous) => {
      const merged = resetHistory ? next.events : [...previous, ...next.events.filter((event) => !previous.some((item) => item.event_id === event.event_id))]
      return merged.slice(-40)
    })
    setInspectedVehicle((previous) => {
      if (!previous) return previous
      const active = next.vehicles.find((vehicle) => vehicle.id === previous.id)
      if (active) return active
      const completed = next.events.find((event) => event.vehicle_id === previous.id && event.vehicle_distance_travelled_m != null)
      return completed ? { ...previous, state: 'completed', current_speed_kph: 0, distance_travelled_m: completed.vehicle_distance_travelled_m ?? previous.distance_travelled_m, delay_seconds: completed.vehicle_delay_seconds ?? previous.delay_seconds } : previous
    })
  }

  const loadSample = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const sample = await request<Network>('/api/networks/sample')
      setNetwork(sample)
      setBaseNetwork(sample)
      setPreset('sample')
      setDemandPreset((sample.demand[0]?.vehicles_per_hour ?? 0) === 900 ? 'Medium' : 'Custom')
      setSelectedRoadId(sample.roads.find((road) => road.kind !== 'flyover')?.id ?? sample.roads[0]?.id ?? '')
      setSimulation(null)
      setHistory([])
      setEvents([])
      setInspectedVehicle(null)
      setComparison(null)
      setApiStatus('online')
      setNotice('Sample network connected')
    } catch (cause) {
      setApiStatus('offline')
      setError(cause instanceof Error ? cause.message : 'Could not load the sample network')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadSample() }, [loadSample])

  useEffect(() => {
    if (!simulation || simulation.status !== 'running') return
    const timer = window.setInterval(async () => {
      try {
        const next = await request<SimulationState>(`/api/simulations/${simulation.session_id}`)
        setApiStatus('online')
        commitSimulation(next)
      } catch (cause) {
        setApiStatus('offline')
        setError(cause instanceof Error ? cause.message : 'Simulation update failed')
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [simulation?.session_id, simulation?.status])

  const updateNetwork = (change: (previous: Network) => Network) => {
    setNetwork((previous) => {
      if (!previous) return previous
      const next = change(previous)
      setSelectedRoadId((selected) => next.roads.some((road) => road.id === selected) ? selected : next.roads[0]?.id ?? '')
      return next
    })
    setSimulation(null)
    setHistory([])
    setEvents([])
    setInspectedVehicle(null)
    setComparison(null)
    setSavedScenarioId('')
    setNotice('Scenario edits are ready to apply')
  }

  const applyDemandPreset = (presetName: 'Low' | 'Medium' | 'High') => {
    const vehiclesPerHour = presetName === 'Low' ? 450 : presetName === 'Medium' ? 900 : 1800
    setDemandPreset(presetName)
    updateNetwork((previous) => ({ ...previous, demand: previous.demand.length
      ? [{ ...previous.demand[0], vehicles_per_hour: vehiclesPerHour }, ...previous.demand.slice(1)]
      : [] }))
  }

  const changeDuration = (value: number) => {
    setDurationSeconds(value)
    setSimulation(null)
    setHistory([])
    setEvents([])
    setComparison(null)
    setSavedScenarioId('')
    setNotice('Run duration changed · apply the scenario before starting a new run')
  }

  const changeSeed = (value: number) => {
    const next = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
    setSeed(next)
    setSimulation(null)
    setHistory([])
    setEvents([])
    setComparison(null)
    setSavedScenarioId('')
    setNotice('Seed changed · apply the scenario before starting a new run')
  }

  const setSignalPhase = (signalId: string, state: 'yellow' | 'red', duration: number) => updateNetwork((previous) => ({
    ...previous,
    signals: previous.signals.map((signal) => {
      if (signal.id !== signalId) return signal
      const existingIndex = signal.phases.findIndex((phase) => phase.state === state)
      const phases = [...signal.phases]
      if (duration === 0) {
        if (existingIndex >= 0) phases.splice(existingIndex, 1)
      } else if (existingIndex >= 0) {
        phases[existingIndex] = { ...phases[existingIndex], duration_seconds: duration, green_movements: [], state }
      } else {
        phases.push({ duration_seconds: duration, green_movements: [], state })
      }
      return { ...signal, phases }
    }),
  }))

  const ensureSession = async (): Promise<SimulationState> => {
    if (!network) throw new Error('Load a network before starting a simulation')
    const validation = await request<{ valid: boolean; warnings: string[] }>('/api/scenarios/validate', json(network))
    if (!validation.valid) throw new Error('Scenario validation failed')
    const saved = await request<Network>('/api/scenarios', json(network))
    const created = await request<SimulationState>('/api/simulations', json({ scenario_id: saved.id, seed, speed_multiplier: speed, duration_seconds: durationSeconds }))
    setSavedScenarioId(saved.id)
    commitSimulation(created, true)
    return created
  }

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try { await action() } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request could not be completed')
    } finally { setBusy(false) }
  }

  const applyScenario = () => runAction(async () => {
    if (!network) return
    const validation = await request<{ valid: boolean; warnings: string[] }>('/api/scenarios/validate', json(network))
    if (!validation.valid) throw new Error('Scenario validation failed')
    const saved = await request<Network>('/api/scenarios', json(network))
    setSavedScenarioId(saved.id)
    setNotice(validation.warnings.length ? `Applied with notes: ${validation.warnings.join(' · ')}` : `Scenario applied: ${saved.name}`)
  })

  const startOrResume = () => runAction(async () => {
    const current = simulation ?? await ensureSession()
    const next = await request<SimulationState>(`/api/simulations/${current.session_id}/start`, json({}))
    setApiStatus('online')
    commitSimulation(next)
    setNotice('Simulation running')
  })

  const pause = () => simulation && runAction(async () => {
    const next = await request<SimulationState>(`/api/simulations/${simulation.session_id}/pause`, json({}))
    commitSimulation(next)
    setNotice('Simulation paused')
  })

  const step = () => runAction(async () => {
    const current = simulation ?? await ensureSession()
    const next = await request<SimulationState>(`/api/simulations/${current.session_id}/step`, json({ steps: 1 }))
    setApiStatus('online')
    commitSimulation(next)
  })

  const reset = () => simulation && runAction(async () => {
    const next = await request<SimulationState>(`/api/simulations/${simulation.session_id}/reset`, json({}))
    commitSimulation(next, true)
    setNotice('Simulation reset · ready at T+0')
  })

  const changeSpeed = (value: number) => {
    setSpeed(value)
    if (simulation) void runAction(async () => {
      const next = await request<SimulationState>(`/api/simulations/${simulation.session_id}/speed`, json({ speed_multiplier: value }))
      commitSimulation(next)
    })
  }

  const compare = () => runAction(async () => {
    if (!network) return
    const baseline: Network = { ...network, id: `${network.id}-baseline`, name: 'Baseline · no flyover', roads: network.roads.filter((road) => road.kind !== 'flyover') }
    const flyover = network.roads.find((road) => road.kind === 'flyover')
    const originalFlyover = baseNetwork?.roads.find((road) => road.kind === 'flyover')
    const scenarioB: Network = { ...network, id: `${network.id}-flyover`, name: 'Flyover · alternative route', roads: [...network.roads.filter((road) => road.kind !== 'flyover'), flyover ?? originalFlyover].filter((road): road is Road => Boolean(road)) }
    const result = await request<Comparison>('/api/scenarios/compare', json({ scenario_a: baseline, scenario_b: scenarioB, duration_seconds: durationSeconds, seed }))
    setComparison(result)
  })

  const selectPreset = (value: string) => {
    if (!baseNetwork) return
    setPreset(value)
    const selected = value === 'baseline'
      ? { ...baseNetwork, id: `${baseNetwork.id}-baseline`, name: 'Sample Corridor · Baseline', roads: baseNetwork.roads.filter((road) => road.kind !== 'flyover') }
      : baseNetwork
    setNetwork(selected)
    setDemandPreset(selected.demand[0]?.vehicles_per_hour === 450 ? 'Low' : selected.demand[0]?.vehicles_per_hour === 900 ? 'Medium' : selected.demand[0]?.vehicles_per_hour === 1800 ? 'High' : 'Custom')
    setSelectedRoadId(selected.roads[0]?.id ?? '')
    setSimulation(null)
    setHistory([])
    setEvents([])
    setInspectedVehicle(null)
    setComparison(null)
    setSavedScenarioId('')
    setNotice(value === 'baseline' ? 'Baseline loaded · flyover removed from network model' : 'Sample network loaded')
  }

  const selectedRoad = network?.roads.find((road) => road.id === selectedRoadId)
  const metrics = simulation?.metrics
  const isRunning = simulation?.status === 'running'
  const isComplete = Boolean(simulation && simulation.time_seconds >= simulation.duration_seconds)
  const signals = simulation?.signals ?? {}
  const currentInspection = inspectedVehicle && simulation?.vehicles.find((vehicle) => vehicle.id === inspectedVehicle.id) || inspectedVehicle
  const bottlenecks = useMemo(() => network ? [...network.roads]
    .map((road) => ({ road, value: simulation?.roads[road.id]?.occupancy_ratio ?? 0, queue: simulation?.roads[road.id]?.queue_length ?? 0 }))
    .sort((a, b) => b.value - a.value || b.queue - a.queue).slice(0, 3) : [], [network, simulation?.roads])

  if (loading) return <main className="loading-screen" aria-live="polite"><div className="loading-mark"><Activity size={20} /></div><span>Connecting to TrafficFlow network…</span><div className="skeleton-bar" /></main>

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-lockup"><div className="brand-mark"><TrafficCone size={19} strokeWidth={1.8} /></div><div><div className="brand-name">TRAFFIC<span>FLOW</span></div><div className="brand-tagline">Agent-Based Mobility Intelligence</div></div></div>
      <div className="nav-status">
        <span className={`live-status ${isRunning ? 'live-on' : ''}`}><i />{isRunning ? 'LIVE SIMULATION' : simulation ? 'PAUSED SIMULATION' : 'SIMULATION READY'}</span>
        <span className={`api-status api-${apiStatus}`}><i />API {apiStatus === 'checking' ? 'CHECKING' : apiStatus.toUpperCase()}</span>
        <div className="nav-time"><Clock3 size={14} /><span>T+ {simulation?.time_seconds ?? 0}s</span></div>
        <button className="icon-button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Open settings" aria-expanded={settingsOpen}><Settings2 size={16} /></button>
        <button className="nav-reset" onClick={reset} disabled={!simulation || busy}><RotateCcw size={13} />Reset</button>
        {settingsOpen && <div className="settings-popover" role="dialog" aria-label="Simulation settings"><div className="popover-title"><Settings2 size={14} />Connection & model</div><p>API endpoint</p><code>{API}</code><p>One engine tick represents one simulation second. Sessions are held in backend memory.</p><button className="text-button" onClick={() => setSettingsOpen(false)}>Close</button></div>}
      </div>
    </header>

    {error && <div className="message error-message" role="alert"><AlertTriangle size={16} /><span>{error}</span><button className="text-button" onClick={() => setError('')} aria-label="Dismiss error">Dismiss</button></div>}
    {notice && <div className="message notice-message" role="status" aria-live="polite"><Check size={14} /><span>{notice}</span></div>}

    <section className="hero-bar">
      <div className="hero-copy"><div className="hero-kicker"><span className="kicker-line" />URBAN MOBILITY LAB</div><h1>Traffic Simulation</h1><p>Explore how infrastructure, traffic demand and signal timing shape urban mobility.</p></div>
      <div className="hero-actions">
        <label className="scenario-select-wrap"><span>SCENARIO</span><div className="select-shell"><Layers3 size={14} /><select aria-label="Select scenario" disabled={isRunning} value={preset} onChange={(event) => selectPreset(event.target.value)}><option value="sample">Sample corridor · flyover</option><option value="baseline">Baseline · no flyover</option></select><ChevronDown size={13} /></div></label>
        {isRunning ? <button className="action-button action-pause" onClick={pause} disabled={busy}><Pause size={15} fill="currentColor" />Pause</button> : <button className={`action-button ${isComplete ? 'action-pause' : 'action-run'}`} onClick={startOrResume} disabled={busy || !network || isComplete}>{busy ? <LoaderCircle className="spin" size={15} /> : isComplete ? <Check size={15} /> : <Play size={15} fill="currentColor" />}{busy ? 'Working…' : isComplete ? 'Run complete' : simulation ? 'Resume simulation' : 'Run simulation'}</button>}
        {!isRunning && <button className="action-button action-step" onClick={step} disabled={busy || !network || isComplete} aria-label="Advance one simulation second" data-tooltip="Advance one simulation second"><ArrowRight size={14} />Step</button>}
        <label className="speed-select-wrap"><span>SPEED</span><div className="select-shell speed-shell"><Gauge size={14} /><select aria-label="Simulation speed" value={speed} onChange={(event) => changeSpeed(Number(event.target.value))}>{[0.5, 1, 2, 4, 8].map((value) => <option key={value} value={value}>{value}×</option>)}</select><ChevronDown size={13} /></div></label>
        <button className="icon-button hero-reset" onClick={reset} disabled={!simulation || busy} aria-label="Reset simulation" data-tooltip="Reset run to time zero"><RotateCcw size={15} /></button>
      </div>
    </section>

    {!network ? <section className="empty-state"><div className="empty-icon"><AlertTriangle size={20} /></div><h2>Network unavailable</h2><p>Check that the FastAPI server is running, then reconnect.</p><button className="action-button action-run" onClick={() => void loadSample()}>Reconnect API</button></section> : <>
      <div className="workspace-grid">
        <aside className="glass-panel config-panel" aria-label="Scenario configuration">
          <div className="panel-heading"><div className="heading-icon"><SlidersHorizontal size={15} /></div><div><span className="eyebrow">INPUT PARAMETERS</span><h2>Scenario Configuration</h2></div></div>
          <div className="config-body">
            <section className="config-section">
              <div className="config-section-title"><div><span className="eyebrow">01 · DEMAND</span><h3>Traffic demand</h3></div><span className="control-value">{format(network.demand[0]?.vehicles_per_hour ?? 0, 0)} <small>veh/hr</small></span></div>
              <label className="sr-label" htmlFor="demand-rate">Traffic demand in vehicles per hour</label>
              <input id="demand-rate" className="styled-range" type="range" min="0" max="7200" step="100" disabled={isRunning} value={network.demand[0]?.vehicles_per_hour ?? 0} onChange={(event) => { setDemandPreset('Custom'); updateNetwork((prev) => ({ ...prev, demand: prev.demand.length ? [{ ...prev.demand[0], vehicles_per_hour: Number(event.target.value) }, ...prev.demand.slice(1)] : [] })) }} />
              <div className="range-ends"><span>0</span><span>7,200 vehicles/hour</span></div>
              <div className="preset-row" role="group" aria-label="Demand presets">{(['Low', 'Medium', 'High'] as const).map((name) => <button type="button" key={name} className={`preset-chip ${demandPreset === name ? 'preset-active' : ''}`} disabled={isRunning} onClick={() => applyDemandPreset(name)}>{name}<small>{name === 'Low' ? '450' : name === 'Medium' ? '900' : '1,800'}</small></button>)}<span className={`preset-chip ${demandPreset === 'Custom' ? 'preset-active' : 'preset-custom'}`}>Custom</span></div>
            </section>

            <section className="config-section">
              <div className="config-section-title"><div><span className="eyebrow">02 · VEHICLES</span><h3>Vehicle mix</h3></div><span className="micro-label">ENGINE MODEL</span></div>
              <div className="vehicle-mix-row"><span className="mix-chip mix-active"><CarFront size={14} />Cars <b>modeled</b></span><span className="mix-chip mix-muted"><Bus size={14} />Bus <b>—</b></span><span className="mix-chip mix-muted"><Truck size={14} />Truck <b>—</b></span></div>
              <p className="control-note"><CircleHelp size={12} />Homogeneous agents in the current engine; bus and truck classes are not simulated.</p>
            </section>

            <section className="config-section road-config">
              <div className="config-section-title"><div><span className="eyebrow">03 · ROAD</span><h3>Road configuration</h3></div><span className="micro-label">ACTIVE LINK</span></div>
              <label className="sr-label" htmlFor="road-select">Select road to configure</label>
              <div className="select-shell road-select-shell"><select id="road-select" disabled={isRunning} value={selectedRoadId} onChange={(event) => setSelectedRoadId(event.target.value)}>{network.roads.map((road) => <option key={road.id} value={road.id}>{road.id}{road.kind === 'flyover' ? ' · flyover' : ''}</option>)}</select><ChevronDown size={13} /></div>
              {selectedRoad && <>
                <div className="control-title-row compact-control"><label htmlFor="lane-count">Lane count</label><span className="control-value">{selectedRoad.lane_count} <small>lanes</small></span></div>
                <input id="lane-count" className="styled-range" type="range" min="1" max="6" disabled={isRunning} value={selectedRoad.lane_count} onChange={(event) => updateNetwork((prev) => ({ ...prev, roads: prev.roads.map((road) => road.id === selectedRoad.id ? { ...road, lane_count: Number(event.target.value), capacity_vehicles_per_hour: Math.round(Number(event.target.value) * 1800) } : road) }))} />
                <div className="control-title-row compact-control"><label htmlFor="speed-limit">Speed limit</label><span className="control-value">{selectedRoad.speed_limit_kph} <small>km/h</small></span></div>
                <input id="speed-limit" className="styled-range" type="range" min="20" max="100" step="5" disabled={isRunning} value={selectedRoad.speed_limit_kph} onChange={(event) => updateNetwork((prev) => ({ ...prev, roads: prev.roads.map((road) => road.id === selectedRoad.id ? { ...road, speed_limit_kph: Number(event.target.value) } : road) }))} />
                <div className="capacity-line"><span>Road capacity</span><strong>{selectedRoad.capacity_vehicles_per_hour.toLocaleString()} <small>veh/hr</small></strong></div>
              </>}
            </section>

            <section className="config-section infrastructure-section">
              <div className="config-section-title"><div><span className="eyebrow">04 · SIGNAL CONTROL</span><h3>Traffic signals</h3></div><span className="mode-chip">FIXED-TIME</span></div>
              <label className="switch-row"><span className="switch-icon"><Lightbulb size={14} /></span><span className="switch-copy"><strong>Signals enabled</strong><small>Adaptive control unavailable</small></span><input type="checkbox" disabled={isRunning} checked={network.signals.some((signal) => signal.enabled)} onChange={(event) => updateNetwork((prev) => ({ ...prev, signals: prev.signals.map((signal) => ({ ...signal, enabled: event.target.checked })) }))} /><i className="switch-visual" /></label>
              {network.signals.map((signal) => { const greenIndex = signal.phases.findIndex((phase) => phase.green_movements.length > 0 && phase.state !== 'yellow' && phase.state !== 'red'); const greenPhase = signal.phases[greenIndex < 0 ? 0 : greenIndex]; return <div className="signal-timing" key={signal.id}><span className="signal-name">{signal.id} · {signal.phases.length} phases</span>
                <div className="phase-control"><label htmlFor={`green-duration-${signal.id}`}>Green phase</label><span>{greenPhase?.duration_seconds ?? 0}s</span><input id={`green-duration-${signal.id}`} className="styled-range" type="range" min="5" max="60" step="5" disabled={isRunning || !network.signals.find((item) => item.id === signal.id)?.enabled} value={greenPhase?.duration_seconds ?? 30} onChange={(event) => updateNetwork((prev) => ({ ...prev, signals: prev.signals.map((item) => item.id === signal.id ? { ...item, phases: item.phases.map((phase, index) => index === (greenIndex < 0 ? 0 : greenIndex) ? { ...phase, duration_seconds: Number(event.target.value) } : phase) } : item) }))} /></div>
                {(['yellow', 'red'] as const).map((state) => <div className="phase-control" key={state}><label htmlFor={`${state}-duration-${signal.id}`}>{state === 'yellow' ? 'Yellow phase' : 'Red phase'}</label><span>{phaseDuration(signal, state) === 0 ? 'off' : `${phaseDuration(signal, state)}s`}</span><input id={`${state}-duration-${signal.id}`} className="styled-range" type="range" min="0" max={state === 'yellow' ? 10 : 60} step="1" disabled={isRunning || !signal.enabled} value={phaseDuration(signal, state)} onChange={(event) => setSignalPhase(signal.id, state, Number(event.target.value))} /></div>)}
              </div> })}
            </section>

            <section className="config-section infrastructure-section">
              <div className="config-section-title"><div><span className="eyebrow">05 · INFRASTRUCTURE</span><h3>Network upgrades</h3></div></div>
              <label className="switch-row"><span className="switch-icon"><Layers3 size={14} /></span><span className="switch-copy"><strong>Flyover route</strong><small>Elevated west–east bypass</small></span><input type="checkbox" disabled={isRunning} checked={network.roads.some((road) => road.kind === 'flyover')} onChange={(event) => updateNetwork((prev) => {
                const enabled = event.target.checked
                const existing = prev.roads.find((road) => road.kind === 'flyover')
                if (!enabled) return { ...prev, roads: prev.roads.filter((road) => road.kind !== 'flyover') }
                const restored = existing ?? baseNetwork?.roads.find((road) => road.kind === 'flyover')
                return restored ? { ...prev, roads: [...prev.roads, restored] } : prev
              })} /><i className="switch-visual" /></label>
            </section>

            <section className="config-section seed-section"><div className="config-section-title"><div><span className="eyebrow">06 · RUN</span><h3>Simulation settings</h3></div><Sparkles size={13} /></div><label htmlFor="seed" className="small-label">Random seed</label><input id="seed" className="seed-input" type="number" min="0" max="2147483647" step="1" value={seed} disabled={isRunning} onChange={(event) => changeSeed(Number(event.target.value))} /><p className="control-note">Same seed and configuration reproduce the same arrivals.</p><div className="duration-control"><label htmlFor="run-duration">Run duration</label><strong>{Math.floor(durationSeconds / 60)} min</strong></div><input id="run-duration" className="styled-range" type="range" min="60" max="3600" step="60" disabled={isRunning} value={durationSeconds} onChange={(event) => changeDuration(Number(event.target.value))} /><div className="range-ends"><span>1 min</span><span>60 min</span></div></section>
          </div>
          <div className="apply-wrap"><button className="apply-button" onClick={applyScenario} disabled={busy || !network}><Check size={14} />{busy ? 'APPLYING…' : 'APPLY SCENARIO'}<ArrowRight size={15} /></button><span>{savedScenarioId ? `Saved · ${savedScenarioId}` : 'Validate and save these settings'}</span></div>
        </aside>

        <div className="center-stack">
          <section className="glass-panel network-panel" aria-label="Live simulation network">
            <div className="network-header"><div><div className="eyebrow-row"><span className="eyebrow">LIVE ROAD NETWORK</span><span className={`network-live-mark ${isRunning ? 'network-live-on' : ''}`}><i />{isRunning ? 'STREAMING' : 'STANDBY'}</span></div><h2>{network.name}</h2><p>{network.junctions.length} junctions <b>·</b> {network.roads.length} road links <b>·</b> {network.signals.filter((signal) => signal.enabled).length} active signals</p></div><div className="network-tools"><div className="network-clock"><span>SIMULATION TIME</span><strong>{clockLabel(simulation?.time_seconds ?? 0)}</strong><small>MM : SS</small></div><div className="heat-selector" role="group" aria-label="Network visualization mode">{(['Network', 'Congestion', 'Speed', 'Density'] as const).map((mode) => <button type="button" key={mode} className={heatMode === mode ? 'heat-mode-active' : ''} aria-pressed={heatMode === mode} onClick={() => setHeatMode(mode)}>{mode}</button>)}</div></div></div>
            <div className="map-canvas"><TrafficMap network={network} state={simulation} selectedRoadId={selectedRoadId} onSelectRoad={setSelectedRoadId} heatMode={heatMode} selectedVehicleId={inspectedVehicle?.id ?? null} onSelectVehicle={setInspectedVehicle} />{!simulation && <div className="map-empty"><span className="empty-dot" /><span>Run the model to release vehicle agents onto the network</span></div>}{currentInspection && <VehicleInspector vehicle={currentInspection} onClose={() => setInspectedVehicle(null)} />}</div>
            <div className="simulation-timeline"><div className="timeline-summary"><span>LIVE SIMULATION TIME <small>· historical playback unavailable</small></span><strong>{clockLabel(simulation?.time_seconds ?? 0)} <i>/</i> {clockLabel(simulation?.duration_seconds ?? durationSeconds)}</strong></div><div className="timeline-track" role="progressbar" aria-label="Elapsed simulation time" aria-valuemin={0} aria-valuemax={simulation?.duration_seconds ?? durationSeconds} aria-valuenow={simulation?.time_seconds ?? 0}><span style={{ width: `${Math.min(100, (simulation?.time_seconds ?? 0) / (simulation?.duration_seconds ?? durationSeconds) * 100)}%` }}><i /></span></div><div className="timeline-markers">{[0, 0.25, 0.5, 0.75, 1].map((fraction) => <span key={fraction}>{clockLabel(Math.round((simulation?.duration_seconds ?? durationSeconds) * fraction))}</span>)}</div></div>
            <div className="network-legend"><span className="legend-title">{heatMode.toUpperCase()}</span>{heatMode === 'Network' ? <><span><i className="legend-line heat-network-key" />ROAD LINKS</span><span><i className="legend-flyover" />FLYOVER</span></> : heatMode === 'Speed' ? <><span><i className="legend-line heat-fast-key" />≥75% LIMIT</span><span><i className="legend-line moderate-line" />40–74%</span><span><i className="legend-line heavy-line" />&lt;40%</span><span><i className="legend-line no-data-key" />NO DATA</span></> : heatMode === 'Density' ? <><span><i className="legend-line free-line" />LOW DENSITY</span><span><i className="legend-line moderate-line" />MODERATE</span><span><i className="legend-line heavy-line" />HIGH DENSITY</span></> : <><span><i className="legend-line free-line" />FREE FLOW</span><span><i className="legend-line moderate-line" />MODERATE</span><span><i className="legend-line heavy-line" />CONGESTED</span></>}<span><i className="legend-car" />VEHICLE AGENT</span><span><i className="legend-signal" />SIGNAL</span><span className="legend-spacer" /><span className="selected-link">Selected link <b>{selectedRoadId || '—'}</b></span></div>
          </section>

          <ComparisonDashboard comparison={comparison} onCompare={compare} busy={busy} />
          <EventStream events={events} />

          <section className="glass-panel analytics-panel" aria-label="Simulation analytics">
            <div className="analytics-header"><div><div className="eyebrow-row"><span className="eyebrow">RUN TELEMETRY</span><span className="history-count">{history.length} observed states</span></div><h2>Mobility analytics</h2></div><div className="chart-tabs" role="tablist" aria-label="Metric chart"><ChartTabButton tab="Overview" current={chartTab} onChoose={setChartTab} /><ChartTabButton tab="Speed" current={chartTab} onChoose={setChartTab} /><ChartTabButton tab="Delay" current={chartTab} onChoose={setChartTab} /><ChartTabButton tab="Throughput" current={chartTab} onChoose={setChartTab} /><ChartTabButton tab="Congestion" current={chartTab} onChoose={setChartTab} /></div></div>
            <AnalyticsChart tab={chartTab} history={history} />
          </section>
        </div>

        <aside className="glass-panel intelligence-panel" aria-label="Live intelligence">
          <div className="intel-heading"><div><div className="eyebrow-row"><Activity size={14} /><span className="eyebrow">LIVE INTELLIGENCE</span></div><h2>Network pulse</h2></div><span className="data-dot" title="Metrics update with simulation state" /></div>
          <div className="metric-grid">
            <MetricCard icon={<CarFront size={15} />} label="ACTIVE VEHICLES" value={simulation ? simulation.active_vehicles.toLocaleString() : '—'} unit="in network" accent="teal" />
            <MetricCard icon={<Gauge size={15} />} label="AVG SPEED" value={simulation ? format(metrics?.average_speed_kph) : '—'} unit="km/h" accent="blue" />
            <MetricCard icon={<Timer size={15} />} label="AVG DELAY" value={simulation ? format(metrics?.average_delay_seconds) : '—'} unit="sec vs free flow" accent="amber" />
            <MetricCard icon={<TrendingUp size={15} />} label="THROUGHPUT" value={simulation ? format(metrics?.throughput_vehicles_per_hour, 0) : '—'} unit="vehicles / hour" accent="violet" />
            <MetricCard icon={<TrafficCone size={15} />} label="QUEUE LENGTH" value={simulation ? (metrics?.queue_length ?? 0).toLocaleString() : '—'} unit="vehicles at stop lines" accent="orange" />
            <MetricCard icon={<Activity size={15} />} label="CONGESTION" value={simulation ? `${format((metrics?.congestion_index ?? 0) * 100, 0)}%` : '—'} unit="network storage" accent="red" />
          </div>

          <div className="health-block"><div className="subpanel-heading"><span>NETWORK HEALTH</span><span>{simulation ? `${format((1 - (metrics?.congestion_index ?? 0)) * 100, 0)}%` : 'NO DATA'}</span></div><div className="health-track"><span style={{ width: simulation ? `${Math.max(0, Math.min(100, (1 - (metrics?.congestion_index ?? 0)) * 100))}%` : '0%' }} /></div><p>{simulation ? 'Available lane-cell storage across the active network' : 'Run a scenario to calculate network health'}</p></div>

          <div className="bottleneck-block"><div className="subpanel-heading"><span>BOTTLENECKS</span><span className="live-count">TOP 3</span></div>{!simulation ? <div className="compact-empty">No congestion data until a run begins.</div> : bottlenecks.map(({ road, value, queue }, index) => <div className="bottleneck-row" key={road.id}><div className="bottleneck-title"><span className="bottleneck-rank">0{index + 1}</span><strong>{road.id}</strong><span>{Math.round(value * 100)}%</span></div><div className="bottleneck-track"><i className={value >= 0.75 ? 'bar-heavy' : value >= 0.4 ? 'bar-moderate' : 'bar-free'} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} /></div><small>{queue} queued · {road.lane_count} lanes</small></div>)}</div>

          <div className="signal-block"><div className="subpanel-heading"><span>TRAFFIC SIGNALS</span><span>{network.signals.filter((signal) => signal.enabled).length} ACTIVE</span></div>{network.signals.length ? network.signals.map((signal) => { const current = signals[signal.id]; const status = current?.state ?? (signal.enabled ? 'red' : 'off'); return <div className="signal-status-row" key={signal.id}><span className={`signal-state-chip state-${status}`}><i />{status}</span><span>{signal.id}</span><small>{current ? `${current.remaining_seconds}s` : signal.enabled ? 'ready' : 'disabled'}</small></div> }) : <div className="compact-empty">No signal controllers in this network.</div>}</div>

        </aside>
      </div>

      <footer className="app-footer"><div><span className="footer-mark">TF</span><strong>QUEST Lab Traffic Simulation</strong><span>Agent-based simulation for infrastructure and mobility scenario analysis</span></div><div className="footer-meta"><span>SEED <b>{seed}</b></span><span>MODEL <b>1 SEC / TICK</b></span><span className="footer-connection"><i className={`api-${apiStatus}`} />{apiStatus.toUpperCase()}</span></div></footer>
    </>}
  </main>
}

function ChartTabButton({ tab, current, onChoose }: { tab: ChartTab; current: ChartTab; onChoose: (tab: ChartTab) => void }) {
  return <button type="button" role="tab" aria-selected={current === tab} className={`chart-tab ${current === tab ? 'tab-active' : ''}`} onClick={() => onChoose(tab)}>{tab}</button>
}

function MetricCard({ icon, label, value, unit, accent }: { icon: React.ReactNode; label: string; value: string; unit: string; accent: string }) {
  return <div className={`metric-card accent-${accent}`}><div className="metric-card-top"><span className="metric-icon">{icon}</span><span>{label}</span></div><strong className="metric-value">{value}</strong><small>{unit}</small></div>
}
