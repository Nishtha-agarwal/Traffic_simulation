# QUEST Traffic Simulation

A lightweight, deterministic, agent-based road traffic simulation prototype for the QUEST Lab application.

## Current scope

- Typed road network with directed roads, lane counts, capacity, junctions, traffic signals, demand, and flyover roads.
- FastAPI scenario validation and storage, in-memory simulation sessions, real-time controls, state and metric endpoints, and seeded scenario comparison.
- Discrete-time cell-based movement with shortest free-flow-time routing, signal permissions, lane occupancy, road departure capacity, and queue/congestion metrics.
- Responsive React dashboard with an SVG network view, road controls, moving vehicle agents, traffic-light states, live metrics, and baseline/flyover comparison.

The engine is intended for qualitative scenario exploration. It is not calibrated for operational traffic engineering.

## Run locally

Backend, from the repository root:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
uvicorn traffic_sim.api:app --reload --app-dir src
```

Frontend, in another terminal:

```powershell
cd frontend
npm install
npm run dev
```

The dashboard is at `http://localhost:5173`; the API is at `http://localhost:8000`. Use `python -m pytest` from the repository root for backend checks and `npm run build` in `frontend/` for the frontend build.

## API overview

- `GET /api/networks/sample`
- `POST /api/scenarios/validate`, `POST /api/scenarios`, `GET /api/scenarios/{scenario_id}`
- `POST /api/simulations`, then `POST /api/simulations/{session_id}/start`, `/pause`, `/resume`, `/step`, `/reset`, or `/speed`
- `GET /api/simulations/{session_id}` and `GET /api/simulations/{session_id}/metrics`
- `POST /api/scenarios/compare` with two network configurations, a shared seed, and run duration

Scenarios and sessions live in process memory and are lost when the backend restarts. Signal phase movements use `incoming-road-id>outgoing-road-id`. Metrics are defined in [docs/metrics.md](docs/metrics.md).
