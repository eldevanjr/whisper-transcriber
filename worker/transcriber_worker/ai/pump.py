"""Processamento em segundo plano das filas de IA (análise e indexação).

Cada :class:`Lane` é uma thread que repete um passo: trabalho feito segue na hora;
fila vazia dorme até ser acordada (:meth:`AiPump.wake`); falha (Ollama fora do ar,
resposta inválida) espera cada vez mais, até ``MAX_BACKOFF_SECONDS``. Assim o
Ollama lento só aumenta a fila e nenhum comando espera por ele (plano §2, §5, §15).
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Sequence
from enum import Enum

BASE_BACKOFF_SECONDS = 2.0
MAX_BACKOFF_SECONDS = 60.0
IDLE_SECONDS = 30.0


class Step(Enum):
    """Resultado de um passo da fila."""

    DONE = "done"  # processou algo: segue sem esperar
    IDLE = "idle"  # nada a fazer: dorme até ser acordada
    BACKOFF = "backoff"  # falhou: espera antes de tentar de novo


def backoff_delay(failures: int) -> float:
    return float(min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** (failures - 1)))


class Lane:
    """Uma thread de processamento repetindo ``step``."""

    def __init__(
        self,
        name: str,
        step: Callable[[], Step],
        *,
        idle_seconds: float = IDLE_SECONDS,
        wait: Callable[[float], object] | None = None,
        on_error: Callable[[str], object] | None = None,
    ) -> None:
        self.name = name
        self.idle_seconds = idle_seconds
        self._step = step
        self._failures = 0
        self._event = threading.Event()
        self._stopped = threading.Event()
        self._wait = wait or self._interruptible_wait
        self._on_error = on_error or (lambda _message: None)

    def _interruptible_wait(self, seconds: float) -> None:
        self._event.wait(seconds)
        self._event.clear()

    def run_once(self) -> None:
        try:
            outcome = self._step()
        except Exception as exc:
            # O passo nunca derruba a thread: loga (sem conteúdo) e tenta de novo depois.
            self._on_error(f"[ia] {self.name}: {exc}")
            outcome = Step.BACKOFF
        if outcome is Step.DONE:
            self._failures = 0
            return
        if outcome is Step.BACKOFF:
            self._failures += 1
            self._wait(backoff_delay(self._failures))
            return
        self._failures = 0
        self._wait(self.idle_seconds)

    def run(self) -> None:
        while not self._stopped.is_set():
            self.run_once()

    def wake(self) -> None:
        self._event.set()

    def stop(self) -> None:
        self._stopped.set()
        self._event.set()


class AiPump:
    """Conjunto de lanes com início/parada e despertar coletivos."""

    def __init__(self, lanes: Sequence[Lane]) -> None:
        self._lanes = list(lanes)
        self._threads: list[threading.Thread] = []

    @property
    def running(self) -> bool:
        return any(thread.is_alive() for thread in self._threads)

    def start(self) -> None:
        self._threads = [
            threading.Thread(target=lane.run, name=f"ai-{lane.name}", daemon=True)
            for lane in self._lanes
        ]
        for thread in self._threads:
            thread.start()

    def wake(self) -> None:
        for lane in self._lanes:
            lane.wake()

    def stop(self, timeout: float = 5.0) -> bool:
        """Sinaliza a parada e espera as lanes; devolve True se todas terminaram."""
        for lane in self._lanes:
            lane.stop()
        return self.wait(timeout)

    def wait(self, timeout: float | None = None) -> bool:
        """Espera as threads terminarem; devolve True se nenhuma continuar viva."""
        for thread in list(self._threads):
            thread.join(timeout)
        self._threads = [thread for thread in self._threads if thread.is_alive()]
        return not self._threads
