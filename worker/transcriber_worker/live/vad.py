"""Silero VAD em streaming: probabilidade de fala por janela de 32 ms, com estado entre blocos.

O `SileroVADModel` do faster-whisper zera o estado a cada chamada (pensado para arquivos). Aqui a
mesma sessão ONNX é usada janela a janela, guardando `h`, `c` e o contexto de 64 amostras.
"""

from typing import Any

import numpy as np
from numpy.typing import NDArray

from transcriber_worker.live.segmenter import WINDOW

CONTEXT = 64


class StreamingVad:
    def __init__(self, session: Any | None = None) -> None:
        if session is None:
            from faster_whisper.vad import get_vad_model

            session = get_vad_model().session
        self._session = session
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)
        self._context = np.zeros(CONTEXT, dtype=np.float32)
        self._pending = np.empty(0, dtype=np.float32)

    def feed(self, pcm: NDArray[np.float32]) -> list[float]:
        data = np.concatenate([self._pending, pcm.astype(np.float32, copy=False)])
        whole = len(data) // WINDOW * WINDOW
        self._pending = data[whole:]
        return [self._window(data[i : i + WINDOW]) for i in range(0, whole, WINDOW)]

    def _window(self, window: NDArray[np.float32]) -> float:
        batch = np.concatenate([self._context, window])[np.newaxis, :]
        out, self._h, self._c = self._session.run(
            None, {"input": batch, "h": self._h, "c": self._c}
        )
        self._context = window[-CONTEXT:]
        return float(np.asarray(out).reshape(-1)[0])
