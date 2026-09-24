import threading
import time

from transcriber_worker.events import Event
from transcriber_worker.heartbeat import Heartbeat


def test_emits_periodically_until_stopped() -> None:
    events: list[Event] = []
    got_two = threading.Event()

    def emit(event: Event) -> None:
        events.append(event)
        if len(events) >= 2:
            got_two.set()

    heartbeat = Heartbeat(emit, interval=0.01)
    heartbeat.start()
    assert got_two.wait(timeout=2)
    heartbeat.stop()
    count = len(events)
    time.sleep(0.05)
    assert len(events) == count
    assert all(event == {"type": "heartbeat"} for event in events)


def test_stop_returns_quickly_even_with_long_interval() -> None:
    heartbeat = Heartbeat(lambda _: None, interval=60)
    heartbeat.start()
    started = time.monotonic()
    heartbeat.stop()
    assert time.monotonic() - started < 1
