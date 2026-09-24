"""Sinal de vida periódico: o app reinicia o worker se ficar 30 s sem receber."""

import threading

from transcriber_worker.events import Emit, heartbeat_event


class Heartbeat:
    def __init__(self, emit: Emit, interval: float = 5.0) -> None:
        self._emit = emit
        self._interval = interval
        self._stopped = threading.Event()
        self._thread = threading.Thread(target=self._run, name="heartbeat", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()
        self._thread.join(timeout=1)

    def _run(self) -> None:
        while not self._stopped.wait(self._interval):
            self._emit(heartbeat_event())
