from __future__ import annotations

import threading
import time
from collections.abc import Callable

from transcriber_worker.ai.pump import AiPump, Lane, Step, backoff_delay


def _wait_until(condition: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("condição não ocorreu a tempo")
        time.sleep(0.01)


def test_backoff_grows_and_is_capped() -> None:
    assert [backoff_delay(n) for n in (1, 2, 3, 4)] == [2.0, 4.0, 8.0, 16.0]
    assert backoff_delay(20) == 60.0


class Script:
    """Passo roteirizado: devolve os resultados em ordem e depois fica ocioso."""

    def __init__(self, outcomes: list[Step]) -> None:
        self._outcomes = outcomes
        self.calls = 0

    def __call__(self) -> Step:
        self.calls += 1
        return self._outcomes.pop(0) if self._outcomes else Step.IDLE


def test_lane_run_once_tracks_failures() -> None:
    waits: list[float] = []
    script = Script([Step.BACKOFF, Step.BACKOFF, Step.DONE, Step.IDLE])
    lane = Lane("analysis", script, wait=waits.append)
    for _ in range(4):
        lane.run_once()
    assert waits == [2.0, 4.0, lane.idle_seconds]


def test_lane_survives_exceptions_with_backoff() -> None:
    errors: list[str] = []
    waits: list[float] = []

    def broken() -> Step:
        raise RuntimeError("banco fechado")

    lane = Lane("index", broken, wait=waits.append, on_error=errors.append)
    lane.run_once()
    assert waits == [2.0]
    assert errors == ["[ia] index: banco fechado"]


def test_pump_threads_process_until_idle_and_wake_on_demand() -> None:
    script = Script([Step.DONE, Step.DONE])
    pump = AiPump([Lane("analysis", script, idle_seconds=30.0)])
    pump.start()
    _wait_until(lambda: script.calls >= 3)  # dois trabalhos e depois ocioso
    calls = script.calls
    pump.wake()
    _wait_until(lambda: script.calls > calls)
    pump.stop()
    assert pump.running is False


def test_stop_interrupts_a_long_wait() -> None:
    started = threading.Event()

    def idle() -> Step:
        started.set()
        return Step.IDLE

    pump = AiPump([Lane("index", idle, idle_seconds=60.0)])
    pump.start()
    assert started.wait(5.0)
    begin = time.monotonic()
    pump.stop()
    assert time.monotonic() - begin < 5.0


def test_stop_without_start_is_harmless() -> None:
    pump = AiPump([Lane("index", Script([]))])
    pump.stop()
    pump.wake()
    assert pump.running is False
