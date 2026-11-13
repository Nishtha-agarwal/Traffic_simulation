from traffic_sim.sample import create_sample_network
from traffic_sim.sessions import SessionManager


def test_session_can_start_pause_resume_step_and_reset_deterministically():
    manager = SessionManager()
    scenario = create_sample_network()
    manager.save_scenario(scenario)
    session = manager.create(scenario.id, seed=17)

    assert manager.state(session.id)["status"] == "paused"
    manager.start(session.id)
    manager.pause(session.id)
    assert manager.state(session.id)["status"] == "paused"
    after_step = manager.step(session.id, 5)
    assert after_step["time_seconds"] == 5

    manager.resume(session.id)
    manager.pause(session.id)
    reset_session = manager.reset(session.id)
    first_reset_state = manager.state(session.id)
    assert reset_session.status == "paused"
    assert first_reset_state["time_seconds"] == 0
    assert manager.step(session.id, 5) == manager.step(
        manager.create(scenario.id, seed=17).id, 5
    )


def test_session_speed_change_and_metrics_are_exposed():
    manager = SessionManager()
    scenario = create_sample_network()
    manager.save_scenario(scenario)
    session = manager.create(scenario.id, seed=3)
    changed = manager.set_speed(session.id, 4.0)
    assert changed.speed_multiplier == 4.0
    manager.step(session.id, 10)
    metrics = manager.metrics(session.id)
    assert metrics["time_seconds"] == 10
    assert metrics["throughput_vehicles_per_hour"] >= 0


def test_missing_session_is_reported():
    manager = SessionManager()
    try:
        manager.state("missing")
    except KeyError as error:
        assert error.args == ("missing",)
    else:
        raise AssertionError("missing session did not raise KeyError")


def test_session_duration_caps_manual_steps_and_auto_pauses():
    manager = SessionManager()
    scenario = create_sample_network()
    manager.save_scenario(scenario)
    session = manager.create(scenario.id, seed=7, duration_seconds=60)
    state = manager.step(session.id, 120)
    assert state["time_seconds"] == 60
    assert manager.state(session.id)["status"] == "paused"
    assert manager.state(session.id)["duration_seconds"] == 60
