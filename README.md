# 🚦 QUEST Traffic Simulation

An interactive **agent-based traffic simulation** built for the **QUEST Lab Full Stack AI Pre-doctoral Application**.

The application models traffic flow across a configurable road network containing roads, junctions, flyovers, varying road widths, and different traffic capacities. Users can configure simulation scenarios, run the simulation, and visualize traffic behavior and performance through a web interface.

---

## ✨ Features

### 🛣️ Road Network Simulation
- Configurable road networks
- Multiple roads with different widths and capacities
- Junctions and intersections
- Flyover/alternative routes
- Vehicle movement across connected road segments

### 🚗 Agent-Based Traffic Model
Each vehicle is modeled as an independent agent with properties such as:
- Origin and destination
- Current road segment
- Speed
- Route
- Travel progress
- Waiting/delay time

Vehicles interact with the road network and other traffic conditions to produce realistic simulation behavior.

### 🎛️ Scenario Configuration
Users can configure simulation parameters such as:
- Number of vehicles
- Simulation duration
- Traffic density
- Road capacity
- Vehicle speed
- Junction configuration
- Flyover availability

### 📊 Simulation Analytics

The application provides simulation results including:
- Total vehicles
- Average travel time
- Average speed
- Waiting time
- Completed trips
- Traffic throughput
- Congestion indicators

### 🖥️ Interactive Web Interface
The frontend provides:
- Simulation configuration controls
- Network visualization
- Simulation controls
- Real-time/result-based statistics
- Traffic performance indicators
- Visual representation of traffic conditions

---

## 🏗️ Project Architecture

```text
QUEST_Traffic_Simulation/
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── style.css
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
│
├── src/
│   └── traffic_sim/
│       ├── __init__.py
│       ├── api.py
│       ├── models.py
│       ├── network.py
│       ├── sample.py
│       ├── simulation.py
│       └── sessions.py
│
├── tests/
│   ├── test_api.py
│   ├── test_network.py
│   ├── test_simulation.py
│   └── test_sessions.py
│
├── docs/
├── pyproject.toml
├── .gitignore
└── README.md
```

---

## ⚙️ Technology Stack

### Backend
- Python
- FastAPI
- Pydantic
- Agent-based simulation
- Network modeling

### Frontend
- React
- TypeScript
- Vite
- CSS

### Testing
- Pytest

### Development
- Git
- GitHub
- Python virtual environment
- npm

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/Nishtha-agarwal/Traffic_simulation.git
cd Traffic_simulation
```

---

## 🐍 Backend Setup

Create a virtual environment:

### Windows

```powershell
python -m venv .venv
```

Activate it:

```powershell
.venv\Scripts\Activate.ps1
```

Install the project:

```powershell
python -m pip install -e ".[dev]"
```

---

## ▶️ Run the Backend

Start the API server with:

```powershell
uvicorn traffic_sim.api:app --reload
```

The backend will normally be available at:

```text
http://127.0.0.1:8000
```

---

## 🌐 Frontend Setup

Open another terminal and navigate to the frontend:

```powershell
cd frontend
```

Install dependencies:

```powershell
npm install
```

Start the development server:

```powershell
npm run dev
```

The frontend will normally be available at:

```text
http://localhost:5173
```

---

## 🧪 Running Tests

From the project root:

```powershell
python -m pytest -q
```

The test suite covers important components including:

- Traffic network construction
- Simulation behavior
- API functionality
- Simulation sessions

---

## 🔄 How the Simulation Works

The simulation follows the following workflow:

```text
User Configures Scenario
          │
          ▼
   Build Road Network
          │
          ▼
   Generate Vehicles
          │
          ▼
   Assign Routes
          │
          ▼
  Run Agent-Based Model
          │
          ▼
 Track Vehicle Movement
          │
          ▼
 Calculate Metrics
          │
          ▼
 Display Results
```

Each simulation run produces measurable traffic outcomes that can be used to compare different scenarios.

---

## 📈 Example Scenarios

The application can be used to study scenarios such as:

### Normal Traffic

A baseline scenario with moderate traffic volume.

### Heavy Traffic

Increase the number of vehicles to observe congestion and increased travel time.

### Reduced Road Capacity

Reduce the capacity of selected roads to analyze bottlenecks.

### Flyover Scenario

Compare traffic behavior with and without an alternative flyover route.

### Junction Congestion

Increase traffic approaching a junction and observe queue formation and delays.

---

## 📊 Key Performance Indicators

The simulation can be evaluated using metrics such as:

| Metric | Description |
|---|---|
| Total Vehicles | Number of vehicles participating in the simulation |
| Completed Trips | Vehicles that successfully reached their destination |
| Average Speed | Average vehicle speed |
| Average Travel Time | Average time required to complete a trip |
| Waiting Time | Time vehicles spend waiting due to congestion |
| Throughput | Number of completed vehicles over time |
| Congestion | Measure of traffic load relative to road capacity |

---

## 🧪 Testing

Tests are organized under the `tests/` directory.

Run:

```powershell
python -m pytest -q
```

For more detailed output:

```powershell
python -m pytest -v
```

---

## 🎯 Project Objective

The goal of this project is to provide an interactive platform for experimenting with **agent-based traffic models** and understanding how road-network characteristics and traffic demand affect transportation performance.

The application allows users to change simulation conditions and observe how those changes influence:

- Traffic congestion
- Vehicle travel time
- Average speed
- Road utilization
- Junction delays
- Overall network throughput

---

## 🔮 Future Improvements

Potential extensions include:

- Real-time vehicle animation
- Larger road networks
- Advanced route optimization
- Traffic signal timing
- Dynamic traffic demand
- Multiple vehicle types
- Incident and road-block simulation
- Historical simulation comparison
- Exportable simulation reports
- Interactive network editing
- More advanced congestion models

---

## 📁 Development Notes

Generated Python packaging files such as `*.egg-info/`, virtual environments, Node modules, and build artifacts should not be committed to the repository.

The project uses a `.gitignore` file to keep generated and environment-specific files out of version control.

---

## 👩‍💻 Author

**Nishtha Agarwal**

GitHub:  
https://github.com/Nishtha-agarwal

---

## 📄 License

This project was developed as part of the **QUEST Lab Full Stack AI Pre-doctoral Application** and is intended for academic and evaluation purposes.
