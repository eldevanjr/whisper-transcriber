"""Recorte por pausa: junta a fala de uma faixa até um silêncio longo o bastante (ou 25 s).

Frases inteiras: nada é enviado ao modelo palavra a palavra. O VAD diz, por janela de 32 ms, se
há fala; o trecho fecha quando o silêncio passa de `pause_s`. Fala contínua é cortada no ponto
mais silencioso dos últimos 5 s antes de 25 s (o Whisper trabalha em janelas de 30 s).
"""

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

RATE = 16000
WINDOW = 512  # 32 ms: a janela do Silero a 16 kHz
PAD_WINDOWS = 2  # margem antes e depois da fala (o VAD reage com um pequeno atraso)
PAUSE_RANGE = (0.5, 3.0)
CUT_SEARCH_S = 5.0

VadFn = Callable[[NDArray[np.float32]], list[float]]


@dataclass
class Chunk:
    track: str
    start: float
    end: float
    audio: NDArray[np.float32]


class LiveSegmenter:
    def __init__(
        self,
        track: str,
        pause_s: float,
        vad: VadFn,
        *,
        max_s: float = 25.0,
        threshold: float = 0.5,
    ) -> None:
        if not PAUSE_RANGE[0] <= pause_s <= PAUSE_RANGE[1]:
            raise ValueError(f"pausa fora de {PAUSE_RANGE}: {pause_s}")
        self._track = track
        self._pause = round(pause_s * RATE / WINDOW)
        self._max = int(max_s * RATE)
        self._vad = vad
        self._threshold = threshold
        self._pending = np.empty(0, dtype=np.float32)
        self._pos = 0  # amostras já consumidas em janelas (linha do tempo da faixa)
        self._history: deque[NDArray[np.float32]] = deque(maxlen=PAD_WINDOWS)
        self._buffer: list[NDArray[np.float32]] = []
        self._start: int | None = None
        self._last_speech = 0
        self._silence = 0

    @property
    def listening(self) -> bool:
        return self._start is not None

    def push(self, pcm: NDArray[np.float32]) -> list[Chunk]:
        data = np.concatenate([self._pending, pcm.astype(np.float32, copy=False)])
        whole = len(data) // WINDOW * WINDOW
        self._pending = data[whole:]
        if whole == 0:
            return []
        frames = data[:whole]
        chunks: list[Chunk] = []
        for index, prob in enumerate(self._vad(frames)):
            chunk = self._step(frames[index * WINDOW : (index + 1) * WINDOW], prob)
            if chunk is not None:
                chunks.append(chunk)
        return chunks

    def flush(self) -> list[Chunk]:
        if self._start is None:
            return []
        end = min(self._last_speech + PAD_WINDOWS * WINDOW, self._pos)
        return [self._close(self._start, end)]

    def _step(self, window: NDArray[np.float32], prob: float) -> Chunk | None:
        index = self._pos
        self._pos += WINDOW
        speech = prob >= self._threshold
        start = self._start
        if start is None:
            if speech:
                self._open(index, window)
            else:
                self._history.append(window)
            return None
        self._buffer.append(window)
        if speech:
            self._last_speech, self._silence = self._pos, 0
        else:
            self._silence += 1
        if self._silence >= self._pause:
            return self._close(start, self._last_speech + PAD_WINDOWS * WINDOW)
        if self._pos - start >= self._max:
            return self._cut(start)
        return None

    def _open(self, index: int, window: NDArray[np.float32]) -> None:
        self._buffer = [*self._history, window]
        self._start = index - len(self._history) * WINDOW
        self._last_speech, self._silence = self._pos, 0

    def _chunk(self, start: int, end: int, audio: NDArray[np.float32]) -> Chunk:
        return Chunk(self._track, start / RATE, end / RATE, audio)

    def _close(self, start: int, end: int) -> Chunk:
        audio = np.concatenate(self._buffer)[: end - start]
        chunk = self._chunk(start, end, audio)
        self._history = deque(self._buffer[-PAD_WINDOWS:], maxlen=PAD_WINDOWS)
        self._buffer, self._start = [], None
        return chunk

    def _cut(self, start: int) -> Chunk:
        """Fala contínua: corta na janela de menor energia dos últimos 5 s."""
        search = int(CUT_SEARCH_S * RATE / WINDOW)
        first = len(self._buffer) - search
        energies = [float(np.mean(w**2)) for w in self._buffer[first:]]
        cut = first + int(np.argmin(energies))
        cut_at = start + cut * WINDOW
        chunk = self._chunk(start, cut_at, np.concatenate(self._buffer[:cut]))
        self._buffer, self._start = self._buffer[cut:], cut_at
        return chunk
