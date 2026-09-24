"""Sessão ao vivo: blocos de áudio por faixa → recorte por pausa → transcrição em segundo plano.

A leitura dos blocos (linha de comando do worker) nunca espera o modelo: os trechos vão para uma
fila consumida por uma thread. Se a transcrição fica para trás, o atraso é informado (live_lag).
"""

import queue
import threading
from collections.abc import Callable
from typing import Protocol

import numpy as np
from numpy.typing import NDArray

from transcriber_worker.errors import ErrorCode, WorkerError, classify_exception
from transcriber_worker.events import (
    Emit,
    live_error_event,
    live_lag_event,
    live_listening_event,
    live_segment_event,
)
from transcriber_worker.live.segmenter import Chunk, LiveSegmenter, VadFn
from transcriber_worker.protocol import LiveStartParams

BLOCK = 1600  # 100 ms a 16 kHz: o tamanho dos blocos enviados pelo app
LAG_STEP_S = 1.0  # só avisa mudanças de pelo menos 1 s no atraso
# Falhas que o main resolve recarregando o modelo (na CPU): a sessão espera e tenta de novo.
_RELOADABLE = {ErrorCode.GPU_FAILED, ErrorCode.CUDA_FAILED, ErrorCode.CUDA_UNAVAILABLE}


class ArrayTranscriber(Protocol):
    def transcribe_array(
        self, audio: NDArray[np.float32], language: str | None
    ) -> list[tuple[float, float, str]]: ...


class LiveSession:
    def __init__(
        self,
        params: LiveStartParams,
        engine: ArrayTranscriber,
        emit: Emit,
        *,
        vad_factory: Callable[[], VadFn],
    ) -> None:
        self._id = params.session_id
        self._language = params.language
        self._engine = engine
        self._emit = emit
        self._segmenters: dict[str, LiveSegmenter] = {
            track: LiveSegmenter(track, params.pause_s, vad_factory()) for track in params.tracks
        }
        self._next_seq: dict[str, int] = dict.fromkeys(params.tracks, 0)
        self._listening: dict[str, bool] = dict.fromkeys(params.tracks, False)
        self._chunks: queue.Queue[Chunk | None] = queue.Queue()
        self._wake = threading.Event()  # acorda a espera: recarga do modelo ou parada
        self._reloaded = False
        self._stopping = False
        self._lock = threading.Lock()
        self._heard = 0.0
        self._done_until = 0.0
        self._busy = False
        self._lag_sent = 0.0
        self._segments = 0
        self._thread = threading.Thread(target=self._run, name="ao-vivo", daemon=True)
        self._thread.start()

    def audio(self, track: str, seq: int, pcm: NDArray[np.int16]) -> None:
        segmenter = self._segmenters.get(track)
        if segmenter is None:
            raise WorkerError(ErrorCode.INVALID_MESSAGE, f"Faixa fora da sessão: {track}")
        missing = seq - self._next_seq[track]
        if missing < 0:
            return  # repetido ou atrasado: a linha do tempo não volta
        self._next_seq[track] = seq + 1
        samples = pcm.astype(np.float32) / 32768.0
        if missing:  # bloco perdido: silêncio no lugar, para os tempos não encolherem
            samples = np.concatenate([np.zeros(missing * BLOCK, np.float32), samples])
        for chunk in segmenter.push(samples):
            self._enqueue(chunk)
        self._update_listening(track, segmenter.listening)
        with self._lock:
            self._heard = max(self._heard, segmenter.position)
        self._report_lag()

    def model_changed(self) -> None:
        """O main recarregou o modelo (ex.: queda da GPU para a CPU): retoma o trecho que falhou."""
        self._reloaded = True
        self._wake.set()

    def pause(self) -> None:
        """Pausa: a frase em andamento é fechada e transcrita; a linha do tempo não muda."""
        for track, segmenter in self._segmenters.items():
            for chunk in segmenter.flush():
                self._enqueue(chunk)
            self._update_listening(track, False)

    def stop(self) -> int:
        self.pause()
        self._stopping = True
        self._wake.set()
        self._chunks.put(None)
        self._thread.join()
        return self._segments

    def _enqueue(self, chunk: Chunk) -> None:
        with self._lock:
            self._busy = True
        self._chunks.put(chunk)

    def _update_listening(self, track: str, active: bool) -> None:
        if self._listening[track] != active:
            self._listening[track] = active
            self._emit(live_listening_event(self._id, track, active))

    def _run(self) -> None:
        while (chunk := self._chunks.get()) is not None:
            self._transcribe(chunk)
            with self._lock:
                self._done_until = max(self._done_until, chunk.end)
                self._busy = not self._chunks.empty()
            self._report_lag()

    def _transcribe(self, chunk: Chunk) -> None:
        retried = False
        while True:
            try:
                found = self._engine.transcribe_array(chunk.audio, self._language)
            except Exception as exc:
                error = classify_exception(exc)
                self._reloaded = False  # só vale uma recarga feita depois desta falha
                if not self._stopping:
                    self._wake.clear()
                self._emit(live_error_event(self._id, error.code))
                if retried or not self._wait_for_retry(error.code):
                    return
                retried = True
            else:
                self._publish(chunk, found)
                return

    def _wait_for_retry(self, code: ErrorCode) -> bool:
        """Falha de GPU: espera o main recarregar o modelo. Outras: tenta de novo na hora."""
        if code not in _RELOADABLE:
            return True
        self._wake.wait()
        return self._reloaded  # parada sem recarga: o modelo continua quebrado, desiste

    def _publish(self, chunk: Chunk, found: list[tuple[float, float, str]]) -> None:
        for start, end, raw in found:
            text = raw.strip()
            if text:
                self._segments += 1
                self._emit(
                    live_segment_event(
                        self._id, chunk.track, chunk.start + start, chunk.start + end, text
                    )
                )

    def _report_lag(self) -> None:
        with self._lock:
            lag = max(0.0, self._heard - self._done_until) if self._busy else 0.0
            if abs(lag - self._lag_sent) < LAG_STEP_S:
                return
            self._lag_sent = lag
        self._emit(live_lag_event(self._id, lag))
